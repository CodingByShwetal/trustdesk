import type { z } from 'zod';
import { AppError } from '../../lib/errors.js';
import { ProviderError, type LLMProvider, type LLMRequest, type LLMUsage } from './types.js';

export type CallMeta = {
  provider: string;
  model: string;
  attempts: number;
  latencyMs: number;
  usage: LLMUsage;
  fallback?: { from: string; reason: string };
};

/** Parses model text as JSON, tolerating ```json fences and leading prose. */
export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced ? fenced[1] : text).trim();
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(candidate.slice(start, end + 1));
    throw new Error('Output is not JSON');
  }
}

/**
 * Calls the model and validates its JSON against a Zod schema. One repair
 * attempt is made with the validation errors fed back; after that the call fails.
 */
export async function generateStructured<S extends z.ZodTypeAny>(
  llm: LLMProvider,
  req: LLMRequest,
  schema: S,
): Promise<{ data: z.infer<S>; meta: CallMeta }> {
  const meta: CallMeta = { provider: llm.name, model: '', attempts: 0, latencyMs: 0, usage: { input: 0, output: 0 } };
  let user = req.user;
  let lastError = '';

  for (let attempt = 1; attempt <= 2; attempt++) {
    meta.attempts = attempt;
    let res;
    try {
      res = await llm.generate({ ...req, user });
    } catch (err) {
      if (err instanceof ProviderError) {
        throw new AppError(err.timeout ? 'AI_PROVIDER_TIMEOUT' : 'AI_PROVIDER_ERROR', err.message, { provider: llm.name });
      }
      throw err;
    }
    meta.model = res.model;
    meta.latencyMs += res.latencyMs;
    meta.usage.input += res.usage.input;
    meta.usage.output += res.usage.output;
    if (res.fallback) meta.fallback = res.fallback;

    try {
      const parsed = schema.safeParse(extractJson(res.text));
      if (parsed.success) return { data: parsed.data, meta };
      lastError = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    } catch (err) {
      lastError = (err as Error).message;
    }
    user = `${req.user}\n\nYOUR PREVIOUS OUTPUT WAS INVALID (${lastError}). Return ONLY one JSON object that matches the required schema exactly.`;
  }

  throw new AppError('AI_PROVIDER_ERROR', `Model output failed schema validation after 2 attempts: ${lastError}`, {
    provider: llm.name,
    model: meta.model,
  });
}
