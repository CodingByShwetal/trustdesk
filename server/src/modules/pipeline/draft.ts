import type { DB } from '../../db/client.js';
import { drafts, tickets } from '../../db/schema.js';
import { eq } from 'drizzle-orm';
import { newId } from '../../lib/ids.js';
import type { LLMProvider } from '../ai/types.js';
import { buildDraftPrompt, PROMPT_VERSION, type DraftPromptInput } from '../ai/prompts.js';
import { DraftOutput } from '../ai/schemas.js';
import { generateStructured } from '../ai/structured.js';
import { fallbackDraft, validateDraft, type Violation } from '../guardrails/output.js';
import { CATEGORY_ANCHOR_DOCS, retrieveForTicket, SECURITY_PLAYBOOK_DOC, type TicketCategory } from '../knowledge/search.js';
import { loadCatalog } from '../tools/catalog.js';
import { gateActions, type BlockedAction, type RecommendedAction } from '../tools/gate.js';
import { RunRecorder } from '../traces/recorder.js';
import { loadTicketContext } from './context.js';
import { runTriage } from './triage.js';

export type DraftRunResult = {
  draft_id: string;
  ticket_id: string;
  status: 'generated';
  body: string;
  citations: string[];
  should_escalate: boolean;
  escalation_reason: string | null;
  recommended_actions: RecommendedAction[];
  blocked_actions: BlockedAction[];
  guardrail_outcome: 'passed' | 'repaired' | 'fallback';
  guardrail_flags: string[];
  violations: Violation[];
  triage: { category: string; priority: string; should_escalate: boolean; run_id: string };
  run_id: string;
};

