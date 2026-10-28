import { beforeAll, describe, expect, it } from 'vitest';
import { db, resetDb } from './helpers.js';
import { applyTriageRules } from '../src/modules/policy/rules.js';
import { validateDraft } from '../src/modules/guardrails/output.js';
import { CANARY_TOKEN } from '../src/modules/ai/prompts.js';
import type { DraftOutput, TriageOutput } from '../src/modules/ai/schemas.js';
import { loadTicketContext } from '../src/modules/pipeline/context.js';
import { loadCatalog } from '../src/modules/tools/catalog.js';
import { gateActions, type Proposal } from '../src/modules/tools/gate.js';

beforeAll(async () => {
  await resetDb();
});

const naive: TriageOutput = {
  category: 'general',
  priority: 'low',
  sentiment: 'neutral',
  should_escalate: false,
  reason_summary: 'x',
  injection_detected: false,
};

describe('applyTriageRules', () => {
  it('forces urgent + escalation for a safety issue (tkt_9004)', async () => {
    const c = await loadTicketContext(db, 'tkt_9004');
    const { triage, applied } = applyTriageRules({ ...naive, category: 'warranty' }, c.facts, c.flags);
    expect(triage).toMatchObject({ priority: 'urgent', should_escalate: true });
    expect(applied.map((a) => a.rule)).toEqual(['safety_issue_urgent', 'safety_issue_escalation']);
  });

  it('routes an unverified account change to account_security and escalates (tkt_9005)', async () => {
    const c = await loadTicketContext(db, 'tkt_9005');
    const { triage } = applyTriageRules(naive, c.facts, c.flags);
    expect(triage).toMatchObject({ category: 'account_security', priority: 'high', should_escalate: true });
  });

  it('escalates manipulation attempts but does not invent a category (tkt_9006)', async () => {
    const c = await loadTicketContext(db, 'tkt_9006');
    const { triage } = applyTriageRules({ ...naive, priority: 'medium' }, c.facts, c.flags);
    expect(triage).toMatchObject({ category: 'general', priority: 'medium', should_escalate: true });
  });

  it('raises duplicate charges to high (tkt_9008)', async () => {
    const c = await loadTicketContext(db, 'tkt_9008');
    expect(applyTriageRules({ ...naive, category: 'billing' }, c.facts, c.flags).triage.priority).toBe('high');
  });

  it('never lowers what the model decided', async () => {
    const c = await loadTicketContext(db, 'tkt_9001');
    const strict = { ...naive, category: 'refund' as const, priority: 'urgent' as const, should_escalate: true };
    expect(applyTriageRules(strict, c.facts, c.flags)).toEqual({ triage: strict, applied: [] });
  });
});

describe('validateDraft', () => {
  const clean: DraftOutput = {
    body: 'Hi Aisha,\n\nPlease send a photo of the damage and a team member will review a replacement.\n\nBest regards',
    citations: ['KB-REFUND-001'],
    proposed_actions: [],
    needs_escalation: false,
    escalation_reason: null,
    unsafe_instructions_detected: false,
    unsupported_claims: [],
  };
  const check = (d: Partial<DraftOutput>) =>
    validateDraft({
      draft: { ...clean, ...d },
      allowedDocIds: ['KB-REFUND-001', 'KB-WARRANTY-001'],
      requiredDocIds: ['KB-REFUND-001'],
      customerEmail: 'aisha.rao@example.com',
    }).map((v) => `${v.rule}/${v.severity}`);

  it('passes a grounded, safe draft', () => {
    expect(check({})).toEqual([]);
  });

  it('rejects citations outside the retrieved set and missing governing policy', () => {
    expect(check({ citations: ['KB-ADVERSARIAL-001'] })).toEqual([
      'invalid_citation/repairable',
      'missing_required_citation/repairable',
    ]);
  });

  it.each([
    ['Your refund has been processed.', 'forbidden_promise:refund_already_done'],
    ['You will get an instant refund.', 'forbidden_promise:instant_remedy'],
    ["We've issued your coupon.", 'forbidden_promise:action_already_taken'],
    ['I have changed your email.', 'forbidden_promise:account_changed'],
    ['See KB-REFUND-001 for details.', 'doc_id_in_reply'],
  ])('flags "%s" as repairable', (text, rule) => {
    expect(check({ body: text })).toContain(`${rule}/repairable`);
  });

  it.each([
    [`marker ${CANARY_TOKEN}`, 'system_prompt_leak'],
    ['My SECURITY RULES say no.', 'system_prompt_leak'],
    ['Key: AIzaSyA1234567890abcdefghijklmnop', 'secret_leak:google_api_key'],
    ['Use manager-demo-token to log in', 'secret_leak:demo_token'],
    ['Contact nisha.verma@example.com', 'pii_leak:email'],
    ['Card 4111 1111 1111 1111', 'pii_leak:card_number'],
  ])('treats "%s" as critical', (text, rule) => {
    expect(check({ body: text })).toContain(`${rule}/critical`);
  });

  it("allows the customer's own email address", () => {
    expect(check({ body: 'We will write to aisha.rao@example.com.' })).toEqual([]);
  });
});

