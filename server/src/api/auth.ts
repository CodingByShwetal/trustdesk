import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { AppError } from '../lib/errors.js';

export type Role = 'agent' | 'manager' | 'admin';
export type AuthUser = { userId: string; role: Role; token: string };

// Managers can do everything agents can; admins can do everything.
const RANK: Record<Role, number> = { agent: 1, manager: 2, admin: 3 };

/** Parses DEMO_TOKENS ("token:userId:role,...") once at startup. */
export function loadDemoUsers(raw = config.DEMO_TOKENS): Map<string, AuthUser> {
  const users = new Map<string, AuthUser>();
  for (const entry of raw.split(',').map((s) => s.trim()).filter(Boolean)) {
    const [token, userId, role] = entry.split(':');
    if (!token || !userId || !['agent', 'manager', 'admin'].includes(role)) {
      throw new Error(`Invalid DEMO_TOKENS entry: "${entry}"`);
    }
    users.set(token, { token, userId, role: role as Role });
  }
  return users;
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: AuthUser;
  }
}

export function makeAuthGuard(users: Map<string, AuthUser>) {
  return function requireRole(minRole: Role) {
    return async (req: FastifyRequest, _reply: FastifyReply) => {
      const header = req.headers.authorization ?? '';
      const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
      const user = token ? users.get(token) : undefined;
      if (!user) throw new AppError('UNAUTHORIZED', 'Missing or invalid bearer token');
      if (RANK[user.role] < RANK[minRole]) {
        throw new AppError('FORBIDDEN', `Requires role '${minRole}' or higher; you are '${user.role}'`);
      }
      req.user = user;
    };
  };
}

export type RequireRole = ReturnType<typeof makeAuthGuard>;
