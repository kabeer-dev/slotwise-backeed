import { EventEmitter } from 'node:events';
import { logger } from './logger.js';
import type { AppointmentDTO } from '../modules/appointments/appointments.types.js';

/**
 * In-process domain events. Lets modules react to each other without
 * importing each other (appointments doesn't know chat or websockets exist).
 * Swap for a queue (Redis streams, SQS, ...) if handlers move out of process.
 */
export interface DomainEvents {
  'appointment.created': { appointment: AppointmentDTO; userId: string; businessId: string };
  'appointment.cancelled': { appointment: AppointmentDTO; userId: string; businessId: string };
}

type Handler<K extends keyof DomainEvents> = (payload: DomainEvents[K]) => void | Promise<void>;

const emitter = new EventEmitter();

export const domainEvents = {
  emit<K extends keyof DomainEvents>(event: K, payload: DomainEvents[K]) {
    emitter.emit(event, payload);
  },
  on<K extends keyof DomainEvents>(event: K, handler: Handler<K>) {
    emitter.on(event, (payload: DomainEvents[K]) => {
      // Handlers are side effects; a failure must never break the request that emitted the event.
      Promise.resolve()
        .then(() => handler(payload))
        .catch((err) => logger.error({ err, event }, 'Domain event handler failed'));
    });
  },
};
