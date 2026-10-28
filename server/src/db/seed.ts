import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { config } from '../config.js';
import type { DB } from './client.js';
import {
  customers,
  evalCases,
  orders,
  ticketExpectedLabels,
  tickets,
  tools,
} from './schema.js';
import { ingestDocument, type IngestResult } from '../modules/knowledge/ingest.js';

// --- Schemas for the starter-pack files (fail fast on malformed data) -------

const CustomerFile = z.array(
  z.object({
    customer_id: z.string(),
    name: z.string(),
    email: z.string().email(),
    tier: z.string(),
    country: z.string(),
    created_at: z.string(),
    verified: z.boolean(),
    tags: z.array(z.string()),
  }),
);

const OrderFile = z.array(
  z.object({
    order_id: z.string(),
    customer_id: z.string(),
    status: z.string(),
    placed_at: z.string(),
    delivered_at: z.string().nullable(),
    eligible_return_until: z.string().nullable(),
    total: z.number(),
    currency: z.string(),
    payment_status: z.string(),
    tracking_number: z.string().nullable(),
    items: z.array(
      z.object({ sku: z.string(), name: z.string(), quantity: z.number(), category: z.string(), final_sale: z.boolean() }),
    ),
  }),
);

const TicketFile = z.array(
  z.object({
    ticket_id: z.string(),
    customer_id: z.string(),
    order_id: z.string().nullable(),
    channel: z.string(),
    subject: z.string(),
    body: z.string(),
    created_at: z.string(),
    status: z.string(),
    expected_category: z.string(),
    expected_priority: z.string(),
    expected_sentiment: z.string(),
    expected_escalation: z.boolean(),
    expected_actions: z.array(z.string()),
  }),
);

const ToolFile = z.array(
  z.object({
    tool_name: z.string(),
    description: z.string(),
    risk_level: z.string(),
    requires_human_approval: z.boolean(),
    allowed_categories: z.array(z.string()),
    required_fields: z.array(z.string()),
    max_amount_inr: z.number().optional(),
  }),
);

const EvalCaseLine = z.object({
  case_id: z.string(),
  ticket_id: z.string(),
  input: z.string(),
  expected: z.object({
    category: z.string().optional(),
    priority: z.string().optional(),
    must_cite_doc_ids: z.array(z.string()).optional(),
    allowed_actions: z.array(z.string()).optional(),
    disallowed_actions: z.array(z.string()).optional(),
    should_escalate: z.boolean().optional(),
    answer_requirements: z.array(z.string()).optional(),
  }),
});

async function readJson<T>(dataDir: string, file: string, schema: z.ZodType<T>): Promise<T> {
  const raw = await fs.readFile(path.join(dataDir, file), 'utf8');
  return schema.parse(JSON.parse(raw));
}

export type SeedSummary = {
  customers: number;
  orders: number;
  tickets: number;
  tools: number;
  evalCases: number;
  documents: IngestResult[];
};

/**
 * Loads the starter pack into Postgres. Safe to run repeatedly:
 * reference data is upserted; tickets are insert-only so the original
 * customer message and any stored triage are never overwritten.
 */
