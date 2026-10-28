import { and, desc, eq, type SQL } from 'drizzle-orm';
import type { DB } from '../../db/client.js';
import { agentRuns, customers, drafts, orders, tickets, toolActions } from '../../db/schema.js';
import { AppError, notFound } from '../../lib/errors.js';
import { newId } from '../../lib/ids.js';

export type TicketFilters = { status?: string; category?: string };

export async function listTickets(db: DB, filters: TicketFilters = {}) {
  const where: SQL[] = [];
  if (filters.status) where.push(eq(tickets.status, filters.status));
  const rows = await db
    .select({ ticket: tickets, customerName: customers.name, customerTier: customers.tier })
    .from(tickets)
    .innerJoin(customers, eq(customers.customerId, tickets.customerId))
    .where(where.length ? and(...where) : undefined)
    .orderBy(tickets.ticketId);
  // Category only exists after triage, so it is filtered in memory.
  return filters.category ? rows.filter((r) => r.ticket.triage?.category === filters.category) : rows;
}

export async function getTicketDetail(db: DB, ticketId: string) {
  const [ticket] = await db.select().from(tickets).where(eq(tickets.ticketId, ticketId));
  if (!ticket) throw notFound('Ticket', ticketId);

  const [customer] = await db.select().from(customers).where(eq(customers.customerId, ticket.customerId));
  const [order] = ticket.orderId ? await db.select().from(orders).where(eq(orders.orderId, ticket.orderId)) : [];
  const [draftRows, actionRows, runRows] = await Promise.all([
    db.select().from(drafts).where(eq(drafts.ticketId, ticketId)).orderBy(desc(drafts.createdAt)),
    db.select().from(toolActions).where(eq(toolActions.ticketId, ticketId)).orderBy(desc(toolActions.createdAt)),
    db.select().from(agentRuns).where(eq(agentRuns.ticketId, ticketId)).orderBy(desc(agentRuns.createdAt)),
  ]);

  return { ticket, customer, order: order ?? null, drafts: draftRows, actions: actionRows, runs: runRows };
}

export type CreateTicketInput = {
  customer_id: string;
  order_id?: string | null;
  channel: string;
  subject: string;
  body: string;
};

export async function createTicket(db: DB, input: CreateTicketInput) {
  const [customer] = await db.select().from(customers).where(eq(customers.customerId, input.customer_id));
  if (!customer) throw notFound('Customer', input.customer_id);
  if (input.order_id) {
    const [order] = await db.select().from(orders).where(eq(orders.orderId, input.order_id));
    if (!order) throw notFound('Order', input.order_id);
    if (order.customerId !== customer.customerId) {
      throw new AppError('VALIDATION_ERROR', `Order ${order.orderId} does not belong to customer ${customer.customerId}`);
    }
  }
  const [created] = await db
    .insert(tickets)
    .values({
      ticketId: newId('tkt'),
      customerId: input.customer_id,
      orderId: input.order_id ?? null,
      channel: input.channel,
      subject: input.subject,
      body: input.body,
      createdAt: new Date(),
      status: 'open',
    })
    .returning();
  return created;
}
