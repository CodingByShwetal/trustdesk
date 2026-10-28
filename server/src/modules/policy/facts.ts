import type { InferSelectModel } from 'drizzle-orm';
import type { customers, orders, tickets } from '../../db/schema.js';
import {
  addDays,
  addMonths,
  businessDaysBetween,
  dateInTimeZone,
  daysBetween,
  isOnOrBefore,
  monthsBetween,
  type IsoDate,
} from '../../lib/dates.js';
import { NON_RETURNABLE_CATEGORIES, POLICY } from './constants.js';
import { extractSignals, type TicketSignals } from './signals.js';

type Ticket = InferSelectModel<typeof tickets>;
type Customer = InferSelectModel<typeof customers>;
type Order = InferSelectModel<typeof orders>;

export type WarrantyFact = {
  sku: string;
  name: string;
  covered_by_warranty_policy: boolean;
  base_expires: IsoDate | null;
  gold_extension_applied: boolean;
  expires: IsoDate | null;
  months_since_delivery: number | null;
  in_warranty: boolean;
  reason: string;
};

export type PolicyFacts = {
  /** Every window below is measured against this date, never "today". */
  reference_date: IsoDate;
  timezone: string;
  customer: { customer_id: string; tier: string; verified: boolean };
  order: { order_id: string; status: string; delivered_at: IsoDate | null; payment_status: string; total: number; currency: string } | null;
  return_window: {
    applicable: boolean;
    deadline: IsoDate | null;
    days_since_delivery: number | null;
    open: boolean;
    reason: string;
  };
  non_returnable_items: Array<{ sku: string; name: string; reason: string }>;
  warranty: WarrantyFact[];
  shipping: {
    in_transit: boolean;
    estimated_dispatch_date: IsoDate | null;
    business_days_since_dispatch: number | null;
    customer_stated_business_days: number | null;
    carrier_investigation_eligible: boolean;
    lost_package_threshold_met: boolean;
  };
  signals: TicketSignals;
  /** Human-readable facts with the KB docs they come from; shown in the UI and given to the model. */
  summary: Array<{ text: string; doc_ids: string[] }>;
};

const HARDWARE_EXCLUDED = new Set<string>(NON_RETURNABLE_CATEGORIES);

