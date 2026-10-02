/**
 * Chat orchestration for one turn:
 *
 *   persist user message → load context (draft, services, last N messages)
 *   → AI interprets (structured JSON) → dialog policy validates / decides
 *   → persist assistant reply + new draft (one short transaction) → push via socket
 *
 * The LLM call happens outside any DB transaction.
 */
import { DateTime } from 'luxon';
import { interpretTurn } from '../../ai/index.js';
import type { TurnContext } from '../../ai/types.js';
import { env } from '../../config/env.js';
import { withTransaction } from '../../db/pool.js';
import { AppError, isPgError, PgErrorCode } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { describeWorkingDays, formatTimeLabel } from '../../lib/time.js';
import type { AuthContext } from '../../middleware/auth.js';
import { realtime } from '../../realtime/socket.js';
import * as appointmentsService from '../appointments/appointments.service.js';
import { checkDate } from '../appointments/scheduling.js';
import { findUserById } from '../auth/auth.repository.js';
import { getActiveServices, getBusiness } from '../catalog/catalog.service.js';
import type { Business, Service } from '../catalog/catalog.types.js';
import {
  confirmPendingBooking,
  formAction,
  isComplete,
  runDialogTurn,
  starterReplies,
  type DialogDeps,
  type DialogOutcome,
} from './bookingDialog.js';
import * as repo from './chat.repository.js';
import { DEFAULT_SESSION_TITLE, EMPTY_DRAFT, type BookingDraft, type ChatSessionDTO } from './chat.types.js';

// ---------------------------------------------------------------- locking ---

/**
 * One turn at a time per session, so two quick messages can't race on the
 * booking draft. In-process only — with several API instances this would
 * become a Redis lock (or optimistic versioning on chat_sessions).
 */
const turnsInFlight = new Set<string>();

async function withTurnLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
  if (turnsInFlight.has(sessionId)) {
    throw AppError.conflict('TURN_IN_PROGRESS', 'Please wait for the assistant to reply before sending another message');
  }
  turnsInFlight.add(sessionId);
  try {
    return await fn();
  } finally {
    turnsInFlight.delete(sessionId);
  }
}

// ---------------------------------------------------------------- helpers ---

function titleFrom(content: string) {
  const clean = content.replace(/\s+/g, ' ').trim();
  return clean.length > 60 ? `${clean.slice(0, 57)}…` : clean;
}

function buildTurnContext(business: Business, services: Service[], draft: BookingDraft, history: TurnContext['history']): TurnContext {
  return {
    businessName: business.name,
    timezone: business.timezone,
    now: DateTime.now().setZone(business.timezone),
    openingHours: `${describeWorkingDays(business.workingDays)}, ${formatTimeLabel(business.opensAt)} – ${formatTimeLabel(business.closesAt)}`,
    services: services.map((s) => ({ name: s.name, durationMinutes: s.durationMinutes, description: s.description })),
    draft: {
      service: services.find((s) => s.id === draft.serviceId)?.name ?? null,
      date: draft.date,
      time: draft.time,
      notes: draft.notes,
      awaitingConfirmation: draft.stage === 'awaiting_confirmation',
    },
    history,
  };
}

function dialogDeps(auth: AuthContext, business: Business, services: Service[], sessionId: string): DialogDeps {
  return {
    business,
    services,
    checkDate: (date) => checkDate(business, date),
    assessSlot: (service, date, time) => appointmentsService.assessSlot(business, service, date, time),
    freeSlots: async (service, date) => (await appointmentsService.getAvailability(auth, { serviceId: service.id, date })).slots,
    listUpcoming: () => appointmentsService.listAppointments(auth, 'upcoming'),
    createBooking: async (draft, service) => {
      try {
        const appointment = await appointmentsService.createAppointment(auth, {
          serviceId: service.id,
          date: draft.date,
          time: draft.time,
          notes: draft.notes ?? undefined,
          chatSessionId: sessionId,
          source: 'chat',
        });
        return { ok: true, appointment };
      } catch (err) {
        if (err instanceof AppError && (err.status === 409 || err.status === 422)) {
          const details = (err.details ?? {}) as { field?: string; alternatives?: string[] };
          return {
            ok: false,
            message: err.message,
            field: details.field === 'date' ? 'date' : 'time',
            alternatives: details.alternatives ?? [],
          };
        }
        throw err;
      }
    },
  };
}

/** Store the assistant reply + new draft atomically, then push both to the user's open tabs. */
async function persistOutcome(
  auth: AuthContext,
  session: ChatSessionDTO,
  outcome: DialogOutcome,
  opts: { messagesAdded: number; title?: string | undefined },
) {
  const result = await withTransaction(async (client) => {
    const assistantMessage = await repo.insertMessage(
      { sessionId: session.id, role: 'assistant', content: outcome.reply, payload: outcome.payload },
      client,
    );
    const updated = await repo.updateSessionAfterTurn(
      session.id,
      { draft: outcome.draft, messagesAdded: opts.messagesAdded, title: opts.title },
      client,
    );
    return { assistantMessage, session: updated };
  });

  realtime.toUser(auth.userId, 'chat:message', { sessionId: session.id, message: result.assistantMessage });
  realtime.toUser(auth.userId, 'chat:session', { session: result.session });
  return result;
}

// ------------------------------------------------------------- public API ---

