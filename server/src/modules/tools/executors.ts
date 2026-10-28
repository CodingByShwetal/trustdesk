import { eq } from 'drizzle-orm';
import type { DB } from '../../db/client.js';
import { refundReviews, replacementOrders, tickets, type toolActions } from '../../db/schema.js';
import { newId } from '../../lib/ids.js';
import type { InferSelectModel } from 'drizzle-orm';

/** A transaction handle (drizzle passes the same API inside db.transaction). */
export type Tx = Parameters<Parameters<DB['transaction']>[0]>[0];
export type ActionRow = InferSelectModel<typeof toolActions>;
export type Executor = (tx: Tx, action: ActionRow) => Promise<Record<string, unknown>>;

const str = (v: unknown) => String(v);

/**
 * Mock integrations. Each runs inside the execute transaction, and the two that
 * create records are also unique on idempotency key, so a duplicate is impossible
 * even if a caller bypasses the action state machine.
 */
export const defaultExecutors: Record<string, Executor> = {
  async create_replacement_order(tx, a) {
    const p = a.payload;
    const [row] = await tx
      .insert(replacementOrders)
      .values({ replacementId: newId('rep'), actionId: a.actionId, orderId: str(p.order_id), sku: str(p.sku), reason: str(p.reason), idempotencyKey: a.idempotencyKey })
      .onConflictDoNothing({ target: replacementOrders.idempotencyKey })
      .returning();
    const rec = row ?? (await tx.select().from(replacementOrders).where(eq(replacementOrders.idempotencyKey, a.idempotencyKey)))[0];
    return { replacement_id: rec.replacementId, order_id: rec.orderId, sku: rec.sku, status: 'replacement_created' };
  },

  async start_refund_review(tx, a) {
    const p = a.payload;
    const [row] = await tx
      .insert(refundReviews)
      .values({ reviewId: newId('rr'), actionId: a.actionId, orderId: str(p.order_id), amount: Number(p.amount), reason: str(p.reason), idempotencyKey: a.idempotencyKey })
      .onConflictDoNothing({ target: refundReviews.idempotencyKey })
      .returning();
    const rec = row ?? (await tx.select().from(refundReviews).where(eq(refundReviews.idempotencyKey, a.idempotencyKey)))[0];
    // A review is opened; no money moves until payment operations confirm.
    return { review_id: rec.reviewId, order_id: rec.orderId, amount: rec.amount, status: 'pending_payment_ops_review' };
  },

  async open_carrier_investigation(_tx, a) {
    return { investigation_id: `inv_${a.actionId.slice(4)}`, tracking_number: a.payload.tracking_number, carrier_status: 'investigation_opened' };
  },

  async escalate_to_human(tx, a) {
    await tx.update(tickets).set({ status: 'escalated' }).where(eq(tickets.ticketId, a.ticketId));
    return { queue: a.payload.queue, status: 'queued_for_specialist' };
  },

  async issue_coupon(_tx, a) {
    return { coupon_code: `TD-${a.actionId.slice(-8).toUpperCase()}`, amount: a.payload.amount, currency: 'INR', status: 'coupon_issued' };
  },

  async lock_account(_tx, a) {
    return { customer_id: a.payload.customer_id, status: 'account_locked' };
  },
};
