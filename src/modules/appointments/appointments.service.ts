import { DateTime } from 'luxon';
import { AppError, isPgError, PgErrorCode } from '../../lib/errors.js';
import { domainEvents } from '../../lib/events.js';
import { dayBounds, zonedDateTime } from '../../lib/time.js';
import type { AuthContext } from '../../middleware/auth.js';
import { getBookableService, getBusiness } from '../catalog/catalog.service.js';
import type { Business, Service } from '../catalog/catalog.types.js';
import * as repo from './appointments.repository.js';
import type { AppointmentDTO, AppointmentScope, CreateAppointmentInput } from './appointments.types.js';
import { checkDate, checkTime, listAvailableSlots, nearestSlots, type SlotProblem } from './scheduling.js';

async function loadBusy(business: Business, date: string) {
  const { start, end } = dayBounds(date, business.timezone);
  return repo.findBusyIntervals(business.id, start.toJSDate(), end.toJSDate());
}

export interface SlotAssessment {
  problem: SlotProblem | null;
  /** Nearby free times on the same day when the requested time doesn't work. */
  alternatives: string[];
}

/**
 * Full check of a (service, date, time) triple against the rules and the
 * current calendar. Shared by the booking endpoint and the chat assistant.
 */
export async function assessSlot(business: Business, service: Service, date: string, time: string): Promise<SlotAssessment> {
  const now = DateTime.now();
  const dateProblem = checkDate(business, date, now);
  if (dateProblem) return { problem: dateProblem, alternatives: [] };

  const busy = await loadBusy(business, date);
  const timeProblem = checkTime(business, { date, time, durationMinutes: service.durationMinutes }, busy, now);
  if (!timeProblem) return { problem: null, alternatives: [] };

  const free = listAvailableSlots(business, date, service.durationMinutes, busy, now);
  return { problem: timeProblem, alternatives: nearestSlots(free, time) };
}

export async function getAvailability(auth: AuthContext, query: { serviceId: string; date: string }) {
  const business = await getBusiness(auth.businessId);
  const service = await getBookableService(auth.businessId, query.serviceId);

  const base = { date: query.date, serviceId: service.id, durationMinutes: service.durationMinutes, timezone: business.timezone };
  const dateProblem = checkDate(business, query.date);
  if (dateProblem) return { ...base, slots: [] as string[], unavailableReason: dateProblem.message };

  const slots = listAvailableSlots(business, query.date, service.durationMinutes, await loadBusy(business, query.date));
  return { ...base, slots, unavailableReason: slots.length === 0 ? 'No free times left on this day.' : null };
}

export async function createAppointment(auth: AuthContext, input: CreateAppointmentInput): Promise<AppointmentDTO> {
  const business = await getBusiness(auth.businessId);
  const service = await getBookableService(auth.businessId, input.serviceId);

  if (input.chatSessionId && !(await repo.chatSessionBelongsTo(auth.businessId, auth.userId, input.chatSessionId))) {
    throw AppError.notFound('Chat session');
  }

  const { problem, alternatives } = await assessSlot(business, service, input.date, input.time);
  if (problem) {
    if (problem.code === 'SLOT_TAKEN') {
      throw AppError.conflict('SLOT_UNAVAILABLE', problem.message, { field: 'time', alternatives });
    }
    throw AppError.unprocessable(problem.code, problem.message, { field: problem.field, alternatives });
  }

  const startsAt = zonedDateTime(input.date, input.time, business.timezone);
  let appointment: AppointmentDTO;
  try {
    appointment = await repo.insert({
      businessId: auth.businessId,
      userId: auth.userId,
      serviceId: service.id,
      chatSessionId: input.chatSessionId ?? null,
      startsAt: startsAt.toJSDate(),
      endsAt: startsAt.plus({ minutes: service.durationMinutes }).toJSDate(),
      notes: input.notes ?? null,
      source: input.source,
    });
  } catch (err) {
    // Lost a race with a concurrent booking: the exclusion constraint caught it.
    if (isPgError(err) && err.code === PgErrorCode.EXCLUSION_VIOLATION) {
      const retry = await assessSlot(business, service, input.date, input.time);
      throw AppError.conflict('SLOT_UNAVAILABLE', 'That time was just booked by someone else.', {
        field: 'time',
        alternatives: retry.alternatives,
      });
    }
    throw err;
  }

  domainEvents.emit('appointment.created', { appointment, userId: auth.userId, businessId: auth.businessId });
  return appointment;
}

export async function listAppointments(auth: AuthContext, scope: AppointmentScope) {
  return repo.listForUser(auth.businessId, auth.userId, scope);
}

export async function getAppointment(auth: AuthContext, id: string) {
  const appointment = await repo.findForUser(auth.businessId, auth.userId, id);
  if (!appointment) throw AppError.notFound('Appointment');
  return appointment;
}

export async function cancelAppointment(auth: AuthContext, id: string): Promise<AppointmentDTO> {
  const appointment = await getAppointment(auth, id);

  if (appointment.status !== 'pending' && appointment.status !== 'confirmed') {
    throw AppError.conflict('NOT_CANCELLABLE', `This appointment is already ${appointment.status.replace('_', ' ')}`);
  }
  if (new Date(appointment.startsAt) <= new Date()) {
    throw AppError.unprocessable('APPOINTMENT_STARTED', 'Appointments that have already started cannot be cancelled');
  }

  const cancelled = await repo.cancel(auth.businessId, auth.userId, id);
  if (!cancelled) throw AppError.conflict('NOT_CANCELLABLE', 'This appointment can no longer be cancelled');

  const updated = await getAppointment(auth, id);
  domainEvents.emit('appointment.cancelled', { appointment: updated, userId: auth.userId, businessId: auth.businessId });
  return updated;
}
