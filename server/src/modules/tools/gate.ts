import type { InferSelectModel } from 'drizzle-orm';
import type { customers, orders } from '../../db/schema.js';
import { sha256, stableStringify } from '../../lib/ids.js';
import type { InjectionHit } from '../guardrails/injection.js';
import { POLICY } from '../policy/constants.js';
import type { PolicyFacts } from '../policy/facts.js';
import type { Tool } from './catalog.js';

export type Proposal = { tool_name: string; reason: string; amount_inr?: number; source: 'model' | 'policy' };

export type RecommendedAction = {
  tool_name: string;
  reason: string;
  risk_level: string;
  requires_human_approval: boolean;
  payload: Record<string, unknown>;
  source: 'model' | 'policy';
};

export type BlockedAction = { tool_name: string; rule: string; reason: string; doc_id?: string; source: 'model' | 'policy' };

type GateInput = {
  proposals: Proposal[];
  ticketId: string;
  category: string;
  shouldEscalate: boolean;
  facts: PolicyFacts;
  flags: InjectionHit[];
  order: InferSelectModel<typeof orders> | null;
  customer: InferSelectModel<typeof customers>;
  catalog: Map<string, Tool>;
};

type Block = { rule: string; reason: string; doc_id?: string };

const MONEY_OR_ACCOUNT_TOOLS = new Set(['create_replacement_order', 'start_refund_review', 'issue_coupon', 'lock_account']);

/** Business fields (not free-text reason) decide the default idempotency key. */
export function defaultIdempotencyKey(ticketId: string, tool: string, payload: Record<string, unknown>): string {
  const { reason: _r, idempotency_key: _k, ...business } = payload;
  return `${ticketId}:${tool}:${sha256(stableStringify(business)).slice(0, 12)}`;
}

function escalationQueue(input: GateInput): string {
  if (input.facts.signals.safety_issue.length) return 'product_safety';
  if (input.flags.length || input.category === 'account_security') return 'trust_and_safety';
  if (input.category === 'billing') return 'payments';
  return 'support_tier2';
}

/** Policy preconditions per tool. Returns a block, or null when allowed. */
function checkPreconditions(p: Proposal, input: GateInput): Block | null {
  const { facts, flags, category } = input;
  const nonReturnable = facts.non_returnable_items.length > 0;

  if (flags.length && p.tool_name !== 'escalate_to_human') {
    return {
      rule: 'manipulation_detected',
      reason: `Message contains manipulation patterns (${[...new Set(flags.map((f) => f.rule))].join(', ')}); only escalation is allowed`,
      doc_id: 'KB-SECURITY-001',
    };
  }
  if (facts.signals.safety_issue.length && MONEY_OR_ACCOUNT_TOOLS.has(p.tool_name)) {
    return { rule: 'safety_escalation_first', reason: 'Safety issue must be escalated to a specialist before any remedy', doc_id: 'KB-WARRANTY-001' };
  }

  switch (p.tool_name) {
    case 'create_replacement_order': {
      if (!input.order?.deliveredAt) return { rule: 'order_not_delivered', reason: 'No delivered order to replace', doc_id: 'KB-SHIPPING-001' };
      if (nonReturnable) return { rule: 'non_returnable_item', reason: 'Order contains non-returnable items', doc_id: 'KB-REFUND-001' };
      if (category === 'warranty') {
        if (!facts.warranty.some((w) => w.in_warranty)) return { rule: 'out_of_warranty', reason: 'No item is within warranty', doc_id: 'KB-WARRANTY-001' };
        return null;
      }
      if (!facts.return_window.open) return { rule: 'return_window_closed', reason: facts.return_window.reason, doc_id: 'KB-REFUND-001' };
      if (!facts.signals.damage_reported) return { rule: 'no_damage_reported', reason: 'Replacement requires a damaged or defective item', doc_id: 'KB-REFUND-001' };
      return null;
    }
    case 'start_refund_review': {
      if (!input.order) return { rule: 'no_order', reason: 'No order linked to the ticket', doc_id: 'KB-REFUND-001' };
      if (nonReturnable && category !== 'billing') {
        return { rule: 'non_returnable_item', reason: 'Software licences and final-sale items are not refundable', doc_id: 'KB-REFUND-001' };
      }
      if (category === 'billing') {
        if (!facts.signals.duplicate_charge_reported) return { rule: 'no_billing_issue', reason: 'No duplicate charge reported', doc_id: 'KB-BILLING-001' };
        return null;
      }
      if (!facts.return_window.open) return { rule: 'return_window_closed', reason: facts.return_window.reason, doc_id: 'KB-REFUND-001' };
      return null;
    }
    case 'issue_coupon': {
      if (p.amount_inr === undefined) return { rule: 'missing_amount', reason: 'Coupon amount is required', doc_id: 'KB-COUPON-001' };
      if (p.amount_inr > POLICY.couponMaxInr.value) {
        return { rule: 'coupon_over_limit', reason: `INR ${p.amount_inr} exceeds the INR ${POLICY.couponMaxInr.value} limit`, doc_id: 'KB-COUPON-001' };
      }
      return null;
    }
    case 'open_carrier_investigation':
      return facts.shipping.carrier_investigation_eligible
        ? null
        : { rule: 'tracking_not_stale', reason: `Needs ≥${POLICY.staleTrackingBusinessDays.value} business days without movement`, doc_id: 'KB-SHIPPING-001' };
    case 'lock_account':
      return { rule: 'ai_cannot_initiate_lock', reason: 'Account locks are high-risk and initiated only by humans or verified security automation', doc_id: 'KB-ACCOUNT-001' };
    case 'escalate_to_human':
      return null;
    default:
      return null;
  }
}

