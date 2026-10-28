export type Triage = {
  category: string;
  priority: string;
  sentiment: string;
  should_escalate: boolean;
  reason_summary: string;
  run_id: string;
};

export type TicketSummary = {
  ticket_id: string;
  subject: string;
  body: string;
  channel: string;
  created_at: string;
  status: string;
  customer_name: string;
  customer_tier: string;
  triage: Triage | null;
};

export type ToolAction = {
  action_id: string;
  ticket_id: string;
  run_id: string | null;
  tool_name: string;
  payload: Record<string, unknown>;
  risk_level: string;
  requires_human_approval: boolean;
  status: string;
  idempotency_key: string;
  requested_by: string;
  result: Record<string, unknown> | null;
  error: string | null;
  created_at: string;
  idempotent_replay?: boolean;
  approvals?: Array<{ reviewer_id: string; decision: string; reason: string; created_at: string }>;
};

export type TicketDetail = TicketSummary & {
  customer: { customer_id: string; name: string; email: string; tier: string; verified: boolean; tags: string[] };
  order: {
    order_id: string;
    status: string;
    placed_at: string;
    delivered_at: string | null;
    total: number;
    currency: string;
    tracking_number: string | null;
    items: Array<{ sku: string; name: string; category: string; final_sale: boolean }>;
  } | null;
  drafts: Array<{ draft_id: string; run_id: string | null; body: string; citations: string[]; created_at: string }>;
  tool_actions: ToolAction[];
  runs: Array<{ run_id: string; run_type: string; status: string; created_at: string }>;
};

export type PolicyFacts = {
  reference_date: string;
  timezone: string;
  summary: Array<{ text: string; doc_ids: string[] }>;
};

export type Recommended = {
  tool_name: string;
  reason: string;
  risk_level: string;
  requires_human_approval: boolean;
  payload: Record<string, unknown>;
};

export type DraftResult = {
  draft_id: string;
  ticket_id: string;
  body: string;
  citations: string[];
  should_escalate: boolean;
  escalation_reason: string | null;
  recommended_actions: Recommended[];
  blocked_actions: Array<{ tool_name: string; rule: string; reason: string; doc_id?: string }>;
  guardrail_outcome: 'passed' | 'repaired' | 'fallback';
  guardrail_flags: string[];
  triage: { category: string; priority: string; should_escalate: boolean; run_id: string };
  run_id: string;
};

export type TriageResult = Triage & {
  ticket_id: string;
  guardrail_flags: string[];
  policy_rules_applied: Array<{ rule: string; change: string; doc_id: string }>;
};

export type GuardrailResult = { stage: string; result: string; rules: string[]; detail?: unknown };

export type Trace = {
  run_id: string;
  ticket_id: string;
  run_type: string;
  status: string;
  retrieved_doc_ids: string[];
  tool_calls: Array<Record<string, unknown>>;
  guardrail_results: GuardrailResult[];
  steps: Array<{ name: string; status: string; ms: number; detail?: unknown }>;
  model_provider: string | null;
  model_name: string | null;
  prompt_version: string | null;
  latency_ms: number | null;
  token_usage: { input: number; output: number } | null;
  error: string | null;
  created_at: string;
};

export type EvalMetrics = {
  total_cases: number;
  passed_cases: number;
  category_accuracy: number;
  priority_accuracy: number;
  citation_coverage: number;
  unsafe_action_block_rate: number;
  allowed_action_recall: number;
  escalation_accuracy: number;
  answer_requirement_coverage: number;
  errors: number;
  model?: string | null;
  adversarial: Record<string, { description: string; safe: boolean; passed: boolean }>;
};

export type EvalCaseResult = {
  case_id: string;
  ticket_id: string;
  input: string;
  passed: boolean;
  adversarial: boolean;
  predicted_category: string | null;
  predicted_priority: string | null;
  should_escalate: boolean | null;
  recommended_actions: string[];
  blocked_actions: Array<{ tool_name: string; rule: string }>;
  checks: Record<string, boolean | number>;
  requirements: Array<{ requirement: string; met: boolean | null; note: string }>;
  notes: string;
  draft_run_id: string | null;
  error: string | null;
};

export type EvalRun = {
  eval_run_id: string;
  status: string;
  provider: string;
  started_at: string;
  completed_at: string | null;
  total_cases: number;
  completed_cases: number;
  metrics: EvalMetrics | null;
  error: string | null;
  case_results?: EvalCaseResult[];
};

export type KbDocument = {
  doc_id: string;
  title: string;
  audience: string;
  version: string;
  trust_status: 'trusted' | 'quarantined';
  quarantine_reason: string | null;
};
