/**
 * Dialog policy: turns the AI's interpretation of a message into what the
 * assistant actually does.
 *
 *   AI decides:      what the customer meant (intent) and which details they gave.
 *   This decides:    whether those details are valid, what is still missing,
 *                    when to ask for confirmation, when to book, and when to
 *                    fall back to the structured form.
 *
 * Facts shown to the customer (summaries, confirmations, availability) are
 * always phrased here from validated data — never taken from model output.
 */
import { DateTime } from 'luxon';
import type { InterpretationResult, AiTurn } from '../../ai/types.js';
import { formatDateLabel, formatTimeLabel, zonedDateTime } from '../../lib/time.js';
import type { AppointmentDTO } from '../appointments/appointments.types.js';
import type { SlotAssessment } from '../appointments/appointments.service.js';
import type { SlotProblem } from '../appointments/scheduling.js';
import type { Business, Service } from '../catalog/catalog.types.js';
import {
  EMPTY_DRAFT,
  type BookingDraft,
  type BookingSummary,
  type ChatAction,
  type FormReason,
  type MessagePayload,
} from './chat.types.js';

/** After this many consecutive turns without progress, offer the structured form. */
export const MAX_STALLED_TURNS = 2;

export type BookingAttempt =
  | { ok: true; appointment: AppointmentDTO }
  | { ok: false; message: string; field: 'date' | 'time'; alternatives: string[] };

export interface DialogDeps {
  business: Business;
  services: Service[];
  now?: DateTime;
  checkDate(date: string): SlotProblem | null;
  assessSlot(service: Service, date: string, time: string): Promise<SlotAssessment>;
  freeSlots(service: Service, date: string): Promise<string[]>;
  createBooking(draft: CompleteDraft, service: Service): Promise<BookingAttempt>;
  listUpcoming(): Promise<AppointmentDTO[]>;
}

export interface DialogOutcome {
  reply: string;
  payload: MessagePayload;
  draft: BookingDraft;
}

type CompleteDraft = BookingDraft & { serviceId: string; date: string; time: string };
type Meta = NonNullable<MessagePayload['meta']>;

// ---------------------------------------------------------------- helpers ---

export function isComplete(d: BookingDraft): d is CompleteDraft {
  return Boolean(d.serviceId && d.date && d.time);
}

const hasDetails = (t: AiTurn) => Boolean(t.service || t.date || t.time);
const isEmptyDraft = (d: BookingDraft) => !d.serviceId && !d.date && !d.time;
const filledCount = (d: BookingDraft) => [d.serviceId, d.date, d.time].filter(Boolean).length;
const article = (word: string) => (/^[aeiou]/i.test(word) ? 'an' : 'a');

/** Exact (case-insensitive) match first, then containment either way. */
export function matchService(name: string, services: Service[]): Service | null {
  const n = name.trim().toLowerCase();
  return (
    services.find((s) => s.name.toLowerCase() === n) ??
    services.find((s) => s.name.toLowerCase().includes(n) || n.includes(s.name.toLowerCase())) ??
    null
  );
}

/** Model output claiming a booking happened is never shown — only this module confirms bookings. */
const CLAIMS_BOOKING =
  /\b(you('| a)re (all )?(booked|set|confirmed)|i('| ha)ve (booked|confirmed|reserved)|(is|has been) (now )?(booked|confirmed|reserved)|booking (is )?confirmed)\b/i;
export function safeReply(reply: string, fallback: string) {
  return CLAIMS_BOOKING.test(reply) ? fallback : reply;
}

function pickSpread<T>(items: T[], count: number): T[] {
  if (items.length <= count) return items;
  const step = (items.length - 1) / (count - 1);
  return Array.from({ length: count }, (_, i) => items[Math.round(i * step)]!);
}

export function starterReplies(services: Service[]): string[] {
  return [...services.slice(0, 2).map((s) => `Book ${article(s.name)} ${s.name}`), 'Show my appointments'];
}

function upcomingWorkingDays(deps: DialogDeps, count: number): string[] {
  const { business } = deps;
  const out: string[] = [];
  let day = (deps.now ?? DateTime.now()).setZone(business.timezone).startOf('day').plus({ days: 1 });
  for (let i = 0; out.length < count && i < 14; i++, day = day.plus({ days: 1 })) {
    if (business.workingDays.includes(day.weekday)) out.push(day.toFormat('cccc d LLL'));
  }
  return out;
}

export function formAction(reason: FormReason, d: BookingDraft): ChatAction {
  return { type: 'booking_form', reason, prefill: { serviceId: d.serviceId, date: d.date, time: d.time, notes: d.notes } };
}

