import { describe, expect, it, vi } from 'vitest';
import type { AiTurn, InterpretationResult } from '../../src/ai/types.js';
import { checkDate } from '../../src/modules/appointments/scheduling.js';
import { MAX_STALLED_TURNS, runDialogTurn, type DialogDeps } from '../../src/modules/chat/bookingDialog.js';
import { EMPTY_DRAFT, type BookingDraft } from '../../src/modules/chat/chat.types.js';
import { business, NOW, services } from '../fixtures.js';

const DENTAL = services[0]!;
const telemetry = { provider: 'test', model: 'test', latencyMs: 1 };

function ai(turn: Partial<AiTurn>): InterpretationResult {
  return {
    ok: true,
    telemetry,
    turn: { intent: 'book', service: null, date: null, time: null, notes: null, needsClarification: false, reply: 'AI question?', ...turn },
  };
}

function deps(overrides: Partial<DialogDeps> = {}): DialogDeps {
  return {
    business,
    services,
    now: NOW,
    checkDate: (date) => checkDate(business, date, NOW),
    assessSlot: vi.fn(async () => ({ problem: null, alternatives: [] })),
    freeSlots: vi.fn(async () => ['09:00', '10:00', '11:00', '14:00', '16:00']),
    createBooking: vi.fn(async () => ({ ok: true as const, appointment: { id: 'appt-1' } as never })),
    listUpcoming: vi.fn(async () => []),
    ...overrides,
  };
}

const draft = (d: Partial<BookingDraft>): BookingDraft => ({ ...EMPTY_DRAFT, ...d });

describe('runDialogTurn — AI vs business-logic boundary', () => {
  it('falls back to the structured form when the AI fails, keeping the draft', async () => {
    const current = draft({ serviceId: DENTAL.id });
    const out = await runDialogTurn(current, { ok: false, reason: 'timeout', error: 'slow', telemetry }, deps());
    expect(out.draft).toEqual(current);
    expect(out.payload.action).toMatchObject({ type: 'booking_form', reason: 'assistant_unavailable', prefill: { serviceId: DENTAL.id } });
  });

  it('asks for confirmation with a summary built from validated data, not model text', async () => {
    const out = await runDialogTurn(
      EMPTY_DRAFT,
      ai({ service: 'dental cleaning', date: '2026-10-05', time: '15:00', reply: "You're booked for 3pm!" }),
      deps(),
    );
    expect(out.draft).toMatchObject({ stage: 'awaiting_confirmation', serviceId: DENTAL.id, date: '2026-10-05', time: '15:00' });
    expect(out.reply).toBe('Great — Dental Cleaning on Mon, 5 Oct at 3:00 PM (45 min). Shall I book it?');
    expect(out.payload.action).toMatchObject({ type: 'confirm_booking', booking: { serviceName: 'Dental Cleaning', startsAt: '2026-10-05T10:00:00.000Z' } });
  });

  it('never creates a booking without an explicit confirmation', async () => {
    const d = deps();
    await runDialogTurn(EMPTY_DRAFT, ai({ intent: 'confirm', service: 'Dental Cleaning', date: '2026-10-05', time: '15:00' }), d);
    expect(d.createBooking).not.toHaveBeenCalled();
  });

  it('books when the customer confirms a pending summary', async () => {
    const d = deps();
    const pending = draft({ stage: 'awaiting_confirmation', serviceId: DENTAL.id, date: '2026-10-05', time: '15:00' });
    const out = await runDialogTurn(pending, ai({ intent: 'confirm' }), d);
    expect(d.createBooking).toHaveBeenCalledOnce();
    expect(out.payload.action?.type).toBe('booking_confirmed');
    expect(out.draft).toEqual(EMPTY_DRAFT);
  });

  it('explains a closed day and clears only the date', async () => {
    const out = await runDialogTurn(draft({ serviceId: DENTAL.id }), ai({ date: '2026-10-04' }), deps());
    expect(out.reply).toContain('closed on Sundays');
    expect(out.draft).toMatchObject({ serviceId: DENTAL.id, date: null });
  });

  it('offers nearby alternatives when the requested slot is taken', async () => {
    const d = deps({
      assessSlot: vi.fn(async () => ({
        problem: { code: 'SLOT_TAKEN' as const, field: 'time' as const, message: 'That time is already booked.' },
        alternatives: ['14:30', '15:45'],
      })),
    });
    const out = await runDialogTurn(draft({ serviceId: DENTAL.id }), ai({ date: '2026-10-05', time: '15:00' }), d);
    expect(out.draft).toMatchObject({ date: '2026-10-05', time: null, stage: 'collecting' });
    expect(out.reply).toContain('2:30 PM, 3:45 PM');
    expect(out.payload.quickReplies).toEqual(['2:30 PM', '3:45 PM']);
  });

  it('handles services the business does not offer', async () => {
    const out = await runDialogTurn(EMPTY_DRAFT, ai({ service: 'Haircut' }), deps());
    expect(out.reply).toContain(`we don't offer "Haircut"`);
    expect(out.draft.serviceId).toBeNull();
    expect(out.payload.quickReplies).toContain('Dental Cleaning');
  });

  it('suggests real free times when only the time is missing', async () => {
    const out = await runDialogTurn(draft({ serviceId: DENTAL.id }), ai({ date: '2026-10-05', reply: 'What time?' }), deps());
    expect(out.reply).toBe('What time?');
    expect(out.payload.quickReplies).toEqual(['9:00 AM', '10:00 AM', '2:00 PM', '4:00 PM']);
  });

  it('replaces model replies that falsely claim a booking was made', async () => {
    const out = await runDialogTurn(EMPTY_DRAFT, ai({ service: 'Dental Cleaning', reply: "Done — you're booked!" }), deps());
    expect(out.reply).toBe('Which day would you like to come in?');
  });

  it('shows the form when the AI flags the request as ambiguous', async () => {
    const out = await runDialogTurn(draft({ serviceId: DENTAL.id }), ai({ needsClarification: true }), deps());
    expect(out.payload.action).toMatchObject({ type: 'booking_form', reason: 'needs_clarification' });
  });

  it(`shows the form after ${MAX_STALLED_TURNS} turns without progress, but not while progressing`, async () => {
    let state = draft({ serviceId: DENTAL.id });
    let out = await runDialogTurn(state, ai({}), deps());
    expect(out.payload.action).toBeUndefined();
    state = out.draft;
    out = await runDialogTurn(state, ai({}), deps());
    expect(out.payload.action).toMatchObject({ type: 'booking_form', reason: 'too_many_turns' });

    // A turn that captures something new resets the counter.
    out = await runDialogTurn(out.draft, ai({ date: '2026-10-05' }), deps());
    expect(out.draft.clarifications).toBe(0);
    expect(out.payload.action).toBeUndefined();
  });

  it('resets the draft on "start over"', async () => {
    const out = await runDialogTurn(draft({ serviceId: DENTAL.id, date: '2026-10-05' }), ai({ intent: 'reset' }), deps());
    expect(out.draft).toEqual(EMPTY_DRAFT);
  });
});
