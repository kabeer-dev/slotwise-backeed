/**
 * Scheduling rules — pure functions, no I/O.
 *
 * These are the business rules the AI is NOT trusted with: whether a date is
 * bookable, whether a time is inside opening hours, on the slot grid, in the
 * future and free. Both the REST booking form and the chat assistant go
 * through them, so the two paths can never disagree.
 */
import { DateTime } from 'luxon';
import {
  DATE_RE,
  TIME_RE,
  describeWorkingDays,
  formatTimeLabel,
  fromMinutes,
  toMinutes,
  zonedDateTime,
} from '../../lib/time.js';
import type { Business } from '../catalog/catalog.types.js';

/** Bookings must start at least this far in the future. */
export const MIN_LEAD_MINUTES = 15;

/** Busy time range as epoch milliseconds, end-exclusive. */
export interface BusyInterval {
  start: number;
  end: number;
}

export type SlotProblemCode =
  | 'INVALID_DATE'
  | 'INVALID_TIME'
  | 'DATE_IN_PAST'
  | 'BEYOND_HORIZON'
  | 'CLOSED_DAY'
  | 'OUTSIDE_HOURS'
  | 'OFF_GRID'
  | 'TOO_SOON'
  | 'SLOT_TAKEN';

export interface SlotProblem {
  code: SlotProblemCode;
  /** Which draft field is wrong — the chat assistant clears it and asks again. */
  field: 'date' | 'time';
  /** Customer-facing explanation. */
  message: string;
}

const problem = (code: SlotProblemCode, field: SlotProblem['field'], message: string): SlotProblem => ({ code, field, message });

function hoursLabel(b: Business) {
  return `${formatTimeLabel(b.opensAt)} – ${formatTimeLabel(b.closesAt)}`;
}

export function checkDate(business: Business, date: string, now: DateTime = DateTime.now()): SlotProblem | null {
  const day = DATE_RE.test(date) ? DateTime.fromISO(date, { zone: business.timezone }) : null;
  if (!day?.isValid) return problem('INVALID_DATE', 'date', "I couldn't read that date. Could you give it as a day and month?");

  const today = now.setZone(business.timezone).startOf('day');
  if (day < today) return problem('DATE_IN_PAST', 'date', 'That date has already passed. Which upcoming day works for you?');

  if (day > today.plus({ days: business.bookingHorizonDays })) {
    return problem('BEYOND_HORIZON', 'date', `We take bookings up to ${business.bookingHorizonDays} days ahead. Could you pick an earlier date?`);
  }

  if (!business.workingDays.includes(day.weekday)) {
    return problem('CLOSED_DAY', 'date', `We're closed on ${day.toFormat('cccc')}s — we're open ${describeWorkingDays(business.workingDays)}. Which other day suits you?`);
  }
  return null;
}

export function checkTime(
  business: Business,
  slot: { date: string; time: string; durationMinutes: number },
  busy: BusyInterval[] | null,
  now: DateTime = DateTime.now(),
): SlotProblem | null {
  if (!TIME_RE.test(slot.time)) return problem('INVALID_TIME', 'time', "I couldn't read that time. Could you give it like 10:30 AM?");

  const start = toMinutes(slot.time);
  const open = toMinutes(business.opensAt);
  const close = toMinutes(business.closesAt);

  if (start < open || start + slot.durationMinutes > close) {
    const finish = slot.durationMinutes > 15 ? ` (a ${slot.durationMinutes}-minute appointment has to finish by closing)` : '';
    return problem('OUTSIDE_HOURS', 'time', `That's outside our opening hours, ${hoursLabel(business)}${finish}.`);
  }

  if ((start - open) % business.slotIntervalMinutes !== 0) {
    return problem('OFF_GRID', 'time', `Appointments start every ${business.slotIntervalMinutes} minutes.`);
  }

  const startsAt = zonedDateTime(slot.date, slot.time, business.timezone);
  if (startsAt < now.plus({ minutes: MIN_LEAD_MINUTES })) {
    return problem('TOO_SOON', 'time', startsAt < now ? 'That time has already passed.' : 'That time is too soon to book.');
  }

  if (busy) {
    const s = startsAt.toMillis();
    const e = s + slot.durationMinutes * 60_000;
    if (busy.some((b) => s < b.end && e > b.start)) {
      return problem('SLOT_TAKEN', 'time', 'That time is already booked.');
    }
  }
  return null;
}

/** All free start times ('HH:mm') for a service on a day. Empty if the day itself isn't bookable. */
export function listAvailableSlots(
  business: Business,
  date: string,
  durationMinutes: number,
  busy: BusyInterval[],
  now: DateTime = DateTime.now(),
): string[] {
  if (checkDate(business, date, now)) return [];

  const slots: string[] = [];
  const open = toMinutes(business.opensAt);
  const close = toMinutes(business.closesAt);
  for (let m = open; m + durationMinutes <= close; m += business.slotIntervalMinutes) {
    const time = fromMinutes(m);
    if (!checkTime(business, { date, time, durationMinutes }, busy, now)) slots.push(time);
  }
  return slots;
}

/** The `count` free slots closest to the requested time, in chronological order. */
export function nearestSlots(available: string[], target: string, count = 3): string[] {
  const t = TIME_RE.test(target) ? toMinutes(target) : 12 * 60;
  return [...available]
    .sort((a, b) => Math.abs(toMinutes(a) - t) - Math.abs(toMinutes(b) - t) || toMinutes(a) - toMinutes(b))
    .slice(0, count)
    .sort((a, b) => toMinutes(a) - toMinutes(b));
}