function summarize(d: CompleteDraft, service: Service, business: Business): BookingSummary {
  return {
    serviceId: service.id,
    serviceName: service.name,
    durationMinutes: service.durationMinutes,
    date: d.date,
    time: d.time,
    notes: d.notes,
    startsAt: zonedDateTime(d.date, d.time, business.timezone).toUTC().toISO()!,
  };
}

const when = (d: { date: string; time: string }, tz: string) => `${formatDateLabel(d.date, tz)} at ${formatTimeLabel(d.time)}`;

// ------------------------------------------------------------- the policy ---

export async function runDialogTurn(draft: BookingDraft, ai: InterpretationResult, deps: DialogDeps): Promise<DialogOutcome> {
  // Requirement: if the AI can't help, fall back to the structured form — keeping whatever we already know.
  if (!ai.ok) {
    return {
      reply: "Sorry, I'm having trouble understanding messages right now. You can finish your booking with the form below.",
      draft,
      payload: { action: formAction('assistant_unavailable', draft), meta: { ai: 'fallback' } },
    };
  }

  const turn = ai.turn;
  const meta: Meta = { intent: turn.intent, ai: 'ok' };

  switch (turn.intent) {
    case 'reset':
      return {
        reply: "No problem — let's start over. What would you like to book?",
        draft: { ...EMPTY_DRAFT },
        payload: { quickReplies: starterReplies(deps.services).slice(0, 2), meta },
      };

    case 'list_appointments': {
      const appointments = await deps.listUpcoming();
      if (appointments.length === 0) {
        return {
          reply: "You don't have any upcoming appointments. Would you like to book one?",
          draft,
          payload: { quickReplies: starterReplies(deps.services).slice(0, 2), meta },
        };
      }
      const n = appointments.length;
      return {
        reply: `You have ${n} upcoming appointment${n === 1 ? '' : 's'}:`,
        draft,
        payload: { action: { type: 'appointment_list', appointments }, meta },
      };
    }

    case 'confirm':
      if (draft.stage === 'awaiting_confirmation' && isComplete(draft)) return confirmPendingBooking(draft, deps, meta);
      break; // e.g. "yes, 3pm works" with nothing pending → treat as details

    case 'decline':
      if (draft.stage === 'awaiting_confirmation' && !hasDetails(turn)) {
        return {
          reply: 'No problem — tell me what to change (for example "make it 4 PM" or "Thursday instead"), or adjust it in the form below.',
          draft: { ...draft, stage: 'collecting' },
          payload: { action: formAction('needs_clarification', draft), meta },
        };
      }
      break;

    case 'other':
      if (!hasDetails(turn)) {
        return {
          reply: safeReply(turn.reply, 'I can help you book an appointment or check your upcoming ones.'),
          draft,
          payload: { quickReplies: isEmptyDraft(draft) ? starterReplies(deps.services) : undefined, meta },
        };
      }
      break;

    case 'book':
      break;
  }

  return fillSlots(draft, turn, deps, meta);
}

