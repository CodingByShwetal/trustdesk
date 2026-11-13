import {
  pgTable,
  text,
  boolean,
  integer,
  date,
  timestamp,
  jsonb,
  uniqueIndex,
  index,
  customType,
} from 'drizzle-orm/pg-core';

// tsvector column; populated as a GENERATED column in a custom migration.
const tsvector = customType<{ data: string }>({
  dataType() {
    return 'tsvector';
  },
});

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

// ---------------------------------------------------------------------------
// Seed entities (IDs preserved from data/*.json)
// ---------------------------------------------------------------------------

export const customers = pgTable('customers', {
  customerId: text('customer_id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull(),
  tier: text('tier').notNull(),
  country: text('country').notNull(),
  createdAt: date('created_at', { mode: 'string' }).notNull(),
  verified: boolean('verified').notNull(),
  tags: text('tags').array().notNull().default([]),
});

export type OrderItem = {
  sku: string;
  name: string;
  quantity: number;
  category: string;
  final_sale: boolean;
};

export const orders = pgTable(
  'orders',
  {
    orderId: text('order_id').primaryKey(),
    customerId: text('customer_id')
      .notNull()
      .references(() => customers.customerId),
    status: text('status').notNull(),
    placedAt: date('placed_at', { mode: 'string' }).notNull(),
    deliveredAt: date('delivered_at', { mode: 'string' }),
    eligibleReturnUntil: date('eligible_return_until', { mode: 'string' }),
    total: integer('total').notNull(),
    currency: text('currency').notNull(),
    paymentStatus: text('payment_status').notNull(),
    trackingNumber: text('tracking_number'),
    items: jsonb('items').$type<OrderItem[]>().notNull(),
  },
  (t) => [index('orders_customer_idx').on(t.customerId)],
);

export type TriageResult = {
  category: string;
  priority: string;
  sentiment: string;
  should_escalate: boolean;
  reason_summary: string;
  run_id: string;
};

export const tickets = pgTable(
  'tickets',
  {
    ticketId: text('ticket_id').primaryKey(),
    customerId: text('customer_id')
      .notNull()
      .references(() => customers.customerId),
    orderId: text('order_id').references(() => orders.orderId),
    channel: text('channel').notNull(),
    subject: text('subject').notNull(),
    // Original customer message: never modified after insert (auditability).
    body: text('body').notNull(),
    createdAt: ts('created_at').notNull(),
    status: text('status').notNull().default('open'),
    triage: jsonb('triage').$type<TriageResult>(),
    triagedAt: ts('triaged_at'),
  },
  (t) => [index('tickets_customer_idx').on(t.customerId)],
);

// Expected labels live apart from tickets so the AI path can never read them.
export const ticketExpectedLabels = pgTable('ticket_expected_labels', {
  ticketId: text('ticket_id')
    .primaryKey()
    .references(() => tickets.ticketId),
  expected: jsonb('expected')
    .$type<{
      category: string;
      priority: string;
      sentiment: string;
      escalation: boolean;
      actions: string[];
    }>()
    .notNull(),
});

export type EvalExpected = {
  category?: string;
  priority?: string;
  must_cite_doc_ids?: string[];
  allowed_actions?: string[];
  disallowed_actions?: string[];
  should_escalate?: boolean;
  answer_requirements?: string[];
};

export const evalCases = pgTable('eval_cases', {
  caseId: text('case_id').primaryKey(),
  ticketId: text('ticket_id')
    .notNull()
    .references(() => tickets.ticketId),
  input: text('input').notNull(),
  expected: jsonb('expected').$type<EvalExpected>().notNull(),
});

export const tools = pgTable('tools', {
  toolName: text('tool_name').primaryKey(),
  description: text('description').notNull(),
  riskLevel: text('risk_level').notNull(),
  requiresHumanApproval: boolean('requires_human_approval').notNull(),
  allowedCategories: text('allowed_categories').array().notNull(),
  requiredFields: text('required_fields').array().notNull(),
  maxAmountInr: integer('max_amount_inr'),
});

// ---------------------------------------------------------------------------
// Knowledge base
// ---------------------------------------------------------------------------

export const kbDocuments = pgTable('kb_documents', {
  docId: text('doc_id').primaryKey(),
  title: text('title').notNull(),
  audience: text('audience').notNull(),
  version: text('version').notNull(),
  sourcePath: text('source_path').notNull(),
  content: text('content').notNull(),
  checksum: text('checksum').notNull(),
  // 'trusted' | 'quarantined'. Quarantined docs are never sent to the model or cited.
  trustStatus: text('trust_status').notNull().default('trusted'),
  quarantineReason: text('quarantine_reason'),
  ingestedAt: ts('ingested_at').notNull().defaultNow(),
});

export const kbChunks = pgTable(
  'kb_chunks',
  {
    chunkId: text('chunk_id').primaryKey(),
    docId: text('doc_id')
      .notNull()
      .references(() => kbDocuments.docId, { onDelete: 'cascade' }),
    ordinal: integer('ordinal').notNull(),
    heading: text('heading').notNull(),
    content: text('content').notNull(),
    // GENERATED ALWAYS AS (...) STORED, see the custom migration.
    tsv: tsvector('tsv'),
  },
  (t) => [index('kb_chunks_doc_idx').on(t.docId)],
);

// ---------------------------------------------------------------------------
// AI outputs, actions, approvals, traces
// ---------------------------------------------------------------------------

export const agentRuns = pgTable(
  'agent_runs',
  {
    runId: text('run_id').primaryKey(),
    ticketId: text('ticket_id')
      .notNull()
      .references(() => tickets.ticketId),
    runType: text('run_type').notNull(), // triage | draft_reply | tool_recommendation | eval_case
    status: text('status').notNull(), // running | completed | escalated | blocked | failed
    retrievedDocIds: text('retrieved_doc_ids').array().notNull().default([]),
    toolCalls: jsonb('tool_calls').$type<unknown[]>().notNull().default([]),
    guardrailResults: jsonb('guardrail_results').$type<unknown[]>().notNull().default([]),
    steps: jsonb('steps').$type<unknown[]>().notNull().default([]),
    modelProvider: text('model_provider'),
    modelName: text('model_name'),
    promptVersion: text('prompt_version'),
    latencyMs: integer('latency_ms'),
    tokenUsage: jsonb('token_usage').$type<{ input: number; output: number }>(),
    error: text('error'),
    createdAt: ts('created_at').notNull().defaultNow(),
    completedAt: ts('completed_at'),
  },
  (t) => [index('agent_runs_ticket_idx').on(t.ticketId)],
);

export const drafts = pgTable(
  'drafts',
  {
    draftId: text('draft_id').primaryKey(),
    ticketId: text('ticket_id')
      .notNull()
      .references(() => tickets.ticketId),
    runId: text('run_id').references(() => agentRuns.runId),
    status: text('status').notNull().default('generated'), // generated | edited | approved | rejected | sent
    body: text('body').notNull(),
    citations: text('citations').array().notNull().default([]),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [index('drafts_ticket_idx').on(t.ticketId)],
);

export const toolActions = pgTable(
  'tool_actions',
  {
    actionId: text('action_id').primaryKey(),
    ticketId: text('ticket_id')
      .notNull()
      .references(() => tickets.ticketId),
    runId: text('run_id').references(() => agentRuns.runId),
    toolName: text('tool_name')
      .notNull()
      .references(() => tools.toolName),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    payloadHash: text('payload_hash').notNull(),
    riskLevel: text('risk_level').notNull(),
    requiresHumanApproval: boolean('requires_human_approval').notNull(),
    // requested | approval_required | approved | rejected | executed | failed | cancelled
    status: text('status').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    requestedBy: text('requested_by').notNull(),
    result: jsonb('result').$type<Record<string, unknown>>(),
    error: text('error'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('tool_actions_idem_uq').on(t.toolName, t.idempotencyKey),
    index('tool_actions_ticket_idx').on(t.ticketId),
  ],
);

export const approvals = pgTable('approvals', {
  approvalId: text('approval_id').primaryKey(),
  actionId: text('action_id').references(() => toolActions.actionId),
  draftId: text('draft_id').references(() => drafts.draftId),
  reviewerId: text('reviewer_id').notNull(),
  decision: text('decision').notNull(), // approved | rejected | needs_changes
  reason: text('reason').notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const evalRuns = pgTable('eval_runs', {
  evalRunId: text('eval_run_id').primaryKey(),
  status: text('status').notNull(), // queued | running | completed | failed
  provider: text('provider').notNull(),
  startedAt: ts('started_at').notNull().defaultNow(),
  completedAt: ts('completed_at'),
  totalCases: integer('total_cases').notNull().default(0),
  metrics: jsonb('metrics').$type<Record<string, unknown>>(),
  caseResults: jsonb('case_results').$type<unknown[]>(),
  error: text('error'),
});

// ---------------------------------------------------------------------------
// Mock side-effect tables: what tool execution "did" in the outside world.
// Unique on idempotency key so even a buggy caller cannot duplicate them.
// ---------------------------------------------------------------------------

export const replacementOrders = pgTable('replacement_orders', {
  replacementId: text('replacement_id').primaryKey(),
  actionId: text('action_id')
    .notNull()
    .unique()
    .references(() => toolActions.actionId),
  orderId: text('order_id').notNull(),
  sku: text('sku').notNull(),
  reason: text('reason').notNull(),
  idempotencyKey: text('idempotency_key').notNull().unique(),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const refundReviews = pgTable('refund_reviews', {
  reviewId: text('review_id').primaryKey(),
  actionId: text('action_id')
    .notNull()
    .unique()
    .references(() => toolActions.actionId),
  orderId: text('order_id').notNull(),
  amount: integer('amount').notNull(),
  reason: text('reason').notNull(),
  idempotencyKey: text('idempotency_key').notNull().unique(),
  createdAt: ts('created_at').notNull().defaultNow(),
});
