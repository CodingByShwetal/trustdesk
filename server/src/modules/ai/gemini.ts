import { ProviderError, type LLMProvider, type LLMRequest, type LLMResponse } from './types.js';

type GeminiOptions = {
  apiKey: string;
  model: string;
  fallbackModel?: string;
  timeoutMs: number;
  maxOutputTokens?: number;
  fetchFn?: typeof fetch;
  baseUrl?: string;
};

type GeminiPart = { text?: string; thought?: boolean };
type GeminiResponse = {
  candidates?: Array<{ content?: { parts?: GeminiPart[] }; finishReason?: string }>;
  promptFeedback?: { blockReason?: string };
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number };
};

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

/**
 * Gemini Developer API adapter (REST, no SDK). The primary model is tried first;
 * on rate limits, overload, timeouts or network errors the fallback model is used.
 * The API key travels in a header and never appears in URLs, logs or errors.
 */
export class GeminiProvider implements LLMProvider {
  readonly name = 'gemini';
  private readonly fetchFn: typeof fetch;
  private readonly baseUrl: string;

  constructor(private readonly opts: GeminiOptions) {
    this.fetchFn = opts.fetchFn ?? fetch;
    this.baseUrl = opts.baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta';
  }

  async generate(req: LLMRequest): Promise<LLMResponse> {
    try {
      return await this.call(this.opts.model, req);
    } catch (err) {
      const fallback = this.opts.fallbackModel;
      if (!(err instanceof ProviderError) || !err.retryable || !fallback || fallback === this.opts.model) throw err;
      const res = await this.call(fallback, req);
      return { ...res, fallback: { from: this.opts.model, reason: err.message } };
    }
  }

  private async call(model: string, req: LLMRequest): Promise<LLMResponse> {
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchFn(`${this.baseUrl}/models/${encodeURIComponent(model)}:generateContent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': this.opts.apiKey },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: req.system }] },
          contents: [{ role: 'user', parts: [{ text: req.user }] }],
          generationConfig: {
            responseMimeType: 'application/json',
            maxOutputTokens: this.opts.maxOutputTokens ?? 8192,
          },
        }),
        signal: controller.signal,
      });
    } catch (err) {
      const aborted = (err as Error).name === 'AbortError';
      throw new ProviderError(
        aborted ? `${model} timed out after ${this.opts.timeoutMs}ms` : `${model} network error: ${(err as Error).message}`,
        true,
        undefined,
        aborted,
      );
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 300);
      throw new ProviderError(`${model} returned HTTP ${res.status}: ${detail}`, RETRYABLE_STATUS.has(res.status), res.status);
    }

    const json = (await res.json()) as GeminiResponse;
    if (json.promptFeedback?.blockReason) {
      throw new ProviderError(`${model} blocked the prompt: ${json.promptFeedback.blockReason}`, false);
    }
    const candidate = json.candidates?.[0];
    const text = (candidate?.content?.parts ?? [])
      .filter((p) => !p.thought && typeof p.text === 'string')
      .map((p) => p.text)
      .join('');
    if (!text) {
      throw new ProviderError(`${model} returned no text (finishReason: ${candidate?.finishReason ?? 'unknown'})`, true);
    }

    const u = json.usageMetadata ?? {};
    return {
      text,
      provider: this.name,
      model,
      usage: { input: u.promptTokenCount ?? 0, output: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0) },
      latencyMs: Date.now() - started,
    };
  }
}