async function fillSlots(draft: BookingDraft, turn: AiTurn, deps: DialogDeps, meta: Meta): Promise<DialogOutcome> {
  const { services, business } = deps;
  const next: BookingDraft = { ...draft };
  const notices: string[] = [];
  let quickReplies: string[] | undefined;
  let changed = false;

  // 1. Merge what the AI extracted (only non-null fields; earlier answers are kept).
  if (turn.service) {
    const match = matchService(turn.service, services);
    if (match) {
      changed ||= match.id !== next.serviceId;
      next.serviceId = match.id;
    } else {
      notices.push(`Sorry, we don't offer "${turn.service}". We can book: ${services.map((s) => s.name).join(', ')}.`);
      quickReplies = services.slice(0, 4).map((s) => s.name);
    }
  }
  if (turn.date && turn.date !== next.date) {
    next.date = turn.date;
    changed = true;
  }
  if (turn.time && turn.time !== next.time) {
    next.time = turn.time;
    changed = true;
  }
  if (turn.notes) next.notes = turn.notes;
  if (changed) next.stage = 'collecting';

  // "No, change it" with no new details while everything is filled in: ask, don't re-confirm the same booking.
  if (!changed && turn.intent === 'decline' && isComplete(next)) {
    return {
      reply: 'What would you like to change it to?',
      draft: { ...next, stage: 'collecting' },
      payload: { action: formAction('needs_clarification', next), meta },
    };
  }

  // 2. Validate deterministically. Invalid fields are cleared and explained.
  if (next.date) {
    const problem = deps.checkDate(next.date);
    if (problem) {
      notices.push(problem.message);
      next.date = null;
    }
  }

  const service = services.find((s) => s.id === next.serviceId) ?? null;
  if (service && next.date && next.time) {
    const { problem, alternatives } = await deps.assessSlot(service, next.date, next.time);
    if (problem) {
      next[problem.field] = null;
      if (problem.field === 'time' && alternatives.length === 0) {
        notices.push(`${problem.message} There are no free times left on ${formatDateLabel(next.date!, business.timezone)} — which other day works for you?`);
        next.date = null;
      } else if (alternatives.length > 0) {
        notices.push(`${problem.message} The closest free times are ${alternatives.map(formatTimeLabel).join(', ')}.`);
        quickReplies = alternatives.map(formatTimeLabel);
      } else {
        notices.push(problem.message);
      }
    }
  }

  // 3. Everything valid → ask for explicit confirmation with a summary built from real data.
  if (isComplete(next) && service) {
    const confirmDraft: BookingDraft = { ...next, stage: 'awaiting_confirmation', clarifications: 0 };
    return {
      reply: `Great — ${service.name} on ${when(next, business.timezone)} (${service.durationMinutes} min). Shall I book it?`,
      draft: confirmDraft,
      payload: {
        action: { type: 'confirm_booking', booking: summarize(next, service, business) },
        quickReplies: ['Yes, book it', 'Change the time'],
        meta,
      },
    };
  }

  // 4. Still missing something → ask for it. A turn that made no progress
  //    (nothing new and valid was captured) counts towards the form fallback.
  next.stage = 'collecting';
  next.clarifications = filledCount(next) > filledCount(draft) ? 0 : draft.clarifications + 1;
  const missing = !next.serviceId ? 'service' : !next.date ? 'date' : 'time';

  if (!quickReplies) {
    if (missing === 'service') quickReplies = services.slice(0, 4).map((s) => s.name);
    if (missing === 'date') quickReplies = upcomingWorkingDays(deps, 3);
    if (missing === 'time' && service && next.date) {
      const free = await deps.freeSlots(service, next.date);
      if (free.length === 0) {
        notices.push(`We're fully booked on ${formatDateLabel(next.date, business.timezone)}. Which other day works for you?`);
        next.date = null;
        quickReplies = upcomingWorkingDays(deps, 3);
      } else {
        quickReplies = pickSpread(free, 4).map(formatTimeLabel);
      }
    }
  }

  const fallbackQuestion = {
    service: `Which service would you like? We offer ${services.map((s) => s.name).join(', ')}.`,
    date: 'Which day would you like to come in?',
    time: 'What time works for you?',
  }[missing];

  let reply = notices.length > 0 ? notices.join(' ') : safeReply(turn.reply, fallbackQuestion);

  const payload: MessagePayload = { quickReplies, meta };
  if (turn.needsClarification || next.clarifications >= MAX_STALLED_TURNS) {
    payload.action = formAction(turn.needsClarification ? 'needs_clarification' : 'too_many_turns', next);
    reply += ' You can also pick a time with the form below.';
  }

  return { reply, draft: next, payload };
}

/** Book the pending summary. Used for a typed "yes" and for the Confirm button. */
export async function confirmPendingBooking(draft: CompleteDraft, deps: DialogDeps, meta: Meta = {}): Promise<DialogOutcome> {
  const service = deps.services.find((s) => s.id === draft.serviceId);
  if (!service) {
    return {
      reply: 'That service is no longer available. Which service would you like instead?',
      draft: { ...draft, serviceId: null, stage: 'collecting' },
      payload: { quickReplies: deps.services.slice(0, 4).map((s) => s.name), meta },
    };
  }

  const attempt = await deps.createBooking(draft, service);
  if (attempt.ok) {
    return {
      reply: `You're booked! ${service.name} on ${when(draft, deps.business.timezone)}. See you then.`,
      draft: { ...EMPTY_DRAFT },
      payload: { action: { type: 'booking_confirmed', appointment: attempt.appointment }, quickReplies: ['Show my appointments'], meta },
    };
  }

  // Slot was taken (or became invalid) between summary and confirmation.
  const alts = attempt.alternatives;
  return {
    reply: `${attempt.message}${alts.length ? ` The closest free times are ${alts.map(formatTimeLabel).join(', ')}.` : ' Which other time works for you?'}`,
    draft: { ...draft, [attempt.field]: null, stage: 'collecting' },
    payload: { quickReplies: alts.length ? alts.map(formatTimeLabel) : undefined, meta },
  };
}
