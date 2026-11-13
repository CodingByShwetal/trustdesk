import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DB } from '../../db/client.js';
import { parseOrThrow } from '../../lib/validate.js';
import { createTicket, getTicketDetail, listTickets } from '../../modules/tickets/service.js';
import { getPolicyFactsForTicket } from '../../modules/policy/service.js';
import type { RequireRole } from '../auth.js';
import { customerDto, draftDto, orderDto, runSummaryDto, ticketDto, toolActionDto } from '../serializers.js';

const ListQuery = z.object({
  status: z.string().optional(),
  category: z.enum(['shipping', 'refund', 'warranty', 'billing', 'account_security', 'general']).optional(),
});

const IdParams = z.object({ ticketId: z.string().min(1).max(64) });

const CreateBody = z.object({
  customer_id: z.string().min(1),
  order_id: z.string().min(1).nullish(),
  channel: z.enum(['email', 'chat', 'phone', 'web']),
  subject: z.string().trim().min(1).max(300),
  body: z.string().trim().min(1).max(10_000),
});

export function ticketRoutes(app: FastifyInstance, deps: { db: DB; requireRole: RequireRole }) {
  const { db, requireRole } = deps;

  app.get('/tickets', { preHandler: requireRole('agent') }, async (req) => {
    const query = parseOrThrow(ListQuery, req.query);
    const rows = await listTickets(db, query);
    return {
      tickets: rows.map((r) => ({
        ...ticketDto(r.ticket),
        customer_name: r.customerName,
        customer_tier: r.customerTier,
      })),
    };
  });

  app.get('/tickets/:ticketId', { preHandler: requireRole('agent') }, async (req) => {
    const { ticketId } = parseOrThrow(IdParams, req.params);
    const d = await getTicketDetail(db, ticketId);
    return {
      ...ticketDto(d.ticket),
      customer: customerDto(d.customer),
      order: d.order ? orderDto(d.order) : null,
      drafts: d.drafts.map(draftDto),
      tool_actions: d.actions.map(toolActionDto),
      runs: d.runs.map(runSummaryDto),
    };
  });

  // Deterministic policy facts (windows, warranty, signals) measured from the ticket's created_at.
  app.get('/tickets/:ticketId/policy-facts', { preHandler: requireRole('agent') }, async (req) => {
    const { ticketId } = parseOrThrow(IdParams, req.params);
    const { facts } = await getPolicyFactsForTicket(db, ticketId);
    return { ticket_id: ticketId, ...facts };
  });

  app.post('/tickets', { preHandler: requireRole('agent') }, async (req, reply) => {
    const body = parseOrThrow(CreateBody, req.body);
    const created = await createTicket(db, body);
    return reply.code(201).send(ticketDto(created));
  });
}
