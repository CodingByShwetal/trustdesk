import { eq } from 'drizzle-orm';
import type { DB } from '../../db/client.js';
import { agentRuns } from '../../db/schema.js';
import { newId } from '../../lib/ids.js';
import type { CallMeta } from '../ai/structured.js';

export type RunType = 'triage' | 'draft_reply' | 'tool_recommendation' | 'eval_case';
export type RunStatus = 'running' | 'completed' | 'escalated' | 'blocked' | 'failed';
export type TraceStep = { name: string; status: 'ok' | 'warn' | 'error'; ms: number; detail?: unknown };
export type GuardrailResult = { stage: 'input' | 'retrieval' | 'output' | 'policy' | 'tools'; result: 'passed' | 'flagged' | 'blocked' | 'repaired'; rules: string[]; detail?: unknown };

/**
 * Collects one AI run's trace and persists it. The row is created as "running"
 * up front so even a crash leaves an auditable record.
 */
export class RunRecorder {
  readonly steps: TraceStep[] = [];
  readonly guardrails: GuardrailResult[] = [];
  toolCalls: unknown[] = [];
  retrievedDocIds: string[] = [];
  private readonly started = Date.now();
  private model: { provider?: string; name?: string; usage: { input: number; output: number }; latencyMs: number } = {
    usage: { input: 0, output: 0 },
    latencyMs: 0,
  };

  private constructor(
    private readonly db: DB,
    readonly runId: string,
    private readonly promptVersion: string,
  ) {}

  static async start(db: DB, ticketId: string, runType: RunType, promptVersion: string): Promise<RunRecorder> {
    const runId = newId('run');
    await db.insert(agentRuns).values({ runId, ticketId, runType, status: 'running', promptVersion });
    return new RunRecorder(db, runId, promptVersion);
  }

  /** Times a step and records it; errors are recorded then re-thrown. */
  async step<T>(name: string, fn: () => Promise<T> | T, detail?: (r: T) => unknown): Promise<T> {
    const t0 = Date.now();
    try {
      const result = await fn();
      this.steps.push({ name, status: 'ok', ms: Date.now() - t0, detail: detail ? detail(result) : undefined });
      return result;
    } catch (err) {
      this.steps.push({ name, status: 'error', ms: Date.now() - t0, detail: { error: (err as Error).message } });
      throw err;
    }
  }

  note(name: string, detail: unknown, status: TraceStep['status'] = 'ok') {
    this.steps.push({ name, status, ms: 0, detail });
  }

  guardrail(g: GuardrailResult) {
    this.guardrails.push(g);
  }

  modelCall(meta: CallMeta) {
    this.model.provider = meta.provider;
    this.model.name = meta.fallback ? `${meta.model} (fallback from ${meta.fallback.from})` : meta.model;
    this.model.usage.input += meta.usage.input;
    this.model.usage.output += meta.usage.output;
    this.model.latencyMs += meta.latencyMs;
  }

  async finish(status: Exclude<RunStatus, 'running'>, error?: string): Promise<void> {
    await this.db
      .update(agentRuns)
      .set({
        status,
        steps: this.steps,
        guardrailResults: this.guardrails,
        toolCalls: this.toolCalls,
        retrievedDocIds: this.retrievedDocIds,
        modelProvider: this.model.provider ?? null,
        modelName: this.model.name ?? null,
        promptVersion: this.promptVersion,
        latencyMs: Date.now() - this.started,
        tokenUsage: this.model.usage,
        error: error ?? null,
        completedAt: new Date(),
      })
      .where(eq(agentRuns.runId, this.runId));
  }
}
