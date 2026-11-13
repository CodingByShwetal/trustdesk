import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { DB } from '../../db/client.js';
import { agentRuns } from '../../db/schema.js';
import { notFound } from '../../lib/errors.js';
import { parseOrThrow } from '../../lib/validate.js';
import type { LLMProvider } from '../../modules/ai/types.js';
import { runDraft } from '../../modules/pipeline/draft.js';
import { runTriage } from '../../modules/pipeline/triage.js';
import type { RequireRole } from '../auth.js';

const TicketParams = z.object({ ticketId: z.string().min(1).max(64) });
const RunParams = z.object({ runId: z.string().min(1).max(64) });

export function aiRoutes(app: FastifyInstance, deps: { db: DB; llm: LLMProvider; requireRole: RequireRole }) {
  const { db, llm, requireRole } = deps;

  app.post('/tickets/:ticketId/triage', { preHandler: requireRole('agent') }, async (req) => {
    const { ticketId } = parseOrThrow(TicketParams, req.params);
    return runTriage(db, llm, ticketId);
  });

  app.post('/tickets/:ticketId/draft-reply', { preHandler: requireRole('agent') }, async (req) => {
    const { ticketId } = parseOrThrow(TicketParams, req.params);
    return runDraft(db, llm, ticketId);
  });

  app.get('/agent-runs/:runId', { preHandler: requireRole('agent') }, async (req) => {
    const { runId } = parseOrThrow(RunParams, req.params);
    const [r] = await db.select().from(agentRuns).where(eq(agentRuns.runId, runId));
    if (!r) throw notFound('Agent run', runId);
    return {
      run_id: r.runId,
      ticket_id: r.ticketId,
      run_type: r.runType,
      status: r.status,
      retrieved_doc_ids: r.retrievedDocIds,
      tool_calls: r.toolCalls,
      guardrail_results: r.guardrailResults,
      steps: r.steps,
      model_provider: r.modelProvider,
      model_name: r.modelName,
      prompt_version: r.promptVersion,
      latency_ms: r.latencyMs,
      token_usage: r.tokenUsage,
      error: r.error,
      created_at: r.createdAt.toISOString(),
      completed_at: r.completedAt?.toISOString() ?? null,
    };
  });
}
