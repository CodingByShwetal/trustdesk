import type { InferSelectModel } from 'drizzle-orm';
import type { customers, orders, tickets, drafts, toolActions, agentRuns } from '../db/schema.js';

// API responses use snake_case, matching the starter pack's API contract.

export const customerDto = (c: InferSelectModel<typeof customers>) => ({
  customer_id: c.customerId,
  name: c.name,
  email: c.email,
  tier: c.tier,
  country: c.country,
  created_at: c.createdAt,
  verified: c.verified,
  tags: c.tags,
});

export const orderDto = (o: InferSelectModel<typeof orders>) => ({
  order_id: o.orderId,
  customer_id: o.customerId,
  status: o.status,
  placed_at: o.placedAt,
  delivered_at: o.deliveredAt,
  eligible_return_until: o.eligibleReturnUntil,
  total: o.total,
  currency: o.currency,
  payment_status: o.paymentStatus,
  tracking_number: o.trackingNumber,
  items: o.items,
});

export const ticketDto = (t: InferSelectModel<typeof tickets>) => ({
  ticket_id: t.ticketId,
  customer_id: t.customerId,
  order_id: t.orderId,
  channel: t.channel,
  subject: t.subject,
  body: t.body,
  created_at: t.createdAt.toISOString(),
  status: t.status,
  triage: t.triage ?? null,
  triaged_at: t.triagedAt?.toISOString() ?? null,
});

export const draftDto = (d: InferSelectModel<typeof drafts>) => ({
  draft_id: d.draftId,
  ticket_id: d.ticketId,
  run_id: d.runId,
  status: d.status,
  body: d.body,
  citations: d.citations,
  created_at: d.createdAt.toISOString(),
});

export const toolActionDto = (a: InferSelectModel<typeof toolActions>) => ({
  action_id: a.actionId,
  ticket_id: a.ticketId,
  run_id: a.runId,
  tool_name: a.toolName,
  payload: a.payload,
  risk_level: a.riskLevel,
  requires_human_approval: a.requiresHumanApproval,
  status: a.status,
  idempotency_key: a.idempotencyKey,
  requested_by: a.requestedBy,
  result: a.result ?? null,
  error: a.error ?? null,
  created_at: a.createdAt.toISOString(),
  updated_at: a.updatedAt.toISOString(),
});

export const runSummaryDto = (r: InferSelectModel<typeof agentRuns>) => ({
  run_id: r.runId,
  run_type: r.runType,
  status: r.status,
  created_at: r.createdAt.toISOString(),
});