function buildPayload(p: Proposal, input: GateInput): Record<string, unknown> {
  const { order, customer } = input;
  const replaceable = order?.items.find((i) => !i.final_sale);
  switch (p.tool_name) {
    case 'create_replacement_order':
      return { order_id: order?.orderId, sku: replaceable?.sku, reason: p.reason };
    case 'start_refund_review':
      return { order_id: order?.orderId, amount: Math.min(p.amount_inr ?? order?.total ?? 0, order?.total ?? 0), reason: p.reason };
    case 'issue_coupon':
      return { customer_id: customer.customerId, amount: p.amount_inr, reason: p.reason };
    case 'open_carrier_investigation':
      return { order_id: order?.orderId, tracking_number: order?.trackingNumber, reason: p.reason };
    case 'escalate_to_human':
      return { ticket_id: input.ticketId, reason: p.reason, queue: escalationQueue(input) };
    case 'lock_account':
      return { customer_id: customer.customerId, reason: p.reason };
    default:
      return { reason: p.reason };
  }
}

/**
 * Filters proposed actions through the catalog and policy preconditions.
 * Payloads are built server-side from records, never from model text, so the
 * model cannot choose which order, SKU or customer an action targets.
 */
export function gateActions(input: GateInput): { recommended: RecommendedAction[]; blocked: BlockedAction[] } {
  const proposals = [...input.proposals];
  if (input.shouldEscalate && !proposals.some((p) => p.tool_name === 'escalate_to_human')) {
    proposals.push({ tool_name: 'escalate_to_human', reason: 'Ticket requires human review under policy', source: 'policy' });
  }

  const recommended: RecommendedAction[] = [];
  const blocked: BlockedAction[] = [];
  const seen = new Set<string>();

  for (const p of proposals) {
    if (seen.has(p.tool_name)) continue;
    seen.add(p.tool_name);

    const tool = input.catalog.get(p.tool_name);
    if (!tool) {
      blocked.push({ tool_name: p.tool_name, rule: 'unknown_tool', reason: 'Tool is not in the catalog', source: p.source });
      continue;
    }
    if (!tool.allowedCategories.includes(input.category)) {
      blocked.push({
        tool_name: p.tool_name,
        rule: 'category_not_allowed',
        reason: `Not allowed for category '${input.category}' (allowed: ${tool.allowedCategories.join(', ')})`,
        source: p.source,
      });
      continue;
    }
    const block = checkPreconditions(p, input);
    if (block) {
      blocked.push({ tool_name: p.tool_name, ...block, source: p.source });
      continue;
    }
    const payload = buildPayload(p, input);
    const missing = tool.requiredFields.filter((f) => f !== 'idempotency_key' && (payload[f] === undefined || payload[f] === null || payload[f] === ''));
    if (missing.length) {
      blocked.push({ tool_name: p.tool_name, rule: 'missing_required_fields', reason: `Cannot fill: ${missing.join(', ')}`, source: p.source });
      continue;
    }
    payload.idempotency_key = defaultIdempotencyKey(input.ticketId, p.tool_name, payload);
    recommended.push({
      tool_name: p.tool_name,
      reason: p.reason,
      risk_level: tool.riskLevel,
      requires_human_approval: tool.requiresHumanApproval,
      payload,
      source: p.source,
    });
  }
  return { recommended, blocked };
}
