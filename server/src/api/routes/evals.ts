import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../../config.js';
import type { DB } from '../../db/client.js';
import { evalRuns } from '../../db/schema.js';
import type { InferSelectModel } from 'drizzle-orm';
import { parseOrThrow } from '../../lib/validate.js';
import { createProvider } from '../../modules/ai/index.js';
import type { LLMProvider } from '../../modules/ai/types.js';
import { renderReport } from '../../modules/evals/report.js';
import type { CaseResult, EvalMetrics } from '../../modules/evals/runner.js';
import { getEvalRun, listEvalRuns, startEvalRunInBackground } from '../../modules/evals/service.js';
import type { RequireRole } from '../auth.js';

const StartBody = z.object({
  case_ids: z.array(z.string().regex(/^eval_\d+$/)).max(100).optional(),
  // "configured" uses the server's LLM_PROVIDER; the mocks need no API key.
  provider: z.enum(['configured', 'mock', 'mock_compromised']).default('configured'),
});
const IdParams = z.object({ evalRunId: z.string().min(1).max(64) });

const evalRunDto = (r: InferSelectModel<typeof evalRuns>) => ({
  eval_run_id: r.evalRunId,
  status: r.status,
  provider: r.provider,
  started_at: r.startedAt.toISOString(),
  completed_at: r.completedAt?.toISOString() ?? null,
  total_cases: r.totalCases,
  completed_cases: (r.caseResults ?? []).length,
  metrics: r.metrics ?? null,
  error: r.error ?? null,
});

export function evalRoutes(app: FastifyInstance, deps: { db: DB; llm: LLMProvider; requireRole: RequireRole }) {
  const { db, llm, requireRole } = deps;

  app.post('/eval-runs', { preHandler: requireRole('admin') }, async (req, reply) => {
    const body = parseOrThrow(StartBody, req.body ?? {});
    const provider = body.provider === 'configured' ? llm : createProvider({ ...config, LLM_PROVIDER: body.provider });
    const row = await startEvalRunInBackground(db, provider, {
      caseIds: body.case_ids,
      delayMs: config.EVAL_DELAY_MS,
      reportsDir: config.REPORTS_DIR,
    });
    return reply.code(202).send(evalRunDto(row));
  });

  app.get('/eval-runs', { preHandler: requireRole('agent') }, async () => ({
    eval_runs: (await listEvalRuns(db)).map(evalRunDto),
  }));

  app.get('/eval-runs/:evalRunId', { preHandler: requireRole('agent') }, async (req) => {
    const { evalRunId } = parseOrThrow(IdParams, req.params);
    const r = await getEvalRun(db, evalRunId);
    return { ...evalRunDto(r), case_results: r.caseResults ?? [] };
  });

  app.get('/eval-runs/:evalRunId/report', { preHandler: requireRole('agent') }, async (req, reply) => {
    const { evalRunId } = parseOrThrow(IdParams, req.params);
    const r = await getEvalRun(db, evalRunId);
    if (r.status !== 'completed' || !r.metrics) {
      return reply.code(409).send({ error: { code: 'CONFLICT', message: `Eval run is ${r.status}`, details: null } });
    }
    const md = renderReport({
      evalRunId: r.evalRunId,
      provider: r.provider,
      model: (r.metrics as { model?: string | null }).model ?? null,
      startedAt: r.startedAt,
      completedAt: r.completedAt ?? new Date(),
      metrics: r.metrics as unknown as EvalMetrics,
      results: (r.caseResults ?? []) as CaseResult[],
    });
    return reply.type('text/markdown; charset=utf-8').send(md);
  });
}
