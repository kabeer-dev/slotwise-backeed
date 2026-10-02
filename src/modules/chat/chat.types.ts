import type { AppointmentDTO } from '../appointments/appointments.types.js';

/**
 * Slot-filling state of the booking being discussed in a session.
 * Persisted in chat_sessions.booking_state.
 */
export interface BookingDraft {
  stage: 'collecting' | 'awaiting_confirmation';
  serviceId: string | null;
  date: string | null;
  time: string | null;
  notes: string | null;
  /** Consecutive turns that captured nothing new and valid. Drives the form fallback. */
  clarifications: number;
}

export const EMPTY_DRAFT: BookingDraft = {
  stage: 'collecting',
  serviceId: null,
  date: null,
  time: null,
  notes: null,
  clarifications: 0,
};

export function normalizeDraft(raw: unknown): BookingDraft {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<BookingDraft>;
  return {
    stage: r.stage === 'awaiting_confirmation' ? 'awaiting_confirmation' : 'collecting',
    serviceId: r.serviceId ?? null,
    date: r.date ?? null,
    time: r.time ?? null,
    notes: r.notes ?? null,
    clarifications: Number.isInteger(r.clarifications) ? r.clarifications! : 0,
  };
}

export interface BookingSummary {
  serviceId: string;
  serviceName: string;
  durationMinutes: number;
  date: string;
  time: string;
  notes: string | null;
  /** ISO instant, for display in any timezone. */
  startsAt: string;
}

export type FormReason = 'assistant_unavailable' | 'needs_clarification' | 'too_many_turns';

/** Structured UI the frontend renders under an assistant message. */
export type ChatAction =
  | { type: 'confirm_booking'; booking: BookingSummary }
  | { type: 'booking_confirmed'; appointment: AppointmentDTO }
  | { type: 'booking_form'; reason: FormReason; prefill: { serviceId: string | null; date: string | null; time: string | null; notes: string | null } }
  | { type: 'appointment_list'; appointments: AppointmentDTO[] };

export interface MessagePayload {
  action?: ChatAction;
  /** Tappable suggestions; tapping one sends it as the next user message. */
  quickReplies?: string[];
  meta?: { intent?: string; ai?: 'ok' | 'fallback'; via?: 'button' | 'form' };
}

export interface ChatMessageDTO {
  id: string;
  sessionId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  payload: MessagePayload | null;
  clientMessageId: string | null;
  createdAt: string;
}

export interface ChatSessionDTO {
  id: string;
  title: string;
  status: 'active' | 'closed';
  bookingState: BookingDraft;
  messageCount: number;
  lastMessageAt: string;
  createdAt: string;
}

export const DEFAULT_SESSION_TITLE = 'New conversation';
