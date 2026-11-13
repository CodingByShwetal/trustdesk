import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { GeminiProvider } from '../src/modules/ai/gemini.js';
import { extractJson, generateStructured } from '../src/modules/ai/structured.js';
import type { LLMProvider, LLMRequest } from '../src/modules/ai/types.js';

type Call = { url: string; init: RequestInit };

/** Fake fetch that replays scripted responses and records each call. */
function fakeFetch(script: Array<() => Response | Promise<Response>>) {
  const calls: Call[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const next = script.shift();
    if (!next) throw new Error('unexpected call');
    return next();
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const ok = (text: string, extra: Record<string, unknown> = {}) => () =>
  new Response(
    JSON.stringify({
      candidates: [{ content: { parts: [{ text: 'thinking...', thought: true }, { text }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 30, thoughtsTokenCount: 10 },
      ...extra,
    }),
    { status: 200 },
  );
const status = (code: number) => () => new Response('{"error":"x"}', { status: code });
const req: LLMRequest = { purpose: 'triage', system: 'sys', user: 'usr', input: {} };

const provider = (fetchFn: typeof fetch, timeoutMs = 1000) =>
  new GeminiProvider({ apiKey: 'AIza-test-key', model: 'gemini-3-flash-preview', fallbackModel: 'gemini-3.1-flash-lite-preview', timeoutMs, fetchFn, baseUrl: 'https://example.test/v1beta' });

describe('GeminiProvider', () => {
  it('sends a JSON-mode request with the key in a header, never the URL', async () => {
    const { fn, calls } = fakeFetch([ok('{"a":1}')]);
    const res = await provider(fn).generate(req);
    expect(calls[0].url).toBe('https://example.test/v1beta/models/gemini-3-flash-preview:generateContent');
    expect(calls[0].url).not.toContain('AIza');
    expect((calls[0].init.headers as Record<string, string>)['x-goog-api-key']).toBe('AIza-test-key');
    const body = JSON.parse(String(calls[0].init.body));
    expect(body.systemInstruction.parts[0].text).toBe('sys');
    expect(body.contents[0]).toEqual({ role: 'user', parts: [{ text: 'usr' }] });
    expect(body.generationConfig.responseMimeType).toBe('application/json');
    expect(res).toMatchObject({ text: '{"a":1}', model: 'gemini-3-flash-preview', usage: { input: 120, output: 40 } });
    expect(res.fallback).toBeUndefined();
  });

  it.each([429, 503, 500])('falls back to Flash-Lite on HTTP %i', async (code) => {
    const { fn, calls } = fakeFetch([status(code), ok('{"a":2}')]);
    const res = await provider(fn).generate(req);
    expect(calls[1].url).toContain('gemini-3.1-flash-lite-preview');
    expect(res.model).toBe('gemini-3.1-flash-lite-preview');
    expect(res.fallback).toMatchObject({ from: 'gemini-3-flash-preview' });
  });

  it('does not fall back on a non-retryable 400', async () => {
    const { fn, calls } = fakeFetch([status(400)]);
    await expect(provider(fn).generate(req)).rejects.toMatchObject({ retryable: false, status: 400 });
    expect(calls).toHaveLength(1);
  });

  it('falls back after a timeout', async () => {
    const hang = () =>
      new Promise<Response>((_, reject) => {
        // Mirrors fetch: rejects with AbortError when the signal fires.
        setTimeout(() => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), 50);
      });
    const { fn } = fakeFetch([hang, ok('{"a":3}')]);
    const res = await provider(fn, 20).generate(req);
    expect(res.fallback?.reason).toMatch(/timed out/);
  });

  it('reports blocked prompts and empty candidates as errors', async () => {
    const blocked = () => new Response(JSON.stringify({ promptFeedback: { blockReason: 'SAFETY' } }), { status: 200 });
    await expect(provider(fakeFetch([blocked]).fn).generate(req)).rejects.toThrow(/blocked/);
    const empty = () => new Response(JSON.stringify({ candidates: [{ finishReason: 'MAX_TOKENS' }] }), { status: 200 });
    await expect(provider(fakeFetch([empty, empty]).fn).generate(req)).rejects.toThrow(/no text/);
  });
});

describe('generateStructured', () => {
  const Schema = z.object({ category: z.enum(['refund', 'billing']) });
  const scripted = (...texts: string[]): LLMProvider => ({
    name: 'scripted',
    generate: async () => ({ text: texts.shift() ?? '', provider: 'scripted', model: 'm', usage: { input: 1, output: 1 }, latencyMs: 1 }),
  });

  it('accepts fenced JSON', () => {
    expect(extractJson('Here you go:\n```json\n{"x": 1}\n```')).toEqual({ x: 1 });
    expect(extractJson('noise {"x": 2} trailing')).toEqual({ x: 2 });
  });

  it('repairs once after invalid output', async () => {
    const { data, meta } = await generateStructured(scripted('{"category":"shipping"}', '{"category":"refund"}'), req, Schema);
    expect(data).toEqual({ category: 'refund' });
    expect(meta.attempts).toBe(2);
    expect(meta.usage).toEqual({ input: 2, output: 2 });
  });

  it('fails with AI_PROVIDER_ERROR after two invalid outputs', async () => {
    await expect(generateStructured(scripted('nope', '{"category":1}'), req, Schema)).rejects.toMatchObject({ code: 'AI_PROVIDER_ERROR' });
  });
});
