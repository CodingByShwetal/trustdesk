import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { InferSelectModel } from 'drizzle-orm';
import type { DB } from '../../db/client.js';
import type { approvals } from '../../db/schema.js';
import { parseOrThrow } from '../../lib/validate.js';
import { decideAction, executeAction, getAction, listActions, requestAction } from '../../modules/tools/service.js';
import type { RequireRole } from '../auth.js';
import { toolActionDto } from '../serializers.js';

const RequestBody = z.object({
  ticket_id: z.string().min(1).max(64),
  tool_name: z.string().min(1).max(64),
  payload: z.record(z.unknown()).refine((p) => JSON.stringify(p).length <= 5000, 'payload too large'),
  run_id: z.string().min(1).max(64).optional(),
});
const IdParams = z.object({ actionId: z.string().min(1).max(64) });
const DecideBody = z.object({
  decision: z.enum(['approved', 'rejected']).default('approved'),
  reason: z.string().trim().min(3, 'Give a short reason for the audit log').max(500),
});
const ListQuery = z.object({
  ticket_id: z.string().max(64).optional(),
  status: z.enum(['requested', 'approval_required', 'approved', 'rejected', 'executed', 'failed', 'cancelled']).optional(),
});

const approvalDto = (a: InferSelectModel<typeof approvals>) => ({
  approval_id: a.approvalId,
  action_id: a.actionId,
  reviewer_id: a.reviewerId,
  decision: a.decision,
  reason: a.reason,
  created_at: a.createdAt.toISOString(),
});

export function toolActionRoutes(app: FastifyInstance, deps: { db: DB; requireRole: RequireRole }) {
  const { db, requireRole } = deps;

  app.post('/tool-actions', { preHandler: requireRole('agent') }, async (req, reply) => {
    const body = parseOrThrow(RequestBody, req.body);
    const { action, replay } = await requestAction(db, {
      ticketId: body.ticket_id,
      toolName: body.tool_name,
      payload: body.payload,
      runId: body.run_id,
      requestedBy: req.user!.userId,
    });
    return reply.code(replay ? 200 : 201).send({ ...toolActionDto(action), idempotent_replay: replay });
  });

  app.get('/tool-actions', { preHandler: requireRole('agent') }, async (req) => {
    const q = parseOrThrow(ListQuery, req.query);
    const rows = await listActions(db, { ticketId: q.ticket_id, status: q.status });
    return { tool_actions: rows.map(toolActionDto) };
  });

  app.get('/tool-actions/:actionId', { preHandler: requireRole('agent') }, async (req) => {
    const { actionId } = parseOrThrow(IdParams, req.params);
    const { action, approvals: history } = await getAction(db, actionId);
    return { ...toolActionDto(action), approvals: history.map(approvalDto) };
  });

  // Approve or reject (decision field). Managers only.
  app.post('/tool-actions/:actionId/approve', { preHandler: requireRole('manager') }, async (req) => {
    const { actionId } = parseOrThrow(IdParams, req.params);
    const body = parseOrThrow(DecideBody, req.body ?? {});
    const { action, replay } = await decideAction(db, { actionId, reviewerId: req.user!.userId, decision: body.decision, reason: body.reason });
    return { ...toolActionDto(action), idempotent_replay: replay };
  });

  // Agents may execute low-risk actions; sensitive ones need a manager and a prior approval.
  app.post('/tool-actions/:actionId/execute', { preHandler: requireRole('agent') }, async (req) => {
    const { actionId } = parseOrThrow(IdParams, req.params);
    const { action, replay } = await executeAction(db, { actionId, actorId: req.user!.userId, actorRole: req.user!.role });
    return { ...toolActionDto(action), idempotent_replay: replay };
  });
}
