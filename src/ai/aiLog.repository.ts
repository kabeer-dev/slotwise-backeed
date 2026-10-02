import { pool } from '../db/pool.js';
import { PROMPT_VERSION } from './prompt.js';
import type { InterpretationResult } from './types.js';

/** Persist one AI interaction (debugging + analytics). */
export async function logInteraction(meta: { businessId: string; sessionId: string; userId: string }, result: InterpretationResult) {
  const t = result.telemetry;
  await pool.query(
    `INSERT INTO ai_interactions
       (business_id, session_id, user_id, provider, model, prompt_version, status, latency_ms,
        prompt_tokens, completion_tokens, request_messages, raw_output, parsed_output, error)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
    [
      meta.businessId,
      meta.sessionId,
      meta.userId,
      t.provider,
      t.model,
      PROMPT_VERSION,
      result.ok ? 'success' : result.reason,
      t.latencyMs,
      t.promptTokens ?? null,
      t.completionTokens ?? null,
      t.requestMessages ? JSON.stringify(t.requestMessages) : null,
      t.rawOutput ?? null,
      result.ok ? JSON.stringify(result.turn) : null,
      result.ok ? null : result.error,
    ],
  );
}
