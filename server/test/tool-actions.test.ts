import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq, sql } from 'drizzle-orm';
import { auth, db, resetDb } from './helpers.js';
import { buildApp } from '../src/app.js';
import { replacementOrders, tickets, toolActions } from '../src/db/schema.js';
import { MockProvider } from '../src/modules/ai/mock.js';
import { executeAction } from '../src/modules/tools/service.js';
import { defaultExecutors } from '../src/modules/tools/executors.js';

let app: FastifyInstance;
type Json = Record<string, any>;

const post = (url: string, role: 'agent' | 'manager' | 'admin', payload?: unknown) =>
  app.inject({ method: 'POST', url, headers: auth(role), payload: payload as Json });

async function draftFor(ticketId: string): Promise<Json> {
  return (await post(`/api/tickets/${ticketId}/draft-reply`, 'agent')).json();
}

async function replacementCount(): Promise<number> {
  const r = await db.execute(sql`SELECT count(*)::int AS n FROM replacement_orders`);
  return Number(r.rows[0].n);
}

/** Requests the action the AI recommended for a ticket. */
async function requestRecommended(ticketId: string, toolName: string) {
  const draft = await draftFor(ticketId);
  const rec = draft.recommended_actions.find((a: Json) => a.tool_name === toolName);
  expect(rec, `${toolName} should be recommended for ${ticketId}`).toBeTruthy();
  return post('/api/tool-actions', 'agent', { ticket_id: ticketId, tool_name: toolName, payload: rec.payload, run_id: draft.run_id });
}

beforeAll(async () => {
  await resetDb();
  app = await buildApp({ db, llm: new MockProvider() });
});

afterAll(async () => {
  await app.close();
});

describe('approval-gated replacement (tkt_9001)', () => {
  let actionId: string;

  it('turns the AI recommendation into an action that awaits approval', async () => {
    const res = await requestRecommended('tkt_9001', 'create_replacement_order');
    expect(res.statusCode).toBe(201);
    const a = res.json();
    expect(a).toMatchObject({
      tool_name: 'create_replacement_order',
      status: 'approval_required',
      requires_human_approval: true,
      requested_by: 'agent_priya',
      idempotent_replay: false,
      payload: { order_id: 'ord_5001', sku: 'BG-AIRPODS-01' },
    });
    expect(a.run_id).toMatch(/^run_/);
    actionId = a.action_id;
  });

  it('cannot be executed before approval, even by a manager', async () => {
    const res = await post(`/api/tool-actions/${actionId}/execute`, 'manager');
    expect(res.statusCode).toBe(409);
    expect(await replacementCount()).toBe(0);
  });

  it('cannot be approved by an agent', async () => {
    const res = await post(`/api/tool-actions/${actionId}/approve`, 'agent', { reason: 'looks fine' });
    expect(res.statusCode).toBe(403);
  });

  it('requires a reason for the audit log', async () => {
    const res = await post(`/api/tool-actions/${actionId}/approve`, 'manager', { decision: 'approved' });
    expect(res.statusCode).toBe(400);
  });

  it('is approved by a manager, with an audit record', async () => {
    const res = await post(`/api/tool-actions/${actionId}/approve`, 'manager', { decision: 'approved', reason: 'Photo confirms crack; within return window' });
    expect(res.json()).toMatchObject({ status: 'approved', idempotent_replay: false });
    const again = await post(`/api/tool-actions/${actionId}/approve`, 'manager', { decision: 'approved', reason: 'double click' });
    expect(again.json()).toMatchObject({ status: 'approved', idempotent_replay: true });
    const detail = (await app.inject({ method: 'GET', url: `/api/tool-actions/${actionId}`, headers: auth('agent') })).json();
    expect(detail.approvals).toHaveLength(1);
    expect(detail.approvals[0]).toMatchObject({ reviewer_id: 'mgr_rohan', decision: 'approved', reason: 'Photo confirms crack; within return window' });
  });

  it('cannot be executed by an agent', async () => {
    expect((await post(`/api/tool-actions/${actionId}/execute`, 'agent')).statusCode).toBe(403);
  });

  it('executes once; retries return the stored result without a second replacement', async () => {
    const first = (await post(`/api/tool-actions/${actionId}/execute`, 'manager')).json();
    expect(first).toMatchObject({ status: 'executed', idempotent_replay: false, result: { status: 'replacement_created', order_id: 'ord_5001', executed_by: 'mgr_rohan' } });
    const retry = (await post(`/api/tool-actions/${actionId}/execute`, 'manager')).json();
    expect(retry).toMatchObject({ status: 'executed', idempotent_replay: true });
    expect(retry.result.replacement_id).toBe(first.result.replacement_id);
    expect(await replacementCount()).toBe(1);
  });

  it('replays the same request instead of creating a duplicate action', async () => {
    const res = await requestRecommended('tkt_9001', 'create_replacement_order');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ action_id: actionId, status: 'executed', idempotent_replay: true });
  });
});

