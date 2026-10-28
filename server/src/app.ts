import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import fs from 'node:fs';
import { config } from './config.js';
import { sql } from 'drizzle-orm';
import type { DB } from './db/client.js';
import { AppError } from './lib/errors.js';
import { loadDemoUsers, makeAuthGuard, type AuthUser } from './api/auth.js';
import { authRoutes } from './api/routes/auth.js';
import { ticketRoutes } from './api/routes/tickets.js';
import { documentRoutes } from './api/routes/documents.js';
import { aiRoutes } from './api/routes/ai.js';
import { toolActionRoutes } from './api/routes/tool-actions.js';
import { evalRoutes } from './api/routes/evals.js';
import { createProvider, type LLMProvider } from './modules/ai/index.js';

export type AppDeps = { db: DB; llm?: LLMProvider; users?: Map<string, AuthUser>; logger?: boolean; webDir?: string };

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: deps.logger ?? false,
    bodyLimit: 1_000_000,
    // Never log bearer tokens.
    ...(deps.logger ? { logger: { redact: ['req.headers.authorization'] } } : {}),
  });
  const users = deps.users ?? loadDemoUsers();
  const requireRole = makeAuthGuard(users);
  const llm = deps.llm ?? createProvider();

  await app.register(cors, { origin: true });

  // One error shape for every failure: { error: { code, message, details } }.
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) {
      return reply.code(err.statusCode).send({ error: { code: err.code, message: err.message, details: err.details ?? null } });
    }
    const fe = err as { statusCode?: number; validation?: unknown; message: string };
    if (fe.validation || (fe.statusCode && fe.statusCode >= 400 && fe.statusCode < 500)) {
      return reply
        .code(fe.statusCode ?? 400)
        .send({ error: { code: 'VALIDATION_ERROR', message: fe.message, details: null } });
    }
    req.log.error(err);
    return reply.code(500).send({ error: { code: 'INTERNAL_ERROR', message: 'Unexpected server error', details: null } });
  });

  // Serve the built console when present; unknown non-API GETs fall back to index.html (SPA).
  const webDir = deps.webDir ?? config.WEB_DIR;
  const hasWeb = fs.existsSync(`${webDir}/index.html`);
  if (hasWeb) await app.register(fastifyStatic, { root: webDir, prefix: '/', wildcard: false });

  app.setNotFoundHandler((req, reply) => {
    if (hasWeb && req.method === 'GET' && !req.url.startsWith('/api') && req.url !== '/health') {
      return reply.sendFile('index.html');
    }
    return reply.code(404).send({ error: { code: 'NOT_FOUND', message: `Route ${req.method} ${req.url} not found`, details: null } });
  });

  app.get('/health', async () => {
    await deps.db.execute(sql`SELECT 1`);
    return { status: 'ok' };
  });

  await app.register(
    async (api) => {
      authRoutes(api, { users, requireRole });
      ticketRoutes(api, { db: deps.db, requireRole });
      documentRoutes(api, { db: deps.db, requireRole });
      aiRoutes(api, { db: deps.db, llm, requireRole });
      toolActionRoutes(api, { db: deps.db, requireRole });
      evalRoutes(api, { db: deps.db, llm, requireRole });
    },
    { prefix: '/api' },
  );

  return app;
}
