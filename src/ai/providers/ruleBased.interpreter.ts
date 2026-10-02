import * as chrono from 'chrono-node';
import { formatDateLabel, formatTimeLabel } from '../../lib/time.js';
import type { AiTurn, BookingInterpreter, InterpretationResult, Intent, TurnContext } from '../types.js';

/**
 * Deterministic stand-in for the LLM (AI_PROVIDER=mock).
 *
 * Lets the whole product run locally and in CI without an API key, and gives
 * tests a predictable interpreter. It produces exactly the same AiTurn shape
 * as the LLM, so everything downstream is exercised identically.
 *
 * Demo aid: a message containing "#ai-down" simulates a provider outage so
 * the structured-form fallback can be shown without breaking anything.
 */
const GENERIC_WORDS = new Set(['session', 'visit', 'appointment', 'service', 'general']);
const pad = (n: number) => String(n).padStart(2, '0');

function words(text: string) {
  return text.toLowerCase().match(/[a-z]+/g) ?? [];
}

/** Match by shared word stems: "physio" → "Physiotherapy Session", "cleaning" → "Dental Cleaning". */
export function matchServiceByKeywords(text: string, serviceNames: string[]): string | null {
  const userWords = words(text).filter((w) => w.length >= 4);
  for (const name of serviceNames) {
    const keys = words(name).filter((w) => w.length >= 4 && !GENERIC_WORDS.has(w));
    const hit = keys.some((k) => userWords.some((u) => {
      const n = Math.min(5, k.length, u.length);
      return k.slice(0, n) === u.slice(0, n);
    }));
    if (hit) return name;
  }
  return null;
}

function extractDateTime(text: string, ctx: TurnContext) {
  const { now } = ctx;
  // chrono works in the server's local zone; feed it the business wall-clock and only read components back.
  const ref = new Date(now.year, now.month - 1, now.day, now.hour, now.minute);
  const results = chrono.parse(text, ref, { forwardDate: true });
  const lower = text.toLowerCase();
  const mentionsWeekday = /\b(mon|tue|wed|thu|fri|sat|sun)[a-z]*\b/.test(lower);
  const vagueWeek = /\b(next|this) week\b/.test(lower) && !mentionsWeekday;

  let date: string | null = null;
  let time: string | null = null;
  for (const r of results) {
    const c = r.start;
    if (!date && !vagueWeek && (c.isCertain('day') || c.isCertain('weekday'))) {
      date = `${c.get('year')}-${pad(c.get('month') ?? 1)}-${pad(c.get('day') ?? 1)}`;
    }
    if (!time && c.isCertain('hour')) {
      let h = c.get('hour') ?? 0;
      // "at 4" for a business open 9–6 means 4 PM.
      if (!c.isCertain('meridiem') && h >= 1 && h <= 7) h += 12;
      time = `${pad(h)}:${pad(c.get('minute') ?? 0)}`;
    }
  }

  const vague = !time && (vagueWeek || /\b(morning|afternoon|evening|sometime|whenever|later|soon|asap)\b/.test(lower));
  return { date, time, vague };
}

export class RuleBasedInterpreter implements BookingInterpreter {
  readonly provider = 'mock';
  readonly model = 'rule-based-v1';

  async interpret(ctx: TurnContext): Promise<InterpretationResult> {
    const started = performance.now();
    const text = ctx.history.at(-1)?.content ?? '';
    const telemetry = (raw?: string) => ({
      provider: this.provider,
      model: this.model,
      latencyMs: Math.round(performance.now() - started),
      rawOutput: raw,
    });

    if (text.includes('#ai-down')) {
      return { ok: false, reason: 'error', error: 'Simulated provider outage (#ai-down)', telemetry: telemetry() };
    }

    const turn = this.parse(text, ctx);
    return { ok: true, turn, telemetry: telemetry(JSON.stringify(turn)) };
  }

  parse(text: string, ctx: TurnContext): AiTurn {
    const lower = text.toLowerCase().trim();
    const awaiting = ctx.draft.awaitingConfirmation;
    const base: AiTurn = { intent: 'other', service: null, date: null, time: null, notes: null, needsClarification: false, reply: '' };

    if (/\b(start over|start again|reset|never ?mind|forget it|cancel (this|that|it))\b/.test(lower)) {
      return { ...base, intent: 'reset', reply: "Okay, let's start over." };
    }
    if (/\b(my|upcoming|existing|scheduled)\b.*\b(appointments?|bookings?)\b|\bwhat.*\b(have|got)\b.*\bbooked\b/.test(lower)) {
      return { ...base, intent: 'list_appointments', reply: 'Here are your upcoming appointments.' };
    }
    if (awaiting && /^(yes|yeah|yep|sure|ok(ay)?|confirm|please do|sounds good|go ahead|book it|perfect|great)\b/.test(lower)) {
      return { ...base, intent: 'confirm', reply: 'Great.' };
    }

    const service = matchServiceByKeywords(text, ctx.services.map((s) => s.name));
    const { date, time, vague } = extractDateTime(text, ctx);
    const notes = /\b(?:because|reason is|due to)\s+(.{3,200})$/i.exec(text)?.[1]?.trim() ?? null;
    const hasDetails = Boolean(service || date || time);

    let intent: Intent = 'other';
    if (awaiting && /^(no|nope|not really|change|actually)\b/.test(lower)) intent = 'decline';
    else if (hasDetails || /\b(book|appointment|schedule|reserve|slot)\b/.test(lower)) intent = 'book';

    const turn: AiTurn = { ...base, intent, service, date, time, notes, needsClarification: vague };
    return { ...turn, reply: this.composeReply(turn, ctx, vague) };
  }

  private composeReply(turn: AiTurn, ctx: TurnContext, vague: boolean): string {
    if (turn.intent === 'other') {
      return 'I can book an appointment for you or show your upcoming ones. What would you like to do?';
    }
    if (turn.intent === 'decline' && !turn.service && !turn.date && !turn.time) {
      return 'No problem — what would you like to change: the service, the day or the time?';
    }

    const service = turn.service ?? ctx.draft.service;
    const date = turn.date ?? ctx.draft.date;
    const time = turn.time ?? ctx.draft.time;

    if (!service) return `Sure — which service would you like? We offer ${ctx.services.map((s) => s.name).join(', ')}.`;
    if (!date) return vague ? 'Which specific day works best for you?' : `Which day would you like to come in for your ${service}?`;
    if (!time) {
      return vague
        ? 'Could you give me a specific time — for example 10:30 AM?'
        : `What time suits you on ${formatDateLabel(date, ctx.timezone)}?`;
    }
    return `Let me check ${formatTimeLabel(time)} for you.`;
  }
}
