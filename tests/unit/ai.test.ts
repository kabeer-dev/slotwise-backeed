import { describe, expect, it } from 'vitest';
import { buildSystemPrompt, normalizeHistory, parseModelOutput } from '../../src/ai/prompt.js';
import { RuleBasedInterpreter, matchServiceByKeywords } from '../../src/ai/providers/ruleBased.interpreter.js';
import type { TurnContext } from '../../src/ai/types.js';
import { NOW, services, TZ } from '../fixtures.js';

const ctx = (message: string, draft: Partial<TurnContext['draft']> = {}): TurnContext => ({
  businessName: 'Lumen Health Clinic',
  timezone: TZ,
  now: NOW,
  openingHours: 'Mon–Sat, 9:00 AM – 6:00 PM',
  services: services.map((s) => ({ name: s.name, durationMinutes: s.durationMinutes, description: s.description })),
  draft: { service: null, date: null, time: null, notes: null, awaitingConfirmation: false, ...draft },
  history: [{ role: 'user', content: message }],
});

describe('parseModelOutput (LLM output guardrail)', () => {
  const valid = { intent: 'book', service: 'Dental Cleaning', date: '2026-10-05', time: '15:00', notes: null, needs_clarification: false, reply: 'Which time?' };

  it('parses a valid JSON object', () => {
    expect(parseModelOutput(JSON.stringify(valid))).toMatchObject({ intent: 'book', service: 'Dental Cleaning', time: '15:00', needsClarification: false });
  });

  it('tolerates code fences and surrounding text', () => {
    expect(parseModelOutput('Sure!\n```json\n' + JSON.stringify(valid) + '\n```')?.intent).toBe('book');
  });

  it('normalises times and drops invalid fields instead of failing', () => {
    const out = parseModelOutput(JSON.stringify({ ...valid, time: '9:30:00', date: 'next monday', intent: 'BOOK' }));
    expect(out).toMatchObject({ intent: 'book', time: '09:30', date: null });
  });

  it('maps unknown intents to "other"', () => {
    expect(parseModelOutput(JSON.stringify({ ...valid, intent: 'delete_all_bookings' }))?.intent).toBe('other');
  });

  it('rejects output without a reply, or that is not JSON', () => {
    expect(parseModelOutput(JSON.stringify({ ...valid, reply: '' }))).toBeNull();
    expect(parseModelOutput('I think you want a cleaning.')).toBeNull();
    expect(parseModelOutput('{not json}')).toBeNull();
  });
});

describe('prompt construction', () => {
  it('grounds the model in services, current time and collected details', () => {
    const prompt = buildSystemPrompt(ctx('hi', { service: 'Dental Cleaning', awaitingConfirmation: true }));
    expect(prompt).toContain('Friday, 2026-10-02 13:50');
    expect(prompt).toContain('Physiotherapy Session (60 min)');
    expect(prompt).toContain('"service":"Dental Cleaning"');
    expect(prompt).toContain('awaiting the customer\'s yes/no: YES');
  });

  it('normalises history to start with the user and alternate roles', () => {
    const out = normalizeHistory([
      { role: 'assistant', content: 'Hi!' },
      { role: 'user', content: 'a' },
      { role: 'user', content: 'b' },
      { role: 'assistant', content: 'c' },
      { role: 'user', content: 'd' },
    ]);
    expect(out.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(out[0]?.content).toBe('a\nb');
  });
});

describe('RuleBasedInterpreter (offline mock)', () => {
  const interpreter = new RuleBasedInterpreter();

  it('extracts service, relative date and time', () => {
    const t = interpreter.parse('I need a dental cleaning tomorrow at 3pm', ctx(''));
    expect(t).toMatchObject({ intent: 'book', service: 'Dental Cleaning', date: '2026-10-03', time: '15:00' });
  });

  it('reads a bare hour inside business hours as the afternoon', () => {
    expect(interpreter.parse('Monday at 4', ctx('')).time).toBe('16:00');
  });

  it('flags vague requests for clarification', () => {
    const t = interpreter.parse('sometime next week', ctx('', { service: 'Dental Cleaning' }));
    expect(t).toMatchObject({ date: null, time: null, needsClarification: true });
  });

  it('only treats "yes" as confirm when a summary is pending', () => {
    expect(interpreter.parse('yes please', ctx('', { awaitingConfirmation: true })).intent).toBe('confirm');
    expect(interpreter.parse('yes please', ctx('')).intent).not.toBe('confirm');
  });

  it('recognises list and reset intents', () => {
    expect(interpreter.parse('what are my upcoming appointments?', ctx('')).intent).toBe('list_appointments');
    expect(interpreter.parse("let's start over", ctx('')).intent).toBe('reset');
  });

  it('matches services by word stems', () => {
    const names = services.map((s) => s.name);
    expect(matchServiceByKeywords('can I see the physio', names)).toBe('Physiotherapy Session');
    expect(matchServiceByKeywords('I want a consultation', names)).toBe('General Consultation');
    expect(matchServiceByKeywords('haircut please', names)).toBeNull();
  });

  it('can simulate an outage for demos (#ai-down)', async () => {
    const result = await interpreter.interpret(ctx('book #ai-down'));
    expect(result.ok).toBe(false);
  });
});
