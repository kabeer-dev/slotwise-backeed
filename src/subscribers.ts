import { DateTime } from 'luxon';
import { domainEvents } from './lib/events.js';
import { logger } from './lib/logger.js';
import { realtime } from './realtime/socket.js';
import { getBusiness } from './modules/catalog/catalog.service.js';
import * as chatRepo from './modules/chat/chat.repository.js';
import { EMPTY_DRAFT } from './modules/chat/chat.types.js';

/**
 * Cross-module reactions to domain events, wired in one place so modules
 * stay unaware of each other.
 */
let registered = false;

export function registerSubscribers() {
  if (registered) return;
  registered = true;

  // Keep every open tab's appointment list fresh.
  domainEvents.on('appointment.created', ({ appointment, userId }) => {
    realtime.toUser(userId, 'appointments:changed', { reason: 'created', appointmentId: appointment.id });
  });
  domainEvents.on('appointment.cancelled', ({ appointment, userId }) => {
    realtime.toUser(userId, 'appointments:changed', { reason: 'cancelled', appointmentId: appointment.id });
  });

  // A booking made through the fallback form *inside* a conversation is reported
  // back into that conversation, and the draft is cleared.
  domainEvents.on('appointment.created', async ({ appointment, userId, businessId }) => {
    if (appointment.source !== 'form' || !appointment.chatSessionId) return;

    const business = await getBusiness(businessId);
    const start = DateTime.fromISO(appointment.startsAt).setZone(business.timezone);
    const message = await chatRepo.insertMessage({
      sessionId: appointment.chatSessionId,
      role: 'assistant',
      content: `You're booked! ${appointment.service.name} on ${start.toFormat('ccc, d LLL')} at ${start.toFormat('h:mm a')}. See you then.`,
      payload: { action: { type: 'booking_confirmed', appointment }, meta: { via: 'form' } },
    });
    const session = await chatRepo.updateSessionAfterTurn(appointment.chatSessionId, { draft: EMPTY_DRAFT, messagesAdded: 1 });

    realtime.toUser(userId, 'chat:message', { sessionId: session.id, message });
    realtime.toUser(userId, 'chat:session', { session });
    logger.info({ appointmentId: appointment.id, sessionId: session.id }, 'Form booking linked to conversation');
  });
}
