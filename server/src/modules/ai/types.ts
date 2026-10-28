export type LLMPurpose = 'triage' | 'draft' | 'judge';

export type LLMRequest = {
  purpose: LLMPurpose;
  system: string;
  user: string;
  /**
   * The same data rendered into `user`, in structured form. Real providers
   * ignore it; the mock provider reads it instead of parsing prose.
   */
  input: unknown;
};

export type LLMUsage = { input: number; output: number };

export type LLMResponse = {
  text: string;
  provider: string;
  model: string;
  usage: LLMUsage;
  latencyMs: number;
  fallback?: { from: string; reason: string };
};

export interface LLMProvider {
  readonly name: string;
  generate(req: LLMRequest): Promise<LLMResponse>;
}

/** Provider failure; `retryable` errors trigger the fallback model. */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly status?: number,
    readonly timeout = false,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}
