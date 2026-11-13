import { describe, expect, it } from 'vitest';
import { extractSignals } from '../src/modules/policy/signals.js';

describe('extractSignals', () => {
  it('detects each KB-WARRANTY-001 safety term', () => {
    expect(extractSignals('Battery', 'my battery is swelling').safety_issue).toEqual(['battery_swelling']);
    expect(extractSignals('Hot', 'the charger is overheating and there is a burning smell').safety_issue).toEqual([
      'overheating',
      'burning_smell',
    ]);
    expect(extractSignals('Ok', 'Everything works fine').safety_issue).toEqual([]);
  });

  it('reads the business days the customer states', () => {
    expect(extractSignals('Late', 'no movement for 6 business days').customer_stated_business_days).toBe(6);
    expect(extractSignals('Late', 'it is late').customer_stated_business_days).toBeNull();
  });

  it('detects duplicate charges and account change requests', () => {
    expect(extractSignals('Card', 'I was charged twice').duplicate_charge_reported).toBe(true);
    expect(extractSignals('Email', 'Change my account email to x@y.com').account_change_requested).toBe(true);
    expect(extractSignals('Order', 'Where is my order?').account_change_requested).toBe(false);
  });
});