export async function listSessions(auth: AuthContext) {
  return repo.listSessions(auth.businessId, auth.userId);
}

export async function getSession(auth: AuthContext, sessionId: string) {
  const session = await repo.findSession(auth.businessId, auth.userId, sessionId);
  if (!session) throw AppError.notFound('Conversation');
  return session;
}

export async function listMessages(auth: AuthContext, sessionId: string, opts: { limit: number; before?: string | undefined }) {
  await getSession(auth, sessionId);
  return repo.listMessages(sessionId, { limit: opts.limit, beforeId: opts.before });
}

/** New conversation, opened with a greeting and starter suggestions. */
export async function createSession(auth: AuthContext) {
  const [business, services, user] = await Promise.all([
    getBusiness(auth.businessId),
    getActiveServices(auth.businessId),
    findUserById(auth.businessId, auth.userId),
  ]);
  const firstName = user?.fullName.split(' ')[0] ?? 'there';
  const example = services[0] ? `${services[0].name.toLowerCase()} tomorrow at 11am` : 'an appointment tomorrow at 11am';

  const result = await withTransaction(async (client) => {
    const session = await repo.insertSession(auth.businessId, auth.userId, client);
    const greeting = await repo.insertMessage(
      {
        sessionId: session.id,
        role: 'assistant',
        content: `Hi ${firstName}! I'm the booking assistant for ${business.name}. Tell me what you'd like to book and when — for example, "${example}".`,
        payload: { quickReplies: starterReplies(services) },
      },
      client,
    );
    const updated = await repo.updateSessionAfterTurn(session.id, { draft: EMPTY_DRAFT, messagesAdded: 1 }, client);
    return { session: updated, messages: [greeting] };
  });

  realtime.toUser(auth.userId, 'chat:session', { session: result.session });
  return result;
}

export async function sendMessage(auth: AuthContext, sessionId: string, input: { content: string; clientMessageId?: string | undefined }) {
  const session = await getSession(auth, sessionId);
  if (session.status !== 'active') throw AppError.conflict('SESSION_CLOSED', 'This conversation is closed. Start a new one.');

  return withTurnLock(sessionId, async () => {
    let userMessage;
    try {
      userMessage = await repo.insertMessage({ sessionId, role: 'user', content: input.content, clientMessageId: input.clientMessageId });
    } catch (err) {
      if (isPgError(err) && err.code === PgErrorCode.UNIQUE_VIOLATION) {
        throw AppError.conflict('DUPLICATE_MESSAGE', 'This message was already sent');
      }
      throw err;
    }

    realtime.toUser(auth.userId, 'chat:message', { sessionId, message: userMessage });
    realtime.toUser(auth.userId, 'chat:typing', { sessionId, isTyping: true });
    const title = session.title === DEFAULT_SESSION_TITLE ? titleFrom(input.content) : undefined;

    try {
      const [business, services, history] = await Promise.all([
        getBusiness(auth.businessId),
        getActiveServices(auth.businessId),
        repo.recentHistory(sessionId, env.AI_HISTORY_WINDOW),
      ]);

      const ai = await interpretTurn(buildTurnContext(business, services, session.bookingState, history), {
        businessId: auth.businessId,
        sessionId,
        userId: auth.userId,
      });
      const outcome = await runDialogTurn(session.bookingState, ai, dialogDeps(auth, business, services, sessionId));
      const result = await persistOutcome(auth, session, outcome, { messagesAdded: 2, title });
      return { userMessage, ...result };
    } catch (err) {
      // The user's message is already stored; never leave the conversation hanging on it.
      // Degrade to the structured form and keep the draft.
      logger.error({ err, sessionId }, 'Chat turn failed — sending fallback reply');
      const result = await persistOutcome(
        auth,
        session,
        {
          reply: 'Sorry — something went wrong on our side. Please try again, or book with the form below.',
          draft: session.bookingState,
          payload: { action: formAction('assistant_unavailable', session.bookingState), meta: { ai: 'fallback' } },
        },
        { messagesAdded: 2, title },
      );
      return { userMessage, ...result };
    } finally {
      realtime.toUser(auth.userId, 'chat:typing', { sessionId, isTyping: false });
    }
  });
}

/** The "Confirm" button on a summary card: books the pending draft without another AI call. */
export async function confirmBooking(auth: AuthContext, sessionId: string) {
  const session = await getSession(auth, sessionId);
  const draft = session.bookingState;
  if (draft.stage !== 'awaiting_confirmation' || !isComplete(draft)) {
    throw AppError.conflict('NOTHING_TO_CONFIRM', 'There is no booking waiting for confirmation');
  }

  return withTurnLock(sessionId, async () => {
    const userMessage = await repo.insertMessage({
      sessionId,
      role: 'user',
      content: 'Confirm booking',
      payload: { meta: { via: 'button' } },
    });
    realtime.toUser(auth.userId, 'chat:message', { sessionId, message: userMessage });

    const [business, services] = await Promise.all([getBusiness(auth.businessId), getActiveServices(auth.businessId)]);
    const outcome = await confirmPendingBooking(draft, dialogDeps(auth, business, services, sessionId), { via: 'button' });
    const result = await persistOutcome(auth, session, outcome, { messagesAdded: 2 });
    return { userMessage, ...result };
  });
}
