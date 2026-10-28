import type { FastifyInstance } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { config } from '../../config.js';
import { AppError } from '../../lib/errors.js';
import { parseOrThrow } from '../../lib/validate.js';
import type { AuthUser, RequireRole } from '../auth.js';

const LoginBody = z.object({
  username: z.enum(['agent', 'manager', 'admin']),
  password: z.string().min(1),
});

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export function authRoutes(app: FastifyInstance, deps: { users: Map<string, AuthUser>; requireRole: RequireRole }) {
  // Demo login: one shared password, username picks the role.
  app.post('/auth/login', async (req) => {
    const { username, password } = parseOrThrow(LoginBody, req.body);
    if (!safeEqual(password, config.DEMO_PASSWORD)) throw new AppError('UNAUTHORIZED', 'Invalid credentials');
    const user = [...deps.users.values()].find((u) => u.role === username);
    if (!user) throw new AppError('UNAUTHORIZED', 'Invalid credentials');
    return { token: user.token, user_id: user.userId, role: user.role };
  });

  app.get('/auth/me', { preHandler: deps.requireRole('agent') }, async (req) => ({
    user_id: req.user!.userId,
    role: req.user!.role,
  }));
}
