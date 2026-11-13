import { eq } from 'drizzle-orm';
import type { DB } from '../../db/client.js';
import { tickets, type TriageResult } from '../../db/schema.js';
import type { LLMProvider } from '../ai/types.js';
import { buildTriagePrompt, PROMPT_VERSION } from '../ai/prompts.js';
import { TriageOutput } from '../ai/schemas.js';
import { generateStructured } from '../ai/structured.js';
import { applyTriageRules, type AppliedRule } from '../policy/rules.js';
import { RunRecorder } from '../traces/recorder.js';
import { loadTicketContext, type TicketContext } from './context.js';

export type TriageRunResult = {
  ticket_id: string;
  category: string;
  priority: string;
  sentiment: string;
  should_escalate: boolean;
  reason_summary: string;
  guardrail_flags: string[];
  policy_rules_applied: AppliedRule[];
  model_output: TriageOutput;
  run_id: string;
};

export async function runTriage(db: DB, llm: LLMProvider, ticketId: string, ctx?: TicketContext): Promise<TriageRunResult> {
  const c = ctx ?? (await loadTicketContext(db, ticketId));
  const run = await RunRecorder.start(db, ticketId, 'triage', PROMPT_VERSION);

  try {
    run.note('policy_facts', { reference_date: c.facts.reference_date, summary: c.facts.summary.map((s) => s.text) });
    run.guardrail({
      stage: 'input',
      result: c.flags.length ? 'flagged' : 'passed',
      rules: [...new Set(c.flags.map((f) => f.rule))],
      detail: c.flags,
    });

    const input = {
      ticket: { subject: c.ticket.subject, body: c.ticket.body, channel: c.ticket.channel },
      customer: { tier: c.customer.tier, verified: c.customer.verified },
      facts: c.facts.summary.map((s) => s.text),
      guardrail_flags: c.flags,
      signals: c.facts.signals,
    };
    const { system, user } = buildTriagePrompt(input);
    const { data: model, meta } = await run.step(
      'llm_triage',
      () => generateStructured(llm, { purpose: 'triage', system, user, input }, TriageOutput),
      (r) => ({ model: r.meta.model, attempts: r.meta.attempts, fallback: r.meta.fallback ?? null, output: r.data }),
    );
    run.modelCall(meta);

    const { triage, applied } = applyTriageRules(model, c.facts, c.flags);
    run.note('policy_rules', applied.length ? applied : 'no overrides');
    if (applied.length) run.guardrail({ stage: 'policy', result: 'repaired', rules: applied.map((a) => a.rule), detail: applied });

    const stored: TriageResult = {
      category: triage.category,
      priority: triage.priority,
      sentiment: triage.sentiment,
      should_escalate: triage.should_escalate,
      reason_summary: triage.reason_summary,
      run_id: run.runId,
    };
    await db
      .update(tickets)
      .set({ triage: stored, triagedAt: new Date(), status: triage.should_escalate ? 'escalated' : 'triaged' })
      .where(eq(tickets.ticketId, ticketId));

    await run.finish(triage.should_escalate ? 'escalated' : 'completed');
    return {
      ticket_id: ticketId,
      ...stored,
      guardrail_flags: [...new Set(c.flags.map((f) => f.rule))],
      policy_rules_applied: applied,
      model_output: model,
      run_id: run.runId,
    };
  } catch (err) {
    await run.finish('failed', (err as Error).message);
    throw err;
  }
}
