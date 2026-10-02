import { describe, expect, it } from 'vitest';
import { checkDate, checkTime, listAvailableSlots, nearestSlots } from '../../src/modules/appointments/scheduling.js';
import { zonedDateTime } from '../../src/lib/time.js';
import { business, NOW, TZ } from '../fixtures.js';

// NOW = Fri 2026-10-02 13:50 Asia/Karachi
const busy = (date: string, from: string, to: string) => ({
  start: zonedDateTime(date, from, TZ).toMillis(),
  end: zonedDateTime(date, to, TZ).toMillis(),
});

describe('checkDate', () => {
  it('accepts an upcoming working day', () => {
    expect(checkDate(business, '2026-10-05', NOW)).toBeNull(); // Monday
  });

  it('rejects past dates', () => {
    expect(checkDate(business, '2026-10-01', NOW)?.code).toBe('DATE_IN_PAST');
  });

  it('rejects days the business is closed', () => {
    const p = checkDate(business, '2026-10-04', NOW); // Sunday
    expect(p?.code).toBe('CLOSED_DAY');
    expect(p?.message).toContain('Sundays');
  });

  it('rejects dates beyond the booking horizon', () => {
    expect(checkDate(business, '2027-01-15', NOW)?.code).toBe('BEYOND_HORIZON');
  });

  it('rejects malformed and impossible dates', () => {
    expect(checkDate(business, '05/10/2026', NOW)?.code).toBe('INVALID_DATE');
    expect(checkDate(business, '2026-02-30', NOW)?.code).toBe('INVALID_DATE');
  });
});

describe('checkTime', () => {
  const slot = (time: string, durationMinutes = 30) => ({ date: '2026-10-05', time, durationMinutes });

  it('accepts a free slot inside opening hours', () => {
    expect(checkTime(business, slot('10:00'), [], NOW)).toBeNull();
  });

  it('rejects times before opening or that would end after closing', () => {
    expect(checkTime(business, slot('08:30'), [], NOW)?.code).toBe('OUTSIDE_HOURS');
    expect(checkTime(business, slot('17:30', 45), [], NOW)?.code).toBe('OUTSIDE_HOURS');
    expect(checkTime(business, slot('17:30', 30), [], NOW)).toBeNull();
  });

  it('rejects times off the slot grid', () => {
    expect(checkTime(business, slot('10:10'), [], NOW)?.code).toBe('OFF_GRID');
  });

  it('rejects times that are past or too soon today', () => {
    const today = (time: string) => ({ date: '2026-10-02', time, durationMinutes: 30 });
    expect(checkTime(business, today('13:00'), [], NOW)?.code).toBe('TOO_SOON');
    expect(checkTime(business, today('14:00'), [], NOW)?.code).toBe('TOO_SOON'); // within 15-minute lead
    expect(checkTime(business, today('14:15'), [], NOW)).toBeNull();
  });

  it('detects overlap with existing bookings (end-exclusive)', () => {
    const taken = [busy('2026-10-05', '10:00', '10:45')];
    expect(checkTime(business, slot('10:30'), taken, NOW)?.code).toBe('SLOT_TAKEN');
    expect(checkTime(business, slot('09:45'), taken, NOW)?.code).toBe('SLOT_TAKEN'); // 09:45–10:15 overlaps
    expect(checkTime(business, slot('09:30'), taken, NOW)).toBeNull(); // 09:30–10:00 ends as the booking starts
    expect(checkTime(business, slot('10:45'), taken, NOW)).toBeNull(); // starts as the booking ends
  });
});

describe('listAvailableSlots', () => {
  it('lists grid slots that fit the duration and skips busy ones', () => {
    const taken = [busy('2026-10-05', '10:00', '10:45')];
    const slots = listAvailableSlots(business, '2026-10-05', 45, taken, NOW);
    expect(slots[0]).toBe('09:00');
    expect(slots).toContain('09:15'); // 09:15–10:00 ends exactly when the booking starts
    expect(slots).not.toContain('09:30');
    expect(slots).not.toContain('10:30');
    expect(slots).toContain('10:45');
    expect(slots.at(-1)).toBe('17:15'); // last start that finishes by 18:00
  });

  it('is empty for closed days', () => {
    expect(listAvailableSlots(business, '2026-10-04', 30, [], NOW)).toEqual([]);
  });
});

describe('nearestSlots', () => {
  it('returns the closest free times in chronological order', () => {
    expect(nearestSlots(['09:00', '09:15', '11:30', '12:00', '15:00'], '10:00')).toEqual(['09:00', '09:15', '11:30']);
  });
});
