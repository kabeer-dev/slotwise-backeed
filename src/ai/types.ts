import type { DateTime } from 'luxon';
import { z } from 'zod';
import { DATE_RE } from '../lib/time.js';

/**
 * The ONLY thing the LLM produces: a classification of the latest customer
 * message plus any booking details it contains, and a short reply.
 * The model never creates bookings, checks availability or sees other
 * customers' data — business logic does that with the parsed fields.
 */
export const INTENTS = ['book', 'confirm', 'decline', 'list_appointments', 'reset', 'other'] as const;
export type Intent = (typeof INTENTS)[number];

/** "9:5", "09:05", "09:05:00", "9.30" → "09:05" / "09:30"; anything else → null */
function normalizeTime(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const m = /^\s*(\d{1,2})[:.](\d{2})(?::\d{2})?\s*$/.exec(value);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

/** Optional field that degrades to null instead of failing the whole response. */
const lenient = <T extends z.ZodType>(schema: T) => schema.nullable().optional().catch(null);

export const AiTurnSchema = z
  .object({
    intent: z.preprocess((v) => (typeof v === 'string' ? v.toLowerCase().trim() : v), z.enum(INTENTS)).catch('other'),
    service: lenient(z.string().trim().min(1).max(100)),
    date: lenient(z.string().regex(DATE_RE)),
    time: lenient(z.preprocess(normalizeTime, z.string())),
    notes: lenient(z.string().trim().min(1).max(500)),
    needs_clarification: z.boolean().catch(false),
    // The reply is required — without it there is nothing safe to show.
    reply: z.string().trim().min(1).max(1000),
  })
  .transform((t) => ({
    intent: t.intent,
    service: t.service ?? null,
    date: t.date ?? null,
    time: t.time ?? null,
    notes: t.notes ?? null,
    needsClarification: t.needs_clarification,
    reply: t.reply,
  }));

export type AiTurn = z.output<typeof AiTurnSchema>;

export interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
}

/** Everything an interpreter needs to understand one customer turn. */
export interface TurnContext {
  businessName: string;
  timezone: string;
  /** Current time in the business timezone. */
  now: DateTime;
  openingHours: string;
  services: { name: string; durationMinutes: number; description: string | null }[];
  /** Details already collected in this conversation (by service *name*). */
  draft: {
    service: string | null;
    date: string | null;
    time: string | null;
    notes: string | null;
    awaitingConfirmation: boolean;
  };
  /** Oldest → newest; the last entry is the message being interpreted. */
  history: ConversationMessage[];
}

export interface InterpretationTelemetry {
  provider: string;
  model: string;
  latencyMs: number;
  promptTokens?: number | undefined;
  completionTokens?: number | undefined;
  requestMessages?: unknown;
  rawOutput?: string | undefined;
}

export type FailureReason = 'timeout' | 'error' | 'invalid_output';

export type InterpretationResult =
  | { ok: true; turn: AiTurn; telemetry: InterpretationTelemetry }
  | { ok: false; reason: FailureReason; error: string; telemetry: InterpretationTelemetry };

/** Strategy interface: an LLM-backed implementation and a deterministic one share it. */
export interface BookingInterpreter {
  readonly provider: string;
  readonly model: string;
  interpret(ctx: TurnContext): Promise<InterpretationResult>;
}
