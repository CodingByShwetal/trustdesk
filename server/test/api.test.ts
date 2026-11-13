import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { auth, makeApp, resetDb } from './helpers.js';
import { loadDemoUsers, makeAuthGuard } from '../src/api/auth.js';

let app: FastifyInstance;

beforeAll(async () => {
  await resetDb();
  app = await makeApp();
});

afterAll(async () => {
  await app.close();
});

describe('health and auth', () => {
  it('reports health without a token', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it('rejects missing, wrong or malformed bearer tokens', async () => {
    for (const headers of [{}, { authorization: 'Bearer wrong' }, { authorization: 'agent-demo-token' }]) {
      const res = await app.inject({ method: 'GET', url: '/api/tickets', headers });
      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe('UNAUTHORIZED');
    }
  });

  it('logs in with the demo password and returns the role token', async () => {
    const ok = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'manager', password: 'trustdesk' },
    });
    expect(ok.json()).toEqual({ token: 'manager-demo-token', user_id: 'mgr_rohan', role: 'manager' });

    const bad = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'manager', password: 'nope' },
    });
    expect(bad.statusCode).toBe(401);
  });

  it('enforces role rank: agent < manager < admin', async () => {
    const managerOnly = makeAuthGuard(loadDemoUsers())('manager');
    const req = (token: string) => ({ headers: { authorization: `Bearer ${token}` } }) as never;
    await expect(managerOnly(req('agent-demo-token'), {} as never)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(managerOnly(req('manager-demo-token'), {} as never)).resolves.toBeUndefined();
    await expect(managerOnly(req('admin-demo-token'), {} as never)).resolves.toBeUndefined();
  });
});

describe('tickets API', () => {
  it('lists all seed tickets without expected labels', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/tickets', headers: auth('agent') });
    expect(res.statusCode).toBe(200);
    const { tickets } = res.json();
    expect(tickets).toHaveLength(8);
    expect(tickets[0]).toMatchObject({ ticket_id: 'tkt_9001', customer_name: 'Aisha Rao', triage: null });
    expect(JSON.stringify(tickets)).not.toMatch(/expected_/);
  });

  it('returns a ticket with linked customer and order context', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/tickets/tkt_9004', headers: auth('agent') });
    expect(res.statusCode).toBe(200);
    const t = res.json();
    expect(t.customer).toMatchObject({ customer_id: 'cus_1005', tier: 'gold', verified: true });
    expect(t.order).toMatchObject({ order_id: 'ord_5005', delivered_at: '2025-06-05' });
    expect(t.order.items[0]).toMatchObject({ sku: 'BG-TAB-10', final_sale: false });
    expect(t).toMatchObject({ drafts: [], tool_actions: [], runs: [] });
  });

  it('returns NOT_FOUND for unknown tickets', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/tickets/tkt_missing', headers: auth('agent') });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });

  it('creates a ticket and checks the order belongs to the customer', async () => {
    const ok = await app.inject({
      method: 'POST',
      url: '/api/tickets',
      headers: auth('agent'),
      payload: { customer_id: 'cus_1002', order_id: 'ord_5002', channel: 'chat', subject: 'Any update?', body: 'Still waiting.' },
    });
    expect(ok.statusCode).toBe(201);
    expect(ok.json()).toMatchObject({ customer_id: 'cus_1002', status: 'open', body: 'Still waiting.' });

    const wrongOwner = await app.inject({
      method: 'POST',
      url: '/api/tickets',
      headers: auth('agent'),
      payload: { customer_id: 'cus_1001', order_id: 'ord_5002', channel: 'chat', subject: 'x', body: 'y' },
    });
    expect(wrongOwner.statusCode).toBe(400);
    expect(wrongOwner.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('returns field-level validation errors', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/tickets', headers: auth('agent'), payload: { channel: 'fax' } });
    expect(res.statusCode).toBe(400);
    const fields = res.json().error.details.map((d: { field: string }) => d.field);
    expect(fields).toEqual(expect.arrayContaining(['customer_id', 'channel', 'subject', 'body']));
  });

  it('returns a JSON 404 for unknown routes', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/nope', headers: auth('agent') });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });
});

describe('web console hosting', () => {
  it('serves the SPA for non-API routes and keeps JSON 404s for the API', async () => {
    const fs = await import('node:fs');
    const dir = '/tmp/trustdesk-test-web';
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(`${dir}/index.html`, '<!doctype html><title>TrustDesk</title>');
    const { buildApp } = await import('../src/app.js');
    const { db } = await import('./helpers.js');
    const web = await buildApp({ db, webDir: dir });
    const page = await web.inject({ method: 'GET', url: '/approvals' });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('<title>TrustDesk</title>');
    const api404 = await web.inject({ method: 'GET', url: '/api/nope', headers: { authorization: 'Bearer agent-demo-token' } });
    expect(api404.json().error.code).toBe('NOT_FOUND');
    await web.close();
  });
});