describe('idempotency keys', () => {
  const base = { ticket_id: 'tkt_9008', tool_name: 'start_refund_review' };
  const payload = { order_id: 'ord_5006', amount: 15999, reason: 'Duplicate charge', idempotency_key: 'tkt_9008-refund-1' };

  beforeAll(async () => {
    await post('/api/tickets/tkt_9008/triage', 'agent');
  });

  it('returns the existing action for a repeated key and payload', async () => {
    const a = await post('/api/tool-actions', 'agent', { ...base, payload });
    const b = await post('/api/tool-actions', 'agent', { ...base, payload });
    expect([a.statusCode, b.statusCode]).toEqual([201, 200]);
    expect(b.json().action_id).toBe(a.json().action_id);
  });

  it('rejects a reused key with a different payload (409)', async () => {
    const res = await post('/api/tool-actions', 'agent', { ...base, payload: { ...payload, amount: 100 } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.details.existing_action_id).toMatch(/^act_/);
  });

  it('derives a stable key when the client omits one', async () => {
    const { idempotency_key: _k, ...noKey } = payload;
    const a = (await post('/api/tool-actions', 'agent', { ...base, payload: { ...noKey, amount: 500 } })).json();
    const b = (await post('/api/tool-actions', 'agent', { ...base, payload: { ...noKey, amount: 500, reason: 'reworded' } })).json();
    expect(a.idempotency_key).toMatch(/^tkt_9008:start_refund_review:[0-9a-f]{12}$/);
    expect(b).toMatchObject({ action_id: a.action_id, idempotent_replay: true });
  });

  it('creates exactly one action under concurrent identical requests', async () => {
    const p = { ...payload, amount: 777, idempotency_key: 'tkt_9008-concurrent' };
    const results = await Promise.all(Array.from({ length: 6 }, () => post('/api/tool-actions', 'agent', { ...base, payload: p })));
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 200, 200, 200, 200, 201]);
    expect(new Set(results.map((r) => r.json().action_id)).size).toBe(1);
    const rows = await db.select().from(toolActions).where(eq(toolActions.idempotencyKey, 'tkt_9008-concurrent'));
    expect(rows).toHaveLength(1);
  });
});

describe('concurrent execution', () => {
  it('produces exactly one side effect when executed in parallel', async () => {
    // Fresh order line so this test has its own replacement.
    await db.update(tickets).set({ triage: null }).where(eq(tickets.ticketId, 'tkt_9001'));
    const req = await post('/api/tickets/tkt_9001/triage', 'agent');
    expect(req.statusCode).toBe(200);
    const created = (
      await post('/api/tool-actions', 'agent', {
        ticket_id: 'tkt_9001',
        tool_name: 'create_replacement_order',
        payload: { order_id: 'ord_5001', sku: 'BG-AIRPODS-01', reason: 'Second unit damaged', idempotency_key: 'tkt_9001-race' },
      })
    ).json();
    await post(`/api/tool-actions/${created.action_id}/approve`, 'manager', { reason: 'ok to replace' });
    const before = await replacementCount();

    const runs = await Promise.all(Array.from({ length: 8 }, () => post(`/api/tool-actions/${created.action_id}/execute`, 'manager')));
    expect(runs.every((r) => r.statusCode === 200)).toBe(true);
    const bodies = runs.map((r) => r.json());
    expect(bodies.filter((b) => !b.idempotent_replay)).toHaveLength(1);
    expect(new Set(bodies.map((b) => b.result.replacement_id)).size).toBe(1);
    expect(await replacementCount()).toBe(before + 1);
  });
});

