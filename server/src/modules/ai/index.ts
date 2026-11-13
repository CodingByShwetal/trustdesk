import { config, type AppConfig } from '../../config.js';
import { GeminiProvider } from './gemini.js';
import { CompromisedMockProvider, MockProvider } from './mock.js';
import type { LLMProvider } from './types.js';

export function createProvider(cfg: AppConfig = config): LLMProvider {
  switch (cfg.LLM_PROVIDER) {
    case 'gemini':
      return new GeminiProvider({
        apiKey: cfg.GEMINI_API_KEY!,
        model: cfg.GEMINI_MODEL,
        fallbackModel: cfg.GEMINI_FALLBACK_MODEL,
        timeoutMs: cfg.LLM_TIMEOUT_MS,
      });
    case 'mock_compromised':
      return new CompromisedMockProvider();
    default:
      return new MockProvider();
  }
}

export type { LLMProvider } from './types.js';