export async function runDraft(
  db: DB,
  llm: LLMProvider,
  ticketId: string,
  opts: { freshTriage?: boolean } = {},
): Promise<DraftRunResult> {
  const c = await loadTicketContext(db, ticketId);
  const triage = (!opts.freshTriage && c.ticket.triage) || (await runTriage(db, llm, ticketId, c));
  const category = triage.category as TicketCategory;
  const run = await RunRecorder.start(db, ticketId, 'draft_reply', PROMPT_VERSION);

  try {
    run.note('triage', { category, priority: triage.priority, should_escalate: triage.should_escalate, run_id: triage.run_id });
    run.guardrail({ stage: 'input', result: c.flags.length ? 'flagged' : 'passed', rules: [...new Set(c.flags.map((f) => f.rule))], detail: c.flags });

    // ---- Retrieval ----------------------------------------------------------
    const ctx = await run.step(
      'retrieval',
      () => retrieveForTicket(db, { subject: c.ticket.subject, body: c.ticket.body, category, guardrailFlagged: c.flags.length > 0 }),
      (r) => ({ query: r.query, chunks: r.chunks.map((x) => ({ chunk_id: x.chunk_id, reason: x.reason, score: x.score })) }),
    );
    run.retrievedDocIds = ctx.retrievedDocIds;
    run.guardrail({
      stage: 'retrieval',
      result: ctx.droppedQuarantined.length ? 'blocked' : 'passed',
      rules: ctx.droppedQuarantined.length ? ['quarantined_document_dropped'] : [],
      detail: ctx.droppedQuarantined,
    });

    const requiredDocIds = [
      ...CATEGORY_ANCHOR_DOCS[category],
      ...(c.flags.length ? [SECURITY_PLAYBOOK_DOC] : []),
    ].filter((d) => ctx.retrievedDocIds.includes(d));

    // ---- Prompt -------------------------------------------------------------
    const catalog = await loadCatalog(db);
    const tools = [...catalog.values()]
      .filter((t) => t.allowedCategories.includes(category))
      .map((t) => ({ tool_name: t.toolName, description: t.description, requires_human_approval: t.requiresHumanApproval }));
    const input: DraftPromptInput = {
      ticket: { subject: c.ticket.subject, body: c.ticket.body, channel: c.ticket.channel },
      customer: { first_name: c.firstName, tier: c.customer.tier, verified: c.customer.verified },
      triage: { category, priority: triage.priority, should_escalate: triage.should_escalate, reason_summary: triage.reason_summary },
      facts: c.facts.summary.map((s) => s.text),
      guardrail_flags: c.flags,
      signals: c.facts.signals,
      policy_chunks: ctx.chunks.map((x) => ({ doc_id: x.doc_id, heading: x.heading, content: x.content })),
      tools,
    };
    const prompt = buildDraftPrompt(input);

    // ---- Generate → validate → (repair once) → fallback ---------------------
    const validate = (d: DraftOutput) =>
      validateDraft({ draft: d, allowedDocIds: ctx.retrievedDocIds, requiredDocIds, customerEmail: c.customer.email });

    const first = await run.step('llm_draft', () => generateStructured(llm, { purpose: 'draft', ...prompt, input }, DraftOutput), (r) => ({
      model: r.meta.model,
      attempts: r.meta.attempts,
      fallback: r.meta.fallback ?? null,
    }));
    run.modelCall(first.meta);
    let draft = first.data;
    let violations = validate(draft);
    let outcome: DraftRunResult['guardrail_outcome'] = 'passed';
    const allViolations = [...violations];

    if (violations.length && violations.every((v) => v.severity === 'repairable')) {
      run.guardrail({ stage: 'output', result: 'flagged', rules: violations.map((v) => v.rule), detail: violations });
      const feedback = `\n\nYOUR PREVIOUS DRAFT VIOLATED THESE RULES, FIX ALL OF THEM:\n${violations.map((v) => `- ${v.rule}: ${v.detail}`).join('\n')}\nAllowed citation ids: ${ctx.retrievedDocIds.join(', ')}. Required citations: ${requiredDocIds.join(', ') || 'none'}.`;
      const second = await run.step('llm_draft_repair', () =>
        generateStructured(llm, { purpose: 'draft', system: prompt.system, user: prompt.user + feedback, input }, DraftOutput),
      );
      run.modelCall(second.meta);
      draft = second.data;
      violations = validate(draft);
      allViolations.push(...violations);
      outcome = violations.length ? 'fallback' : 'repaired';
    } else if (violations.length) {
      outcome = 'fallback';
    }

    // Keep what the model asked for, so the gate can record what it blocked even if the draft is replaced.
    const modelProposals = draft.proposed_actions;
    if (outcome === 'fallback') {
      run.guardrail({ stage: 'output', result: 'blocked', rules: [...new Set(allViolations.map((v) => v.rule))], detail: allViolations });
      draft = fallbackDraft(c.firstName, requiredDocIds);
    } else {
      run.guardrail({ stage: 'output', result: outcome === 'repaired' ? 'repaired' : 'passed', rules: outcome === 'repaired' ? [...new Set(allViolations.map((v) => v.rule))] : [] });
    }

    // ---- Escalation & actions -----------------------------------------------
    const shouldEscalate =
      triage.should_escalate || draft.needs_escalation || draft.unsupported_claims.length > 0 || outcome === 'fallback';
    const escalationReason = shouldEscalate
      ? draft.escalation_reason ?? (triage.should_escalate ? triage.reason_summary : 'Draft flagged for human review')
      : null;

    const gated = gateActions({
      proposals: modelProposals.map((p) => ({ ...p, source: 'model' as const })),
      ticketId,
      category,
      shouldEscalate,
      facts: c.facts,
      flags: c.flags,
      order: c.order,
      customer: c.customer,
      catalog,
    });
    // A draft that failed validation may only lead to escalation; anything else it proposed is blocked.
    const recommended = outcome === 'fallback' ? gated.recommended.filter((a) => a.tool_name === 'escalate_to_human') : gated.recommended;
    const blocked: BlockedAction[] = [
      ...gated.blocked,
      ...(outcome === 'fallback'
        ? gated.recommended
            .filter((a) => a.tool_name !== 'escalate_to_human')
            .map((a) => ({ tool_name: a.tool_name, rule: 'draft_failed_validation', reason: 'Proposed by a draft that failed output validation', source: a.source }))
        : []),
    ];
    run.toolCalls = [
      ...recommended.map((a) => ({ type: 'recommended', ...a })),
      ...blocked.map((b) => ({ type: 'blocked', ...b })),
    ];
    run.guardrail({ stage: 'tools', result: blocked.length ? 'blocked' : 'passed', rules: blocked.map((b) => `${b.tool_name}:${b.rule}`), detail: blocked });

    // ---- Persist ------------------------------------------------------------
    const draftId = newId('draft');
    await db.insert(drafts).values({ draftId, ticketId, runId: run.runId, status: 'generated', body: draft.body, citations: draft.citations });
    await db.update(tickets).set({ status: shouldEscalate ? 'escalated' : 'draft_ready' }).where(eq(tickets.ticketId, ticketId));
    await run.finish(outcome === 'fallback' ? 'blocked' : shouldEscalate ? 'escalated' : 'completed');

    return {
      draft_id: draftId,
      ticket_id: ticketId,
      status: 'generated',
      body: draft.body,
      citations: draft.citations,
      should_escalate: shouldEscalate,
      escalation_reason: escalationReason,
      recommended_actions: recommended,
      blocked_actions: blocked,
      guardrail_outcome: outcome,
      guardrail_flags: [...new Set(c.flags.map((f) => f.rule))],
      violations: allViolations,
      triage: { category, priority: triage.priority, should_escalate: triage.should_escalate, run_id: triage.run_id },
      run_id: run.runId,
    };
  } catch (err) {
    await run.finish('failed', (err as Error).message);
    throw err;
  }
}
