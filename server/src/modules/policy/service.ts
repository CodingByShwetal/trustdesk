import { eq } from 'drizzle-orm';
import type { DB } from '../../db/client.js';
import { customers, orders, tickets } from '../../db/schema.js';
import { config } from '../../config.js';
import { notFound } from '../../lib/errors.js';
import { computePolicyFacts } from './facts.js';

/** Loads a ticket's customer/order context and computes its policy facts. */
export async function getPolicyFactsForTicket(db: DB, ticketId: string) {
  const [ticket] = await db.select().from(tickets).where(eq(tickets.ticketId, ticketId));
  if (!ticket) throw notFound('Ticket', ticketId);
  const [customer] = await db.select().from(customers).where(eq(customers.customerId, ticket.customerId));
  const [order] = ticket.orderId ? await db.select().from(orders).where(eq(orders.orderId, ticket.orderId)) : [];
  const facts = computePolicyFacts({ ticket, customer, order: order ?? null, timeZone: config.BUSINESS_TIMEZONE });
  return { ticket, customer, order: order ?? null, facts };
}