describe('gateActions', () => {
  async function gate(ticketId: string, category: string, proposals: Array<Omit<Proposal, 'source'>>, shouldEscalate = false) {
    const c = await loadTicketContext(db, ticketId);
    return gateActions({
      proposals: proposals.map((p) => ({ ...p, source: 'model' as const })),
      ticketId,
      category,
      shouldEscalate,
      facts: c.facts,
      flags: c.flags,
      order: c.order,
      customer: c.customer,
      catalog: await loadCatalog(db),
    });
  }
  const blockedRules = (r: Awaited<ReturnType<typeof gate>>) => r.blocked.map((b) => `${b.tool_name}:${b.rule}`);

  it('recommends a replacement for damage inside the window, with a server-built payload (tkt_9001)', async () => {
    const r = await gate('tkt_9001', 'refund', [{ tool_name: 'create_replacement_order', reason: 'Damaged on arrival' }]);
    expect(r.blocked).toEqual([]);
    expect(r.recommended[0]).toMatchObject({
      tool_name: 'create_replacement_order',
      requires_human_approval: true,
      payload: { order_id: 'ord_5001', sku: 'BG-AIRPODS-01', reason: 'Damaged on arrival' },
    });
    expect(r.recommended[0].payload.idempotency_key).toMatch(/^tkt_9001:create_replacement_order:[0-9a-f]{12}$/);
  });

  it('derives the same idempotency key whatever reason the model writes', async () => {
    const a = await gate('tkt_9001', 'refund', [{ tool_name: 'create_replacement_order', reason: 'one' }]);
    const b = await gate('tkt_9001', 'refund', [{ tool_name: 'create_replacement_order', reason: 'two' }]);
    expect(a.recommended[0].payload.idempotency_key).toBe(b.recommended[0].payload.idempotency_key);
  });

  it('blocks refunds on final-sale items (tkt_9003)', async () => {
    const r = await gate('tkt_9003', 'refund', [{ tool_name: 'start_refund_review', reason: 'x' }]);
    expect(blockedRules(r)).toEqual(['start_refund_review:non_returnable_item']);
  });

  it('blocks remedies before a safety escalation and adds the escalation (tkt_9004)', async () => {
    const r = await gate('tkt_9004', 'warranty', [{ tool_name: 'create_replacement_order', reason: 'x' }], true);
    expect(blockedRules(r)).toEqual(['create_replacement_order:safety_escalation_first']);
    expect(r.recommended.map((a) => a.tool_name)).toEqual(['escalate_to_human']);
    expect(r.recommended[0].payload.queue).toBe('product_safety');
  });

  it('allows only escalation when manipulation is detected (tkt_9006)', async () => {
    const r = await gate('tkt_9006', 'general', [{ tool_name: 'issue_coupon', reason: 'x', amount_inr: 500 }], true);
    expect(blockedRules(r)).toEqual(['issue_coupon:manipulation_detected']);
    expect(r.recommended.map((a) => a.tool_name)).toEqual(['escalate_to_human']);
  });

  it('enforces coupon limits, catalog categories, AI-initiated locks and unknown tools', async () => {
    const r = await gate('tkt_9002', 'shipping', [
      { tool_name: 'issue_coupon', reason: 'x', amount_inr: 1500 },
      { tool_name: 'create_replacement_order', reason: 'x' },
      { tool_name: 'delete_everything', reason: 'x' },
    ]);
    expect(blockedRules(r)).toEqual([
      'issue_coupon:coupon_over_limit',
      'create_replacement_order:category_not_allowed',
      'delete_everything:unknown_tool',
    ]);
    const lock = await gate('tkt_9007', 'account_security', [{ tool_name: 'lock_account', reason: 'x' }]);
    expect(blockedRules(lock)).toEqual(['lock_account:manipulation_detected']);
  });

  it('caps refund-review amounts at the order total (tkt_9008)', async () => {
    const r = await gate('tkt_9008', 'billing', [{ tool_name: 'start_refund_review', reason: 'dup', amount_inr: 999999 }]);
    expect(r.recommended[0].payload).toMatchObject({ order_id: 'ord_5006', amount: 15999 });
  });
});
