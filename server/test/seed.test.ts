import { beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { db, resetDb } from './helpers.js';
import { seedDatabase } from '../src/db/seed.js';
import { kbDocuments, tickets } from '../src/db/schema.js';

describe('seedDatabase', () => {
  let summary: Awaited<ReturnType<typeof resetDb>>;

  beforeAll(async () => {
    summary = await resetDb();
  });

  it('loads every starter-pack entity with original document IDs', () => {
    expect(summary).toMatchObject({ customers: 6, orders: 6, tickets: 8, tools: 6, evalCases: 8 });
    expect(summary.documents.map((d) => d.docId).sort()).toEqual([
      'KB-ACCOUNT-001',
      'KB-ADVERSARIAL-001',
      'KB-BILLING-001',
      'KB-COUPON-001',
      'KB-REFUND-001',
      'KB-SECURITY-001',
      'KB-SHIPPING-001',
      'KB-WARRANTY-001',
    ]);
  });

  it('quarantines only KB-ADVERSARIAL-001, with a reason', async () => {
    const rows = await db.select().from(kbDocuments).where(eq(kbDocuments.trustStatus, 'quarantined'));
    expect(rows.map((r) => r.docId)).toEqual(['KB-ADVERSARIAL-001']);
    expect(rows[0].quarantineReason).toMatch(/prompt_injection/);
  });

  it('keeps expected labels out of the tickets table', async () => {
    const cols = await db.execute(sql`SELECT column_name FROM information_schema.columns WHERE table_name = 'tickets'`);
    const names = cols.rows.map((r) => String(r.column_name));
    expect(names.filter((n) => n.startsWith('expected'))).toEqual([]);
  });

  it('preserves ticket timestamps including their timezone offset', async () => {
    const [t] = await db.select().from(tickets).where(eq(tickets.ticketId, 'tkt_9001'));
    expect(t.createdAt.toISOString()).toBe('2026-06-28T04:45:00.000Z'); // 10:15 +05:30
  });

  it('is idempotent and never overwrites stored triage or the original body', async () => {
    const triage = {
      category: 'refund',
      priority: 'medium',
      sentiment: 'frustrated',
      should_escalate: false,
      reason_summary: 'x',
      run_id: 'run_x',
    };
    await db.update(tickets).set({ triage }).where(eq(tickets.ticketId, 'tkt_9001'));

    const again = await seedDatabase(db);
    expect(again.tickets).toBe(8);

    const [t] = await db.select().from(tickets).where(eq(tickets.ticketId, 'tkt_9001'));
    expect(t.triage).toEqual(triage);
    expect(t.body).toMatch(/left earbud cracked/);

    const counts = await db.execute(
      sql`SELECT (SELECT count(*) FROM tickets)::int AS t, (SELECT count(*) FROM kb_chunks)::int AS c`,
    );
    expect(counts.rows[0]).toEqual({ t: 8, c: 25 });
  });
});
