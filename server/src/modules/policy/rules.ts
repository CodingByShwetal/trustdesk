import type { TriageOutput } from '../ai/schemas.js';
import { PRIORITIES } from '../ai/schemas.js';
import type { InjectionHit } from '../guardrails/injection.js';
import type { PolicyFacts } from './facts.js';

export type AppliedRule = { rule: string; change: string; doc_id: string };

type Priority = (typeof PRIORITIES)[number];
const atLeast = (current: Priority, floor: Priority): Priority =>
  PRIORITIES.indexOf(current) >= PRIORITIES.indexOf(floor) ? current : floor;

/**
 * Deterministic triage overrides where the KB is explicit. The model's answer
 * stands unless a rule applies; rules can only make an outcome safer
 * (raise priority, force escalation), never weaken it.
 */
export function applyTriageRules(
  model: TriageOutput,
  facts: PolicyFacts,
  flags: InjectionHit[],
): { triage: TriageOutput; applied: AppliedRule[] } {
  const t = { ...model };
  const applied: AppliedRule[] = [];
  const raise = (floor: Priority, rule: string, docId: string) => {
    const next = atLeast(t.priority, floor);
    if (next !== t.priority) {
      applied.push({ rule, change: `priority ${t.priority} → ${next}`, doc_id: docId });
      t.priority = next;
    }
  };
  const escalate = (rule: string, docId: string) => {
    if (!t.should_escalate) {
      applied.push({ rule, change: 'should_escalate false → true', doc_id: docId });
      t.should_escalate = true;
    }
  };
  const flagRules = new Set(flags.map((f) => f.rule));

  // KB-WARRANTY-001: safety issues are escalated with urgent priority.
  if (facts.signals.safety_issue.length) {
    raise('urgent', 'safety_issue_urgent', 'KB-WARRANTY-001');
    escalate('safety_issue_escalation', 'KB-WARRANTY-001');
  }

  // KB-ACCOUNT-001: account changes need verified identity; bypass requests escalate.
  if (facts.signals.account_change_requested && (!facts.customer.verified || flagRules.has('verification_bypass'))) {
    if (t.category !== 'account_security') {
      applied.push({ rule: 'account_change_category', change: `category ${t.category} → account_security`, doc_id: 'KB-ACCOUNT-001' });
      t.category = 'account_security';
    }
    raise('high', 'account_change_priority', 'KB-ACCOUNT-001');
    escalate('unverified_account_change', 'KB-ACCOUNT-001');
  }

  // KB-SECURITY-001: manipulation or secret-exfiltration attempts are refused and escalated.
  if (flags.length || model.injection_detected) {
    escalate('manipulation_attempt', 'KB-SECURITY-001');
  }
  if (flagRules.has('secret_exfiltration')) raise('high', 'secret_request_priority', 'KB-SECURITY-001');

  // KB-BILLING-001: duplicate charge reports are high priority.
  if (facts.signals.duplicate_charge_reported) raise('high', 'duplicate_charge_priority', 'KB-BILLING-001');

  // KB-SHIPPING-001: urgent travel or time-sensitive need → high priority.
  if (t.category === 'shipping' && facts.signals.urgent_need) raise('high', 'time_sensitive_shipping', 'KB-SHIPPING-001');

  return { triage: t, applied };
}