export function computePolicyFacts(input: {
  ticket: Pick<Ticket, 'subject' | 'body' | 'createdAt'>;
  customer: Pick<Customer, 'customerId' | 'tier' | 'verified'>;
  order: Order | null;
  timeZone: string;
}): PolicyFacts {
  const { ticket, customer, order, timeZone } = input;
  const ref = dateInTimeZone(ticket.createdAt, timeZone);
  const signals = extractSignals(ticket.subject, ticket.body);
  const summary: PolicyFacts['summary'] = [];
  const isGold = customer.tier.toLowerCase() === 'gold';

  summary.push({
    text: `Customer ${customer.verified ? 'is identity-verified' : 'is NOT identity-verified'} (tier: ${customer.tier}).`,
    doc_ids: customer.verified ? [] : ['KB-ACCOUNT-001'],
  });

  // ---- Return window -------------------------------------------------------
  let returnWindow: PolicyFacts['return_window'] = {
    applicable: false,
    deadline: null,
    days_since_delivery: null,
    open: false,
    reason: order ? 'Order not delivered yet' : 'No order linked to ticket',
  };
  if (order?.deliveredAt) {
    const deadline = order.eligibleReturnUntil ?? addDays(order.deliveredAt, POLICY.returnWindowDays.value);
    const open = isOnOrBefore(ref, deadline);
    returnWindow = {
      applicable: true,
      deadline,
      days_since_delivery: daysBetween(order.deliveredAt, ref),
      open,
      reason: `Delivered ${order.deliveredAt}; window ${open ? 'open' : 'closed'} on ${ref} (deadline ${deadline})`,
    };
    summary.push({
      text: `Return window is ${open ? 'OPEN' : 'CLOSED'}: delivered ${order.deliveredAt}, ticket raised ${returnWindow.days_since_delivery} days later, deadline ${deadline}.`,
      doc_ids: [POLICY.returnWindowDays.docId],
    });
  }

  // ---- Non-returnable items --------------------------------------------------
  const nonReturnable = (order?.items ?? [])
    .filter((i) => i.final_sale || HARDWARE_EXCLUDED.has(i.category))
    .map((i) => ({
      sku: i.sku,
      name: i.name,
      reason: i.final_sale ? 'Marked final sale' : `Category '${i.category}' is non-returnable`,
    }));
  for (const item of nonReturnable) {
    summary.push({ text: `${item.name} is not eligible for refund (${item.reason.toLowerCase()}).`, doc_ids: ['KB-REFUND-001'] });
  }

  // ---- Warranty --------------------------------------------------------------
  const unitCount = (order?.items ?? []).reduce((n, i) => n + i.quantity, 0) || 1;
  const warranty: WarrantyFact[] = (order?.items ?? []).map((item) => {
    const base = { sku: item.sku, name: item.name };
    if (item.final_sale || HARDWARE_EXCLUDED.has(item.category)) {
      return { ...base, covered_by_warranty_policy: false, base_expires: null, gold_extension_applied: false, expires: null, months_since_delivery: null, in_warranty: false, reason: 'Not covered: software, digital or final-sale item' };
    }
    if (!order?.deliveredAt) {
      return { ...base, covered_by_warranty_policy: true, base_expires: null, gold_extension_applied: false, expires: null, months_since_delivery: null, in_warranty: false, reason: 'Warranty starts at delivery; not delivered yet' };
    }
    // Unit price is approximated from the order total (seed orders are single-item).
    const unitPrice = order.total / unitCount;
    const extensionEligible =
      isGold && !(item.category === 'accessory' && unitPrice < POLICY.goldExtensionAccessoryMinInr.value);
    const baseExpires = addMonths(order.deliveredAt, POLICY.warrantyMonths.value);
    const expires = extensionEligible ? addMonths(baseExpires, POLICY.goldExtensionMonths.value) : baseExpires;
    const inWarranty = isOnOrBefore(ref, expires);
    const months = monthsBetween(order.deliveredAt, ref);
    return {
      ...base,
      covered_by_warranty_policy: true,
      base_expires: baseExpires,
      gold_extension_applied: extensionEligible,
      expires,
      months_since_delivery: months,
      in_warranty: inWarranty,
      reason: `${months} months since delivery; ${POLICY.warrantyMonths.value}-month warranty${extensionEligible ? ` + ${POLICY.goldExtensionMonths.value}-month gold extension` : ''} ${inWarranty ? 'covers it' : 'has expired'} (until ${expires})`,
    };
  });
  for (const w of warranty.filter((x) => x.covered_by_warranty_policy && x.expires)) {
    summary.push({
      text: `${w.name}: ${w.in_warranty ? 'IN warranty' : 'OUT of warranty'}, ${w.reason}.`,
      doc_ids: [POLICY.warrantyMonths.docId],
    });
  }

  // ---- Shipping --------------------------------------------------------------
  const inTransit = order?.status === 'in_transit' || order?.status === 'shipped';
  let dispatch: IsoDate | null = null;
  let bizDays: number | null = null;
  if (order && inTransit) {
    // No tracking events in the data: estimate dispatch as placed_at + 1 business day.
    dispatch = order.placedAt;
    let added = 0;
    while (added < POLICY.dispatchBusinessDays.value) {
      dispatch = addDays(dispatch, 1);
      const dow = new Date(`${dispatch}T00:00:00Z`).getUTCDay();
      if (dow !== 0 && dow !== 6) added += 1;
    }
    bizDays = businessDaysBetween(dispatch, ref);
  }
  const shipping: PolicyFacts['shipping'] = {
    in_transit: inTransit,
    estimated_dispatch_date: dispatch,
    business_days_since_dispatch: bizDays,
    customer_stated_business_days: signals.customer_stated_business_days,
    carrier_investigation_eligible: inTransit && (bizDays ?? 0) >= POLICY.staleTrackingBusinessDays.value,
    // Lost-package remedies use system data only, never the customer's claim.
    lost_package_threshold_met: inTransit && (bizDays ?? 0) >= POLICY.lostPackageBusinessDays.value,
  };
  if (inTransit) {
    summary.push({
      text: `Order in transit ~${bizDays} business days since estimated dispatch (${dispatch}). Carrier investigation ${shipping.carrier_investigation_eligible ? 'is' : 'is not yet'} allowed (≥${POLICY.staleTrackingBusinessDays.value}); replacement/refund ${shipping.lost_package_threshold_met ? 'may be considered' : `not yet allowed (needs ≥${POLICY.lostPackageBusinessDays.value} or carrier confirmation)`}.`,
      doc_ids: [POLICY.staleTrackingBusinessDays.docId],
    });
  }

  if (signals.safety_issue.length) {
    summary.push({
      text: `SAFETY ISSUE reported (${signals.safety_issue.join(', ')}): must escalate to a human specialist with urgent priority; no troubleshooting.`,
      doc_ids: ['KB-WARRANTY-001'],
    });
  }

  return {
    reference_date: ref,
    timezone: timeZone,
    customer: { customer_id: customer.customerId, tier: customer.tier, verified: customer.verified },
    order: order
      ? { order_id: order.orderId, status: order.status, delivered_at: order.deliveredAt, payment_status: order.paymentStatus, total: order.total, currency: order.currency }
      : null,
    return_window: returnWindow,
    non_returnable_items: nonReturnable,
    warranty,
    shipping,
    signals,
    summary,
  };
}
