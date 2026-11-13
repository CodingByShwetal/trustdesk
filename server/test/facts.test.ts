import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { db, resetDb } from './helpers.js';
import { getPolicyFactsForTicket } from '../src/modules/policy/service.js';

const facts = async (id: string) => (await getPolicyFactsForTicket(db, id)).facts;

beforeAll(async () => {
  await resetDb();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('policy facts per seed ticket', () => {
  it('tkt_9001: damaged earbuds inside the 7-day return window', async () => {
    const f = await facts('tkt_9001');
    expect(f.reference_date).toBe('2026-06-28');
    expect(f.return_window).toMatchObject({ applicable: true, open: true, days_since_delivery: 4, deadline: '2026-07-01' });
    expect(f.non_returnable_items).toEqual([]);
    expect(f.signals).toMatchObject({ damage_reported: true, replacement_requested: true, safety_issue: [] });
  });

  it('tkt_9002: carrier investigation allowed, lost-package remedies not yet', async () => {
    const f = await facts('tkt_9002');
    expect(f.shipping).toMatchObject({
      in_transit: true,
      estimated_dispatch_date: '2026-06-23',
      business_days_since_dispatch: 7,
      customer_stated_business_days: 6,
      carrier_investigation_eligible: true,
      lost_package_threshold_met: false,
    });
    expect(f.signals.urgent_need).toBe(true);
  });

  it('tkt_9003: final-sale software licence is non-returnable and has no warranty', async () => {
    const f = await facts('tkt_9003');
    expect(f.non_returnable_items).toEqual([
      { sku: 'BG-SOFT-01', name: 'Cloud Backup Annual License', reason: 'Marked final sale' },
    ]);
    expect(f.return_window.open).toBe(false);
    expect(f.warranty[0]).toMatchObject({ covered_by_warranty_policy: false, in_warranty: false });
  });

  it('tkt_9004: in warranty only thanks to the gold extension, and a safety issue', async () => {
    const f = await facts('tkt_9004');
    expect(f.warranty[0]).toMatchObject({
      base_expires: '2026-06-05',
      gold_extension_applied: true,
      expires: '2026-12-05',
      in_warranty: true,
    });
    expect(f.signals.safety_issue).toEqual(['battery_swelling']);
    expect(f.summary.some((s) => s.text.startsWith('SAFETY ISSUE'))).toBe(true);
  });

  it('tkt_9005: customer is not identity-verified', async () => {
    const f = await facts('tkt_9005');
    expect(f.customer.verified).toBe(false);
    expect(f.signals.account_change_requested).toBe(true);
    expect(f.summary[0].doc_ids).toEqual(['KB-ACCOUNT-001']);
  });

  it('tkt_9008: duplicate charge on a single delivered order', async () => {
    const f = await facts('tkt_9008');
    expect(f.signals.duplicate_charge_reported).toBe(true);
    expect(f.order).toMatchObject({ order_id: 'ord_5006', payment_status: 'paid' });
  });

  it('does not depend on the current date', async () => {
    const before = await facts('tkt_9001');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2031-01-01T00:00:00Z'));
    const later = await facts('tkt_9001');
    expect(later).toEqual(before);
    expect(later.return_window.open).toBe(true);
  });
});
