import { and, desc, eq, type SQL } from 'drizzle-orm';
import type { DB } from '../../db/client.js';
import { agentRuns, approvals, customers, orders, tickets, toolActions } from '../../db/schema.js';
import { AppError, notFound } from '../../lib/errors.js';
import { newId, sha256, stableStringify } from '../../lib/ids.js';
import type { Role } from '../../api/auth.js';
import { POLICY } from '../policy/constants.js';
import { loadCatalog } from './catalog.js';
import { defaultExecutors, type ActionRow, type Executor } from './executors.js';
import { defaultIdempotencyKey } from './gate.js';

export type RequestActionInput = {
  ticketId: string;
  toolName: string;
  payload: Record<string, unknown>;
  requestedBy: string;
  runId?: string | null;
};

/**
 * Hash of the business payload, used to detect a key reused for a different request.
 * Like the derived key, it ignores the idempotency key and the free-text `reason`:
 * a re-worded reason (e.g. from a regenerated draft) is the same request.
 */
function payloadHash(payload: Record<string, unknown>): string {
  const { idempotency_key: _k, reason: _r, ...business } = payload;
  return sha256(stableStringify(business));
}

/**
 * Checks that payload fields refer to this ticket's own records, so an action
 * cannot be pointed at another customer's order or an invented amount.
 */
async function validateReferences(db: DB, ticket: typeof tickets.$inferSelect, toolName: string, payload: Record<string, unknown>) {
  const errors: Array<{ field: string; message: string }> = [];
  const [order] = ticket.orderId ? await db.select().from(orders).where(eq(orders.orderId, ticket.orderId)) : [];

  if ('order_id' in payload && payload.order_id !== ticket.orderId) {
    errors.push({ field: 'payload.order_id', message: `Must be the ticket's order (${ticket.orderId ?? 'none'})` });
  }
  if ('customer_id' in payload && payload.customer_id !== ticket.customerId) {
    errors.push({ field: 'payload.customer_id', message: `Must be the ticket's customer (${ticket.customerId})` });
  }
  if ('ticket_id' in payload && payload.ticket_id !== ticket.ticketId) {
    errors.push({ field: 'payload.ticket_id', message: `Must be ${ticket.ticketId}` });
  }
  if ('sku' in payload && order && !order.items.some((i) => i.sku === payload.sku)) {
    errors.push({ field: 'payload.sku', message: `SKU is not on order ${order.orderId}` });
  }
  if ('amount' in payload) {
    const amount = Number(payload.amount);
    if (!Number.isFinite(amount) || amount <= 0) errors.push({ field: 'payload.amount', message: 'Must be a positive number' });
    else if (toolName === 'issue_coupon' && amount > POLICY.couponMaxInr.value) {
      errors.push({ field: 'payload.amount', message: `Coupons are limited to INR ${POLICY.couponMaxInr.value} (KB-COUPON-001)` });
    } else if (toolName === 'start_refund_review' && order && amount > order.total) {
      errors.push({ field: 'payload.amount', message: `Cannot exceed the order total (${order.total})` });
    }
  }
  if ('customer_id' in payload) {
    const [c] = await db.select().from(customers).where(eq(customers.customerId, String(payload.customer_id)));
    if (!c) errors.push({ field: 'payload.customer_id', message: 'Unknown customer' });
  }
  return errors;
}

/**
 * Creates a tool action request. Same tool + idempotency key returns the
 * existing action; the same key with a different payload is a conflict.
 */
export async function requestAction(db: DB, input: RequestActionInput): Promise<{ action: ActionRow; replay: boolean }> {
  const [ticket] = await db.select().from(tickets).where(eq(tickets.ticketId, input.ticketId));
  if (!ticket) throw notFound('Ticket', input.ticketId);

  const catalog = await loadCatalog(db);
  const tool = catalog.get(input.toolName);
  if (!tool) throw new AppError('VALIDATION_ERROR', `Unknown tool '${input.toolName}'`, { available: [...catalog.keys()] });

  const category = ticket.triage?.category;
  if (!category) throw new AppError('VALIDATION_ERROR', 'Ticket must be triaged before requesting actions');
  if (!tool.allowedCategories.includes(category)) {
    throw new AppError('VALIDATION_ERROR', `'${tool.toolName}' is not allowed for category '${category}'`, { allowed: tool.allowedCategories });
  }

  const payload = { ...input.payload };
  if (!payload.idempotency_key) payload.idempotency_key = defaultIdempotencyKey(ticket.ticketId, tool.toolName, payload);
  const missing = tool.requiredFields.filter((f) => payload[f] === undefined || payload[f] === null || payload[f] === '');
  if (missing.length) {
    throw new AppError('VALIDATION_ERROR', 'Missing required payload fields', missing.map((f) => ({ field: `payload.${f}`, message: 'Required' })));
  }
  const refErrors = await validateReferences(db, ticket, tool.toolName, payload);
  if (refErrors.length) throw new AppError('VALIDATION_ERROR', 'Payload does not match the ticket', refErrors);

  if (input.runId) {
    const [run] = await db.select().from(agentRuns).where(eq(agentRuns.runId, input.runId));
    if (!run || run.ticketId !== ticket.ticketId) throw new AppError('VALIDATION_ERROR', `run_id ${input.runId} does not belong to ${ticket.ticketId}`);
  }

  const idempotencyKey = String(payload.idempotency_key);
  const hash = payloadHash(payload);
  const [created] = await db
    .insert(toolActions)
    .values({
      actionId: newId('act'),
      ticketId: ticket.ticketId,
      runId: input.runId ?? null,
      toolName: tool.toolName,
      payload,
      payloadHash: hash,
      riskLevel: tool.riskLevel,
      requiresHumanApproval: tool.requiresHumanApproval,
      status: tool.requiresHumanApproval ? 'approval_required' : 'requested',
      idempotencyKey,
      requestedBy: input.requestedBy,
    })
    .onConflictDoNothing({ target: [toolActions.toolName, toolActions.idempotencyKey] })
    .returning();
  if (created) return { action: created, replay: false };

  const [existing] = await db
    .select()
    .from(toolActions)
    .where(and(eq(toolActions.toolName, tool.toolName), eq(toolActions.idempotencyKey, idempotencyKey)));
  if (existing.ticketId !== ticket.ticketId || existing.payloadHash !== hash) {
    throw new AppError('CONFLICT', `Idempotency key '${idempotencyKey}' was already used with a different request`, {
      existing_action_id: existing.actionId,
    });
  }
  return { action: existing, replay: true };
}

