import { describe, expect, it } from 'vitest';
import { addDays, addMonths, businessDaysBetween, dateInTimeZone, daysBetween, monthsBetween } from '../src/lib/dates.js';

describe('date helpers', () => {
  it('reads the calendar date in the business timezone, not UTC', () => {
    // 20:00 UTC on Jun 28 is already Jun 29 in India.
    expect(dateInTimeZone(new Date('2026-06-28T20:00:00Z'), 'Asia/Kolkata')).toBe('2026-06-29');
    expect(dateInTimeZone(new Date('2026-06-28T20:00:00Z'), 'UTC')).toBe('2026-06-28');
  });

  it('counts calendar days and adds days across month ends', () => {
    expect(daysBetween('2026-06-24', '2026-06-28')).toBe(4);
    expect(addDays('2026-06-28', 7)).toBe('2026-07-05');
  });

  it('adds months with end-of-month clamping, including leap years', () => {
    expect(addMonths('2025-06-05', 12)).toBe('2026-06-05');
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2028-01-31', 1)).toBe('2028-02-29');
  });

  it('counts whole months by anniversary', () => {
    expect(monthsBetween('2025-06-05', '2026-07-01')).toBe(12);
    expect(monthsBetween('2025-06-05', '2026-07-05')).toBe(13);
  });

  it('counts weekdays only', () => {
    expect(businessDaysBetween('2026-06-26', '2026-06-29')).toBe(1); // Fri → Mon
    expect(businessDaysBetween('2026-06-23', '2026-07-02')).toBe(7);
    expect(businessDaysBetween('2026-07-02', '2026-07-01')).toBe(0);
  });
});
