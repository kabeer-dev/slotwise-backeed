import { buildSystemPrompt, normalizeHistory, parseModelOutput } from '../prompt.js';
import type { BookingInterpreter, InterpretationResult, TurnContext } from '../types.js';
import { LlmError, type LlmMessage, type MistralClient } from './mistral.client.js';

/** Booking interpreter backed by an LLM with JSON output. */
export class LlmBookingInterpreter implements BookingInterpreter {
  readonly provider = 'mistral';

  constructor(
    private readonly client: MistralClient,
    private readonly options: { logPrompts: boolean },
  ) {}

  get model() {
    return this.client.model;
  }

  async interpret(ctx: TurnContext): Promise<InterpretationResult> {
    const messages: LlmMessage[] = [{ role: 'system', content: buildSystemPrompt(ctx) }, ...normalizeHistory(ctx.history)];
    const started = performance.now();
    const telemetry = () => ({
      provider: this.provider,
      model: this.model,
      latencyMs: Math.round(performance.now() - started),
      requestMessages: this.options.logPrompts ? messages : undefined,
    });

    let completion;
    try {
      completion = await this.client.complete(messages, { json: true, temperature: 0.2, maxTokens: 400 });
    } catch (err) {
      const timeout = err instanceof LlmError && err.kind === 'timeout';
      return { ok: false, reason: timeout ? 'timeout' : 'error', error: (err as Error).message, telemetry: telemetry() };
    }

    const base = {
      ...telemetry(),
      promptTokens: completion.promptTokens,
      completionTokens: completion.completionTokens,
      rawOutput: completion.content,
    };
    const turn = parseModelOutput(completion.content);
    if (!turn) return { ok: false, reason: 'invalid_output', error: 'Model output did not match the expected JSON shape', telemetry: base };
    return { ok: true, turn, telemetry: base };
  }
}
