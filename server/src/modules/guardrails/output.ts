import { CANARY_TOKEN } from '../ai/prompts.js';
import type { DraftOutput } from '../ai/schemas.js';

export type Violation = {
  rule: string;
  detail: string;
  /** repairable → one retry with feedback; critical → straight to the safe fallback */
  severity: 'repairable' | 'critical';
};

export const FORBIDDEN_PROMISES: Array<[string, RegExp]> = [
  ['refund_already_done', /\b(?:has|have)\s+been\s+refunded\b|\brefund\s+(?:has|have)\s+been\s+(?:issued|processed|completed|approved)\b/i],
  ['instant_remedy', /\b(?:instant|immediate)\s+(?:refund|replacement)\b|\brefund(?:ed)?\s+(?:immediately|instantly|right away)\b/i],
  ['action_already_taken', /\b(?:i|we)\s*(?:have|'ve)?\s+(?:issued|processed|approved|created|sent)\s+(?:a|an|your|the)\s+(?:refund|coupon|voucher|replacement)\b/i],
  ['coupon_issued', /\b(?:coupon|voucher)(?:\s+code)?\s+(?:has\s+been|is|was)\s+(?:issued|created|applied)\b/i],
  ['account_changed', /\b(?:i|we)\s*(?:have|'ve)?\s+(?:changed|updated|reset)\s+your\s+(?:email|password|account)\b/i],
];

export const SECRET_PATTERNS: Array<[string, RegExp]> = [
  ['google_api_key', /\bAIza[0-9A-Za-z_-]{20,}\b/],
  ['generic_secret_key', /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}\b/],
  ['bearer_token', /\bbearer\s+[A-Za-z0-9._-]{12,}\b/i],
  ['demo_token', /\b[a-z]+-demo-token\b/i],
];

// Phrases that only appear if the model is echoing its own instructions.
export const PROMPT_ECHOES = /SECURITY RULES|GROUNDING RULES|untrusted_customer_message|SYSTEM-COMPUTED FACTS|AVAILABLE TOOLS:/i;

export function validateDraft(input: {
  draft: DraftOutput;
  allowedDocIds: string[];
  requiredDocIds: string[];
  customerEmail: string;
}): Violation[] {
  const { draft } = input;
  const v: Violation[] = [];
  const body = draft.body;

  // --- Grounding ------------------------------------------------------------
  for (const id of draft.citations) {
    if (!input.allowedDocIds.includes(id)) {
      v.push({ rule: 'invalid_citation', detail: `Cited ${id}, which was not in the retrieved trusted policy set`, severity: 'repairable' });
    }
  }
  for (const id of input.requiredDocIds) {
    if (!draft.citations.includes(id)) {
      v.push({ rule: 'missing_required_citation', detail: `Governing policy ${id} must be cited`, severity: 'repairable' });
    }
  }
  if (/\bKB-[A-Z]+-\d{3}\b/.test(body)) {
    v.push({ rule: 'doc_id_in_reply', detail: 'Internal doc ids must not appear in the customer-facing text', severity: 'repairable' });
  }

  // --- Unsafe promises -----------------------------------------------------
  for (const [rule, re] of FORBIDDEN_PROMISES) {
    const m = body.match(re);
    if (m) v.push({ rule: `forbidden_promise:${rule}`, detail: `"${m[0]}" promises an outcome only humans can approve`, severity: 'repairable' });
  }

  // --- Leakage (critical) ----------------------------------------------------
  if (body.includes(CANARY_TOKEN) || JSON.stringify(draft).includes(CANARY_TOKEN)) {
    v.push({ rule: 'system_prompt_leak', detail: 'Output contains the system-prompt canary token', severity: 'critical' });
  }
  if (PROMPT_ECHOES.test(body)) {
    v.push({ rule: 'system_prompt_leak', detail: 'Output echoes internal prompt sections', severity: 'critical' });
  }
  for (const [rule, re] of SECRET_PATTERNS) {
    if (re.test(body)) v.push({ rule: `secret_leak:${rule}`, detail: 'Output contains a credential-like string', severity: 'critical' });
  }
  const emails = body.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) ?? [];
  for (const email of emails) {
    if (email.toLowerCase() !== input.customerEmail.toLowerCase()) {
      v.push({ rule: 'pii_leak:email', detail: 'Output contains an email address other than the customer’s own', severity: 'critical' });
      break;
    }
  }
  if (/\b(?:\d[ -]?){13,19}\b/.test(body)) {
    v.push({ rule: 'pii_leak:card_number', detail: 'Output contains a card-number-like sequence', severity: 'critical' });
  }

  return v;
}

/** Safe reply used when the model output cannot be trusted. */
export function fallbackDraft(firstName: string, citations: string[]): DraftOutput {
  return {
    body: `Hi ${firstName},\n\nThank you for contacting us. I've passed your request to a support specialist, who will review it against our policies and get back to you shortly.\n\nBest regards,\nTrustDesk Support`,
    citations,
    proposed_actions: [{ tool_name: 'escalate_to_human', reason: 'Automated draft failed safety validation; human review required.' }],
    needs_escalation: true,
    escalation_reason: 'Automated draft failed safety validation',
    unsafe_instructions_detected: false,
    unsupported_claims: [],
  };
}