export async function decideAction(
  db: DB,
  input: { actionId: string; reviewerId: string; decision: 'approved' | 'rejected'; reason: string },
): Promise<{ action: ActionRow; replay: boolean }> {
  return db.transaction(async (tx) => {
    const [a] = await tx.select().from(toolActions).where(eq(toolActions.actionId, input.actionId)).for('update');
    if (!a) throw notFound('Tool action', input.actionId);
    if (!a.requiresHumanApproval) {
      throw new AppError('VALIDATION_ERROR', `'${a.toolName}' is low-risk and does not need approval; execute it directly`);
    }
    // Repeating the decision already recorded is a no-op; changing it is not allowed.
    if (a.status === input.decision) return { action: a, replay: true };
    if (a.status !== 'approval_required') {
      throw new AppError('CONFLICT', `Action is '${a.status}'; only 'approval_required' actions can be decided`);
    }
    await tx.insert(approvals).values({
      approvalId: newId('apr'),
      actionId: a.actionId,
      reviewerId: input.reviewerId,
      decision: input.decision,
      reason: input.reason,
    });
    const [updated] = await tx
      .update(toolActions)
      .set({ status: input.decision, updatedAt: new Date() })
      .where(eq(toolActions.actionId, a.actionId))
      .returning();
    return { action: updated, replay: false };
  });
}

/**
 * Executes an action at most once. The row lock serialises concurrent calls;
 * a repeat returns the stored result. A failing executor rolls back its own
 * side effects (savepoint) and the action is marked failed.
 */
export async function executeAction(
  db: DB,
  input: { actionId: string; actorId: string; actorRole: Role },
  executors: Record<string, Executor> = defaultExecutors,
): Promise<{ action: ActionRow; replay: boolean }> {
  let failure: Error | null = null;
  const result = await db.transaction(async (tx) => {
    const [a] = await tx.select().from(toolActions).where(eq(toolActions.actionId, input.actionId)).for('update');
    if (!a) throw notFound('Tool action', input.actionId);
    if (a.status === 'executed') return { action: a, replay: true };

    if (a.requiresHumanApproval) {
      if (input.actorRole === 'agent') throw new AppError('FORBIDDEN', 'Only a manager can execute sensitive actions');
      // 'failed' can be retried: the failed attempt's side effects were rolled back and approval still stands.
      if (a.status !== 'approved' && a.status !== 'failed') {
        throw new AppError('CONFLICT', `Action is '${a.status}'; it must be approved by a manager before execution`);
      }
    } else if (a.status !== 'requested' && a.status !== 'failed') {
      throw new AppError('CONFLICT', `Action is '${a.status}' and cannot be executed`);
    }

    const run = executors[a.toolName];
    if (!run) throw new AppError('TOOL_EXECUTION_FAILED', `No executor for '${a.toolName}'`);

    try {
      const output = await tx.transaction((sp) => run(sp, a));
      const [done] = await tx
        .update(toolActions)
        .set({ status: 'executed', result: { ...output, executed_by: input.actorId, executed_at: new Date().toISOString() }, error: null, updatedAt: new Date() })
        .where(eq(toolActions.actionId, a.actionId))
        .returning();
      return { action: done, replay: false };
    } catch (err) {
      failure = err as Error;
      const [failed] = await tx
        .update(toolActions)
        .set({ status: 'failed', error: failure.message.slice(0, 500), updatedAt: new Date() })
        .where(eq(toolActions.actionId, a.actionId))
        .returning();
      return { action: failed, replay: false };
    }
  });
  if (failure) {
    throw new AppError('TOOL_EXECUTION_FAILED', `Execution of ${result.action.toolName} failed: ${(failure as Error).message}`, {
      action_id: result.action.actionId,
      status: 'failed',
    });
  }
  return result;
}

export async function listActions(db: DB, filters: { ticketId?: string; status?: string }) {
  const where: SQL[] = [];
  if (filters.ticketId) where.push(eq(toolActions.ticketId, filters.ticketId));
  if (filters.status) where.push(eq(toolActions.status, filters.status));
  return db.select().from(toolActions).where(where.length ? and(...where) : undefined).orderBy(desc(toolActions.createdAt));
}

export async function getAction(db: DB, actionId: string) {
  const [a] = await db.select().from(toolActions).where(eq(toolActions.actionId, actionId));
  if (!a) throw notFound('Tool action', actionId);
  const history = await db.select().from(approvals).where(eq(approvals.actionId, actionId)).orderBy(approvals.createdAt);
  return { action: a, approvals: history };
}
