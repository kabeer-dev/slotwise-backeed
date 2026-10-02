/**
 * AI integration boundary.
 *
 * The rest of the app calls `interpretTurn()` and gets back either a
 * validated, structured AiTurn or a typed failure. It never throws, never
 * talks to the database on the model's behalf, and every call is logged
 * (pino + ai_interactions table) whether it succeeded or not.
 */
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { logInteraction } from './aiLog.repository.js';
import { LlmBookingInterpreter } from './providers/llm.interpreter.js';
import { MistralClient } from './providers/mistral.client.js';
import { RuleBasedInterpreter } from './providers/ruleBased.interpreter.js';
import type { BookingInterpreter, InterpretationResult, TurnContext } from './types.js';

function createInterpreter(): BookingInterpreter {
  if (env.AI_PROVIDER === 'mistral' && env.MISTRAL_API_KEY) {
    const client = new MistralClient({
      apiKey: env.MISTRAL_API_KEY,
      model: env.MISTRAL_MODEL,
      baseUrl: env.MISTRAL_BASE_URL,
      timeoutMs: env.AI_TIMEOUT_MS,
    });
    return new LlmBookingInterpreter(client, { logPrompts: env.AI_LOG_PROMPTS });
  }
  return new RuleBasedInterpreter();
}

let interpreter: BookingInterpreter = createInterpreter();

export function getInterpreterInfo() {
  return { provider: interpreter.provider, model: interpreter.model };
}

/** Test seam: swap the interpreter (e.g. to simulate failures). */
export function setInterpreter(next: BookingInterpreter) {
  interpreter = next;
}

export async function interpretTurn(
  ctx: TurnContext,
  meta: { businessId: string; sessionId: string; userId: string },
): Promise<InterpretationResult> {
  let result: InterpretationResult;
  try {
    result = await interpreter.interpret(ctx);
  } catch (err) {
    // Interpreters shouldn't throw, but a bug in one must not take down the chat.
    result = {
      ok: false,
      reason: 'error',
      error: (err as Error).message,
      telemetry: { provider: interpreter.provider, model: interpreter.model, latencyMs: 0 },
    };
  }

  const t = result.telemetry;
  const summary = {
    sessionId: meta.sessionId,
    provider: t.provider,
    model: t.model,
    latencyMs: t.latencyMs,
    tokens: t.promptTokens !== undefined ? { prompt: t.promptTokens, completion: t.completionTokens } : undefined,
    status: result.ok ? 'success' : result.reason,
    intent: result.ok ? result.turn.intent : undefined,
  };
  if (result.ok) logger.info({ ai: summary }, 'AI turn interpreted');
  else logger.warn({ ai: summary, error: result.error }, 'AI turn failed — falling back');

  logInteraction(meta, result).catch((err) => logger.warn({ err }, 'Failed to persist AI interaction'));
  return result;
}
