import { DateTime } from 'luxon';
import type { Business, Service } from '../src/modules/catalog/catalog.types.js';

export const TZ = 'Asia/Karachi';

export const business: Business = {
  id: 'b0000000-0000-4000-8000-000000000001',
  slug: 'lumen-clinic',
  name: 'Lumen Health Clinic',
  timezone: TZ,
  opensAt: '09:00',
  closesAt: '18:00',
  workingDays: [1, 2, 3, 4, 5, 6],
  slotIntervalMinutes: 15,
  bookingHorizonDays: 60,
};

export const services: Service[] = [
  { id: '5e000000-0000-4000-8000-000000000003', name: 'Dental Cleaning', description: null, durationMinutes: 45, isActive: true },
  { id: '5e000000-0000-4000-8000-000000000002', name: 'Follow-up Visit', description: null, durationMinutes: 15, isActive: true },
  { id: '5e000000-0000-4000-8000-000000000001', name: 'General Consultation', description: null, durationMinutes: 30, isActive: true },
  { id: '5e000000-0000-4000-8000-000000000004', name: 'Physiotherapy Session', description: null, durationMinutes: 60, isActive: true },
];

/** Friday 2 Oct 2026, 13:50 in Lahore. */
export const NOW = DateTime.fromISO('2026-10-02T13:50', { zone: TZ });

/** A working day `offset` days or more from today (real clock), as YYYY-MM-DD. Skips Sundays. */
export function futureWorkingDay(offset: number): string {
  let d = DateTime.now().setZone(TZ).startOf('day').plus({ days: offset });
  while (d.weekday === 7) d = d.plus({ days: 1 });
  return d.toISODate()!;
}