export async function seedDatabase(db: DB, dataDir = config.DATA_DIR): Promise<SeedSummary> {
  const customerRows = await readJson(dataDir, 'customers.json', CustomerFile);
  const orderRows = await readJson(dataDir, 'orders.json', OrderFile);
  const ticketRows = await readJson(dataDir, 'tickets.json', TicketFile);
  const toolRows = await readJson(dataDir, 'tool_actions.json', ToolFile);
  const evalRaw = await fs.readFile(path.join(dataDir, 'eval_cases.jsonl'), 'utf8');
  const evalRows = evalRaw
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => EvalCaseLine.parse(JSON.parse(l)));

  await db.transaction(async (tx) => {
    for (const c of customerRows) {
      const v = {
        customerId: c.customer_id,
        name: c.name,
        email: c.email,
        tier: c.tier,
        country: c.country,
        createdAt: c.created_at,
        verified: c.verified,
        tags: c.tags,
      };
      await tx.insert(customers).values(v).onConflictDoUpdate({ target: customers.customerId, set: v });
    }
    for (const o of orderRows) {
      const v = {
        orderId: o.order_id,
        customerId: o.customer_id,
        status: o.status,
        placedAt: o.placed_at,
        deliveredAt: o.delivered_at,
        eligibleReturnUntil: o.eligible_return_until,
        total: o.total,
        currency: o.currency,
        paymentStatus: o.payment_status,
        trackingNumber: o.tracking_number,
        items: o.items,
      };
      await tx.insert(orders).values(v).onConflictDoUpdate({ target: orders.orderId, set: v });
    }
    for (const t of ticketRows) {
      await tx
        .insert(tickets)
        .values({
          ticketId: t.ticket_id,
          customerId: t.customer_id,
          orderId: t.order_id,
          channel: t.channel,
          subject: t.subject,
          body: t.body,
          createdAt: new Date(t.created_at),
          status: t.status,
        })
        .onConflictDoNothing({ target: tickets.ticketId });
      const expected = {
        category: t.expected_category,
        priority: t.expected_priority,
        sentiment: t.expected_sentiment,
        escalation: t.expected_escalation,
        actions: t.expected_actions,
      };
      await tx
        .insert(ticketExpectedLabels)
        .values({ ticketId: t.ticket_id, expected })
        .onConflictDoUpdate({ target: ticketExpectedLabels.ticketId, set: { expected } });
    }
    for (const t of toolRows) {
      const v = {
        toolName: t.tool_name,
        description: t.description,
        riskLevel: t.risk_level,
        requiresHumanApproval: t.requires_human_approval,
        allowedCategories: t.allowed_categories,
        requiredFields: t.required_fields,
        maxAmountInr: t.max_amount_inr ?? null,
      };
      await tx.insert(tools).values(v).onConflictDoUpdate({ target: tools.toolName, set: v });
    }
    for (const e of evalRows) {
      const v = { caseId: e.case_id, ticketId: e.ticket_id, input: e.input, expected: e.expected };
      await tx.insert(evalCases).values(v).onConflictDoUpdate({ target: evalCases.caseId, set: v });
    }
  });

  const kbDir = path.join(dataDir, 'knowledge_base');
  const files = (await fs.readdir(kbDir)).filter((f) => f.endsWith('.md')).sort();
  const documents: IngestResult[] = [];
  for (const file of files) {
    const content = await fs.readFile(path.join(kbDir, file), 'utf8');
    documents.push(await ingestDocument(db, { content, sourcePath: `data/knowledge_base/${file}` }));
  }

  return {
    customers: customerRows.length,
    orders: orderRows.length,
    tickets: ticketRows.length,
    tools: toolRows.length,
    evalCases: evalRows.length,
    documents,
  };
}

/** Test helper: wipe all rows (keeps schema). */
export async function truncateAll(db: DB): Promise<void> {
  await db.execute(sql`TRUNCATE replacement_orders, refund_reviews, approvals, tool_actions, drafts, agent_runs,
    eval_runs, eval_cases, ticket_expected_labels, tickets, orders, customers, tools, kb_chunks, kb_documents CASCADE`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const { db, closeDb } = await import('./client.js');
  const { runMigrations } = await import('./migrate.js');
  try {
    await runMigrations();
    const summary = await seedDatabase(db);
    console.log(
      `Seeded ${summary.customers} customers, ${summary.orders} orders, ${summary.tickets} tickets, ` +
        `${summary.tools} tools, ${summary.evalCases} eval cases, ${summary.documents.length} KB docs`,
    );
    for (const d of summary.documents) {
      console.log(`  ${d.docId.padEnd(20)} ${d.trustStatus.padEnd(12)} ${d.chunks} chunks${d.quarantineReason ? `  ← ${d.quarantineReason}` : ''}`);
    }
  } catch (err) {
    console.error(err);
    process.exitCode = 1;
  } finally {
    await closeDb();
  }
}
