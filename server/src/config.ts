import 'dotenv/config';
import path from 'node:path';
import { z } from 'zod';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(8080),
  HOST: z.string().default('0.0.0.0'),
  DATABASE_URL: z.string().url(),
  DATA_DIR: z.string().default(path.resolve(process.cwd(), '../data')),
  // Comma-separated "token:userId:role" triples. Demo-only auth, documented in the README.
  DEMO_TOKENS: z
    .string()
    .default('agent-demo-token:agent_priya:agent,manager-demo-token:mgr_rohan:manager,admin-demo-token:admin_sara:admin'),
  // Password for POST /api/auth/login (username = agent | manager | admin). Demo only.
  DEMO_PASSWORD: z.string().min(4).default('trustdesk'),
  // Calendar used to turn a ticket's created_at instant into a policy date.
  BUSINESS_TIMEZONE: z.string().default('Asia/Kolkata'),
  // mock = deterministic heuristic stand-in; mock_compromised = a model that obeys every injection
  // (used to prove the guardrails hold even when the model does not).
  LLM_PROVIDER: z.enum(['gemini', 'mock', 'mock_compromised']).default('mock'),
  LLM_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120_000).default(30_000),
  GEMINI_API_KEY: z.string().optional(),
  GEMINI_MODEL: z.string().default('gemini-3-flash-preview'),
  GEMINI_FALLBACK_MODEL: z.string().default('gemini-3.1-flash-lite-preview'),
  // Pause between eval cases; ~4000 helps stay under free-tier per-minute limits.
  EVAL_DELAY_MS: z.coerce.number().int().min(0).max(60_000).default(0),
  REPORTS_DIR: z.string().default(path.resolve(process.cwd(), '../reports')),
  // Built web console (web/dist). Served at / when the folder exists.
  WEB_DIR: z.string().default(path.resolve(process.cwd(), '../web/dist')),
  SEED_ON_START: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
});

export type AppConfig = z.infer<typeof EnvSchema>;

function loadConfig(): AppConfig {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment configuration: ${issues}`);
  }
  if (parsed.data.LLM_PROVIDER === 'gemini' && !parsed.data.GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY is required when LLM_PROVIDER=gemini');
  }
  return parsed.data;
}

export const config = loadConfig();
