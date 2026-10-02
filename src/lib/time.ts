import { DateTime } from 'luxon';

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** 'HH:mm' or 'HH:mm:ss' (Postgres `time`) → minutes since midnight. */
export function toMinutes(time: string): number {
  const [h = '0', m = '0'] = time.split(':');
  return Number(h) * 60 + Number(m);
}

/** Minutes since midnight → 'HH:mm'. */
export function fromMinutes(total: number): string {
  const h = Math.floor(total / 60);
  const m = total % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** Interpret a wall-clock date + time in the business timezone. */
export function zonedDateTime(date: string, time: string, timezone: string): DateTime {
  return DateTime.fromISO(`${date}T${time}`, { zone: timezone });
}

/** [start, end) of a calendar day in the business timezone, as UTC instants. */
export function dayBounds(date: string, timezone: string): { start: DateTime; end: DateTime } {
  const start = DateTime.fromISO(date, { zone: timezone }).startOf('day');
  return { start, end: start.plus({ days: 1 }) };
}

/** "Mon, 5 Oct" */
export function formatDateLabel(date: string, timezone: string): string {
  return DateTime.fromISO(date, { zone: timezone }).toFormat('ccc, d LLL');
}

/** "3:00 PM" */
export function formatTimeLabel(time: string): string {
  return DateTime.fromFormat(time.slice(0, 5), 'HH:mm').toFormat('h:mm a');
}

const WEEKDAY_SHORT = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** {1,2,3,4,5,6} → "Mon–Sat"; {1,3,5} → "Mon, Wed, Fri" */
export function describeWorkingDays(days: number[]): string {
  const sorted = [...new Set(days)].sort((a, b) => a - b);
  if (sorted.length === 0) return 'closed';
  if (sorted.length === 7) return 'every day';
  const contiguous = sorted.every((d, i) => i === 0 || d === sorted[i - 1]! + 1);
  if (contiguous && sorted.length > 2) return `${WEEKDAY_SHORT[sorted[0]!]}–${WEEKDAY_SHORT[sorted.at(-1)!]}`;
  return sorted.map((d) => WEEKDAY_SHORT[d]).join(', ');
}
