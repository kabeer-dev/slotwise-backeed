import { afterEach, describe, expect, it, vi } from 'vitest';
import { LlmBookingInterpreter } from '../../src/ai/providers/llm.interpreter.js';
import { MistralClient } from '../../src/ai/providers/mistral.client.js';
import type { TurnContext } from '../../src/ai/types.js';
import { NOW, services, TZ } from '../fixtures.js';

const ctx: TurnContext = {
  businessName: 'Lumen Health Clinic',
  timezone: TZ,
  now: NOW,
  openingHours: 'Mon–Sat, 9:00 AM – 6:00 PM',
  services: services.map((s) => ({ name: s.name, durationMinutes: s.durationMinutes, description: null })),
  draft: { service: null, date: null, time: null, notes: null, awaitingConfirmation: false },
  history: [
    { role: 'assistant', content: 'Hi! What would you like to book?' },
    { role: 'user', content: 'Dental cleaning on Monday at 3pm' },
  ],
};

const turnJson = JSON.stringify({
  intent: 'book',
  service: 'Dental Cleaning',
  date: '2026-10-05',
  time: '15:00',
  notes: null,
  needs_clarification: false,
  reply: 'Let me check that.',
});

function completion(content: string, status = 200) {
  return new Response(
    JSON.stringify({ choices: [{ message: { role: 'assistant', content } }], usage: { prompt_tokens: 610, completion_tokens: 48 } }),
    { status, headers: { 'Content-Type': 'application/json' } },
  );
}

function interpreter() {
  const client = new MistralClient({ apiKey: 'test-key', model: 'mistral-small-latest', baseUrl: 'https://api.mistral.ai/v1', timeoutMs: 1000 });
  return new LlmBookingInterpreter(client, { logPrompts: true });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Mistral integration (fetch stubbed)', () => {
  it('sends a JSON-mode chat completion request and parses the structured turn', async () => {
    const fetchMock = vi.fn(async () => completion(turnJson));
    vi.stubGlobal('fetch', fetchMock);

    const result = await interpreter().interpret(ctx);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.mistral.ai/v1/chat/completions');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer test-key');
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({ model: 'mistral-small-latest', response_format: { type: 'json_object' }, temperature: 0.2 });
    // system prompt first, leading assistant greeting dropped, ends with the user turn
    expect(body.messages.map((m: { role: string }) => m.role)).toEqual(['system', 'user']);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.turn).toMatchObject({ intent: 'book', service: 'Dental Cleaning', time: '15:00' });
      expect(result.telemetry).toMatchObject({ provider: 'mistral', promptTokens: 610, completionTokens: 48 });
    }
  });

  it('retries once on 429 and then succeeds', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('rate limited', { status: 429, headers: { 'Retry-After': '0' } }))
      .mockResolvedValueOnce(completion(turnJson));
    vi.stubGlobal('fetch', fetchMock);

    const result = await interpreter().interpret(ctx);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.ok).toBe(true);
  });

  it('does not retry client errors and reports them as failures', async () => {
    const fetchMock = vi.fn(async () => new Response('{"message":"invalid model"}', { status: 400 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await interpreter().interpret(ctx);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ ok: false, reason: 'error' });
  });

  it('reports timeouts distinctly', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    }));
    expect(await interpreter().interpret(ctx)).toMatchObject({ ok: false, reason: 'timeout' });
  });

  it('flags output that is not the expected JSON as invalid_output (and keeps the raw text for debugging)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => completion('Sure, I booked it for you!')));
    const result = await interpreter().interpret(ctx);
    expect(result).toMatchObject({ ok: false, reason: 'invalid_output' });
    expect(result.telemetry.rawOutput).toBe('Sure, I booked it for you!');
  });
});