describe('request validation', () => {
  beforeAll(async () => {
    for (const t of ['tkt_9006', 'tkt_9003']) await post(`/api/tickets/${t}/triage`, 'agent');
  });

  const expectInvalid = async (body: Json, pattern: RegExp, code = 400) => {
    const res = await post('/api/tool-actions', 'agent', body);
    expect(res.statusCode).toBe(code);
    expect(JSON.stringify(res.json().error)).toMatch(pattern);
  };

  it('rejects unknown tools and untriaged tickets', async () => {
    await expectInvalid({ ticket_id: 'tkt_9001', tool_name: 'wire_money', payload: {} }, /Unknown tool/);
    const fresh = (await post('/api/tickets', 'agent', { customer_id: 'cus_1002', order_id: 'ord_5002', channel: 'chat', subject: 'Hi', body: 'Where is it?' })).json();
    await expectInvalid({ ticket_id: fresh.ticket_id, tool_name: 'escalate_to_human', payload: { ticket_id: fresh.ticket_id, reason: 'x', queue: 'q' } }, /triaged/);
  });

  it('enforces the catalog category rules', async () => {
    await expectInvalid(
      { ticket_id: 'tkt_9008', tool_name: 'create_replacement_order', payload: { order_id: 'ord_5006', sku: 'BG-WATCH-01', reason: 'x' } },
      /not allowed for category 'billing'/,
    );
  });

  it('lists every missing required field', async () => {
    const res = await post('/api/tool-actions', 'agent', { ticket_id: 'tkt_9008', tool_name: 'start_refund_review', payload: { reason: 'x' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.details.map((d: Json) => d.field)).toEqual(['payload.order_id', 'payload.amount']);
  });

  it("refuses payloads that point at another customer's records", async () => {
    await expectInvalid({ ticket_id: 'tkt_9008', tool_name: 'start_refund_review', payload: { order_id: 'ord_5001', amount: 100, reason: 'x' } }, /ticket's order/);
    await expectInvalid({ ticket_id: 'tkt_9008', tool_name: 'start_refund_review', payload: { order_id: 'ord_5006', amount: 999999, reason: 'x' } }, /order total/);
  });

  it('caps coupons at INR 1000 even for human requests (tkt_9006)', async () => {
    await expectInvalid(
      { ticket_id: 'tkt_9006', tool_name: 'issue_coupon', payload: { customer_id: 'cus_1006', amount: 5000, reason: 'customer asked' } },
      /limited to INR 1000/,
    );
  });

  it('rejects a run_id from a different ticket', async () => {
    const draft = await draftFor('tkt_9003');
    await expectInvalid(
      { ticket_id: 'tkt_9008', tool_name: 'start_refund_review', run_id: draft.run_id, payload: { order_id: 'ord_5006', amount: 10, reason: 'x' } },
      /does not belong/,
    );
  });
});

describe('rejection and low-risk actions', () => {
  it('a rejected action can never be executed or re-approved', async () => {
    const a = (
      await post('/api/tool-actions', 'agent', {
        ticket_id: 'tkt_9008',
        tool_name: 'start_refund_review',
        payload: { order_id: 'ord_5006', amount: 15999, reason: 'Dup', idempotency_key: 'tkt_9008-reject-me' },
      })
    ).json();
    const rej = await post(`/api/tool-actions/${a.action_id}/approve`, 'manager', { decision: 'rejected', reason: 'Payment ops found no duplicate' });
    expect(rej.json().status).toBe('rejected');
    expect((await post(`/api/tool-actions/${a.action_id}/execute`, 'manager')).statusCode).toBe(409);
    expect((await post(`/api/tool-actions/${a.action_id}/approve`, 'manager', { reason: 'changed my mind' })).statusCode).toBe(409);
  });

  it('low-risk escalation needs no approval and an agent can execute it (tkt_9006)', async () => {
    const draft = await draftFor('tkt_9006');
    const rec = draft.recommended_actions.find((r: Json) => r.tool_name === 'escalate_to_human');
    const a = (await post('/api/tool-actions', 'agent', { ticket_id: 'tkt_9006', tool_name: 'escalate_to_human', payload: rec.payload })).json();
    expect(a).toMatchObject({ status: 'requested', requires_human_approval: false });
    expect((await post(`/api/tool-actions/${a.action_id}/approve`, 'manager', { reason: 'n/a' })).statusCode).toBe(400);
    const done = (await post(`/api/tool-actions/${a.action_id}/execute`, 'agent')).json();
    expect(done).toMatchObject({ status: 'executed', result: { queue: 'trust_and_safety', status: 'queued_for_specialist' } });
  });

  it('filters the approval queue by status', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/tool-actions?status=approval_required', headers: auth('manager') });
    expect(res.json().tool_actions.every((a: Json) => a.status === 'approval_required')).toBe(true);
  });
});

describe('execution failure', () => {
  it('rolls back partial side effects, marks the action failed, and allows a retry', async () => {
    await db.update(tickets).set({ triage: null }).where(eq(tickets.ticketId, 'tkt_9001'));
    await post('/api/tickets/tkt_9001/triage', 'agent');
    const a = (
      await post('/api/tool-actions', 'agent', {
        ticket_id: 'tkt_9001',
        tool_name: 'create_replacement_order',
        payload: { order_id: 'ord_5001', sku: 'BG-AIRPODS-01', reason: 'Third time', idempotency_key: 'tkt_9001-flaky' },
      })
    ).json();
    await post(`/api/tool-actions/${a.action_id}/approve`, 'manager', { reason: 'approved' });

    const flaky = {
      ...defaultExecutors,
      create_replacement_order: async (tx: any, action: any) => {
        await defaultExecutors.create_replacement_order(tx, action); // writes the row...
        throw new Error('warehouse API timed out'); // ...then fails
      },
    };
    await expect(executeAction(db, { actionId: a.action_id, actorId: 'mgr_rohan', actorRole: 'manager' }, flaky)).rejects.toMatchObject({
      code: 'TOOL_EXECUTION_FAILED',
    });
    const [failed] = await db.select().from(toolActions).where(eq(toolActions.actionId, a.action_id));
    expect(failed).toMatchObject({ status: 'failed', error: 'warehouse API timed out' });
    expect(await db.select().from(replacementOrders).where(eq(replacementOrders.idempotencyKey, 'tkt_9001-flaky'))).toEqual([]);

    const retry = (await post(`/api/tool-actions/${a.action_id}/execute`, 'manager')).json();
    expect(retry).toMatchObject({ status: 'executed', error: null });
    expect(await db.select().from(replacementOrders).where(eq(replacementOrders.idempotencyKey, 'tkt_9001-flaky'))).toHaveLength(1);
  });
});
