/**
 * Deterministic signals read from the customer's own words. They never grant
 * anything on their own; Phase 3 policy rules use them to force safer outcomes
 * (e.g. a safety signal always means urgent + escalate, per KB-WARRANTY-001).
 */
export type TicketSignals = {
  safety_issue: string[];
  damage_reported: boolean;
  duplicate_charge_reported: boolean;
  urgent_need: boolean;
  stale_tracking_reported: boolean;
  account_change_requested: boolean;
  refund_requested: boolean;
  replacement_requested: boolean;
  customer_stated_business_days: number | null;
};

// KB-WARRANTY-001 safety list: battery swelling, overheating, burning smell, exposed wires, electric shock.
const SAFETY_TERMS: Array<[string, RegExp]> = [
  ['battery_swelling', /\b(?:swell(?:ing|ed|s)?|swollen|bulg(?:ing|ed))\b/i],
  ['overheating', /\boverheat(?:ing|ed|s)?\b|\btoo hot to (?:touch|hold)\b/i],
  ['burning_smell', /\bburning smell\b|\bsmells? (?:like )?burn(?:ing|t)\b/i],
  ['exposed_wires', /\bexposed wires?\b/i],
  ['electric_shock', /\b(?:electric(?:al)? )?shock(?:ed)?\b/i],
  ['fire_or_smoke', /\b(?:caught fire|on fire|smok(?:e|ing) (?:came|coming)|sparks?)\b/i],
];

const has = (re: RegExp, text: string) => re.test(text);

export function extractSignals(subject: string, body: string): TicketSignals {
  const text = `${subject}\n${body}`;
  const stated = text.match(/\b(\d{1,2})\s+business\s+days?\b/i);
  return {
    safety_issue: SAFETY_TERMS.filter(([, re]) => re.test(text)).map(([name]) => name),
    damage_reported: has(/\b(?:damaged|cracked|broken|shattered|dented|defective|faulty|not working|stopped working|dead on arrival)\b/i, text),
    duplicate_charge_reported: has(/\b(?:double[- ]charged?|charged twice|two charges|duplicate charges?|charged two times)\b/i, text),
    urgent_need: has(/\b(?:travel(?:l?ing)?|trip|flight|next week|tomorrow|urgent(?:ly)?|asap|immediately|quickly)\b/i, text),
    stale_tracking_reported: has(/\b(?:no movement|not moved|hasn'?t moved|has not moved|stuck in transit|tracking (?:hasn'?t|has not) (?:updated|changed))\b/i, text),
    account_change_requested: has(/\b(?:change|update|reset)\b[^.\n]{0,30}\b(?:email|password|address|phone number)\b|\bdelete (?:my )?account\b/i, text),
    refund_requested: has(/\brefund(?:ed|s)?\b|\bmoney back\b/i, text),
    replacement_requested: has(/\breplace(?:ment|d)?\b|\bexchange\b/i, text),
    customer_stated_business_days: stated ? Number(stated[1]) : null,
  };
}
