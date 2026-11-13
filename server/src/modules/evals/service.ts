import fs from 'node:fs/promises';
import path from 'node:path';
import { desc, eq, inArray } from 'drizzle-orm';
import type { DB } from '../../db/client.js';
import { evalRuns } from '../../db/schema.js';
import { AppError, notFound } from '../../lib/errors.js';
import { newId } from '../../lib/ids.js';
import type { LLMProvider } from '../ai/types.js';
import { renderReport } from './report.js';
import { loadEvalCases, runEvalCases, type CaseResult, type EvalMetrics } from './runner.js';

export type EvalRunOptions = { caseIds?: string[]; delayMs?: number; reportsDir?: string };

/** Runs the suite end to end and stores progress, metrics and per-case results. */
export async function executeEvalRun(db: DB, llm: LLMProvider, evalRunId: string, opts: EvalRunOptions = {}) {
  const startedAt = new Date();
  try {
    const cases = await loadEvalCases(db, opts.caseIds);
    if (!cases.length) throw new AppError('VALIDATION_ERROR', 'No eval cases matched');
    await db.update(evalRuns).set({ status: 'running', startedAt, totalCases: cases.length }).where(eq(evalRuns.evalRunId, evalRunId));

    let model: string | null = null;
    const partial: CaseResult[] = [];
    const { results, metrics } = await runEvalCases(db, llm, cases, {
      delayMs: opts.delayMs,
      onCase: async (r) => {
        partial.push(r);
        await db.update(evalRuns).set({ caseResults: partial }).where(eq(evalRuns.evalRunId, evalRunId));
      },
    });
    model = await firstModel(db, results);

    const completedAt = new Date();
    await db
      .update(evalRuns)
      .set({ status: 'completed', completedAt, metrics: { ...metrics, model }, caseResults: results })
      .where(eq(evalRuns.evalRunId, evalRunId));

    let reportPath: string | null = null;
    if (opts.reportsDir) {
      const md = renderReport({ evalRunId, provider: llm.name, model, startedAt, completedAt, metrics, results });
      await fs.mkdir(opts.reportsDir, { recursive: true });
      reportPath = path.join(opts.reportsDir, `${evalRunId}.md`);
      await fs.writeFile(reportPath, md);
      await fs.writeFile(path.join(opts.reportsDir, `${evalRunId}.json`), JSON.stringify({ evalRunId, provider: llm.name, model, metrics, results }, null, 2));
    }
    return { evalRunId, metrics, results, model, reportPath, startedAt, completedAt };
  } catch (err) {
    await db.update(evalRuns).set({ status: 'failed', completedAt: new Date(), error: (err as Error).message }).where(eq(evalRuns.evalRunId, evalRunId));
    throw err;
  }
}

async function firstModel(db: DB, results: CaseResult[]): Promise<string | null> {
  const { agentRuns } = await import('../../db/schema.js');
  const ids = results.map((r) => r.draft_run_id).filter((x): x is string => !!x);
  if (!ids.length) return null;
  const [run] = await db.select({ m: agentRuns.modelName }).from(agentRuns).where(eq(agentRuns.runId, ids[0]));
  return run?.m ?? null;
}

export async function createEvalRun(db: DB, provider: string) {
  // Eval cases share the seed tickets, so concurrent runs would overwrite each other's triage.
  const active = await db.select().from(evalRuns).where(inArray(evalRuns.status, ['queued', 'running']));
  if (active.length) throw new AppError('CONFLICT', `Eval run ${active[0].evalRunId} is still ${active[0].status}`);
  const [row] = await db.insert(evalRuns).values({ evalRunId: newId('eval'), status: 'queued', provider }).returning();
  return row;
}

/**
 * Starts an eval run in the background so the API keeps serving requests.
 * The run's status and partial results are polled via GET /eval-runs/:id.
 */
export async function startEvalRunInBackground(db: DB, llm: LLMProvider, opts: EvalRunOptions = {}) {
  const row = await createEvalRun(db, llm.name);
  setImmediate(() => {
    executeEvalRun(db, llm, row.evalRunId, opts).catch(() => {
      /* failure is recorded on the eval_runs row */
    });
  });
  return row;
}

/** In-process jobs do not survive a restart; mark orphaned runs as failed on boot. */
export async function failOrphanedRuns(db: DB) {
  await db
    .update(evalRuns)
    .set({ status: 'failed', error: 'Server restarted while the run was in progress', completedAt: new Date() })
    .where(inArray(evalRuns.status, ['queued', 'running']));
}

export async function listEvalRuns(db: DB) {
  return db.select().from(evalRuns).orderBy(desc(evalRuns.startedAt)).limit(50);
}

export async function getEvalRun(db: DB, evalRunId: string) {
  const [row] = await db.select().from(evalRuns).where(eq(evalRuns.evalRunId, evalRunId));
  if (!row) throw notFound('Eval run', evalRunId);
  return row;
}

export type { EvalMetrics };
