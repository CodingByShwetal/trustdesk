/**
 * Rule-based detector for instructions aimed at the AI agent.
 * Shared by KB ingestion (quarantine) and the ticket input scan (Phase 3).
 * Rules match intent-bearing phrasing, not bare keywords, so policy text that
 * merely *mentions* injection (e.g. the coupon policy) is not flagged.
 */
export type InjectionRule =
  | 'prompt_injection'
  | 'secret_exfiltration'
  | 'hidden_action'
  | 'verification_bypass'
  | 'policy_override';

export type InjectionHit = { rule: InjectionRule; match: string };

const RULES: Array<{ rule: InjectionRule; pattern: RegExp }> = [
  { rule: 'prompt_injection', pattern: /\bignore\s+(?:all\s+)?(?:previous|prior|above|earlier)\s+(?:instructions|policies|rules)\b/i },
  { rule: 'prompt_injection', pattern: /\bignore\s+all\s+(?:instructions|policies|rules)\b/i },
  { rule: 'prompt_injection', pattern: /\bignore\s+the\s+(?:support\s+)?polic(?:y|ies)\b/i },
  { rule: 'prompt_injection', pattern: /\bsystem\s+override\b/i },
  { rule: 'prompt_injection', pattern: /\byou\s+are\s+now\s+(?:allowed|permitted|authori[sz]ed|a|an)\b/i },
  { rule: 'prompt_injection', pattern: /\battention[^.\n]{0,20}\b(?:assistant|ai|agent|model)\b/i },
  { rule: 'secret_exfiltration', pattern: /\b(?:reveal|print|show|share|output|display|dump)\b[^.\n]{0,40}\b(?:system\s+prompt|hidden\s+(?:prompt|instructions)|api\s+keys?|internal\s+notes|secrets?)\b/i },
  { rule: 'hidden_action', pattern: /\b(?:do\s+not|don't|never)\s+(?:mention|tell|inform|reveal)\b[^.\n]{0,40}\b(?:human|reviewer|supervisor)\b/i },
  { rule: 'hidden_action', pattern: /\b(?:do\s+not|don't|never)\s+mention\s+this\s+(?:document|instruction|note|message)\b/i },
  { rule: 'hidden_action', pattern: /\bhide\s+(?:it|this|that)\b[^.\n]{0,20}\bfrom\b/i },
  { rule: 'verification_bypass', pattern: /\b(?:ignore|skip|bypass|waive)\b[^.\n]{0,20}\b(?:identity|verification|kyc)\b/i },
  { rule: 'policy_override', pattern: /\bapprove\s+(?:every|all)\s+refunds?\b/i },
  { rule: 'policy_override', pattern: /\bthe\s+policy\s+(?:allows\s+it|has\s+changed)\b/i },
];

/** Removes "quoted examples" so documents that cite attack strings are not flagged. */
export function stripQuoted(text: string): string {
  return text.replace(/["“][^"”\n]{1,200}["”]/g, ' ');
}

/**
 * Rules that indicate a document is *instructing the AI*. `verification_bypass`
 * is excluded: policy text legitimately describes customers who ask to skip
 * identity checks (KB-ACCOUNT-001); that phrasing is only suspicious in tickets.
 */
export const KB_RULES: InjectionRule[] = ['prompt_injection', 'secret_exfiltration', 'hidden_action', 'policy_override'];

export function detectInjection(
  text: string,
  opts: { ignoreQuoted?: boolean; rules?: InjectionRule[] } = {},
): InjectionHit[] {
  const haystack = opts.ignoreQuoted ? stripQuoted(text) : text;
  const hits: InjectionHit[] = [];
  for (const { rule, pattern } of RULES) {
    if (opts.rules && !opts.rules.includes(rule)) continue;
    const m = haystack.match(pattern);
    if (m) hits.push({ rule, match: m[0] });
  }
  return hits;
}
