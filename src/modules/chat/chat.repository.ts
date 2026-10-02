import type { PoolClient } from 'pg';
import { pool, type Queryable } from '../../db/pool.js';
import type { ConversationMessage } from '../../ai/types.js';
import {
  normalizeDraft,
  type BookingDraft,
  type ChatMessageDTO,
  type ChatSessionDTO,
  type MessagePayload,
} from './chat.types.js';

const SESSION_COLUMNS = `
  id, title, status,
  booking_state   AS "bookingState",
  message_count   AS "messageCount",
  last_message_at AS "lastMessageAt",
  created_at      AS "createdAt"`;

const MESSAGE_COLUMNS = `
  id, session_id AS "sessionId", role, content, payload,
  client_message_id AS "clientMessageId",
  created_at AS "createdAt"`;

interface SessionRow extends Omit<ChatSessionDTO, 'lastMessageAt' | 'createdAt' | 'bookingState'> {
  bookingState: unknown;
  lastMessageAt: Date;
  createdAt: Date;
}
interface MessageRow extends Omit<ChatMessageDTO, 'createdAt'> {
  createdAt: Date;
}

const toSession = (r: SessionRow): ChatSessionDTO => ({
  ...r,
  bookingState: normalizeDraft(r.bookingState),
  lastMessageAt: r.lastMessageAt.toISOString(),
  createdAt: r.createdAt.toISOString(),
});
const toMessage = (r: MessageRow): ChatMessageDTO => ({ ...r, createdAt: r.createdAt.toISOString() });

export async function insertSession(businessId: string, userId: string, db: Queryable = pool) {
  const { rows } = await db.query<SessionRow>(
    `INSERT INTO chat_sessions (business_id, user_id) VALUES ($1, $2) RETURNING ${SESSION_COLUMNS}`,
    [businessId, userId],
  );
  return toSession(rows[0]!);
}

export async function listSessions(businessId: string, userId: string, limit = 30) {
  const { rows } = await pool.query<SessionRow>(
    `SELECT ${SESSION_COLUMNS} FROM chat_sessions
     WHERE business_id = $1 AND user_id = $2
     ORDER BY last_message_at DESC
     LIMIT $3`,
    [businessId, userId, limit],
  );
  return rows.map(toSession);
}

export async function findSession(businessId: string, userId: string, id: string, db: Queryable = pool) {
  const { rows } = await db.query<SessionRow>(
    `SELECT ${SESSION_COLUMNS} FROM chat_sessions WHERE business_id = $1 AND user_id = $2 AND id = $3`,
    [businessId, userId, id],
  );
  return rows[0] ? toSession(rows[0]) : null;
}

export async function insertMessage(
  data: {
    sessionId: string;
    role: ChatMessageDTO['role'];
    content: string;
    payload?: MessagePayload | null;
    clientMessageId?: string | null;
  },
  db: Queryable = pool,
) {
  const { rows } = await db.query<MessageRow>(
    `INSERT INTO chat_messages (session_id, role, content, payload, client_message_id)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING ${MESSAGE_COLUMNS}`,
    [data.sessionId, data.role, data.content, data.payload ? JSON.stringify(data.payload) : null, data.clientMessageId ?? null],
  );
  return toMessage(rows[0]!);
}

/** Keyset pagination: newest `limit` messages older than `beforeId`, returned oldest → newest. */
export async function listMessages(sessionId: string, opts: { limit: number; beforeId?: string | undefined }) {
  const { rows } = await pool.query<MessageRow>(
    `SELECT ${MESSAGE_COLUMNS} FROM chat_messages
     WHERE session_id = $1 AND ($2::bigint IS NULL OR id < $2::bigint)
     ORDER BY id DESC
     LIMIT $3`,
    [sessionId, opts.beforeId ?? null, opts.limit],
  );
  return rows.reverse().map(toMessage);
}

/** Conversation memory for the model: the last `limit` user/assistant turns, oldest first. */
export async function recentHistory(sessionId: string, limit: number): Promise<ConversationMessage[]> {
  const { rows } = await pool.query<ConversationMessage>(
    `SELECT role, content FROM (
       SELECT id, role, content FROM chat_messages
       WHERE session_id = $1 AND role IN ('user', 'assistant')
       ORDER BY id DESC
       LIMIT $2
     ) recent
     ORDER BY id ASC`,
    [sessionId, limit],
  );
  return rows;
}

export async function updateSessionAfterTurn(
  sessionId: string,
  data: { draft: BookingDraft; messagesAdded: number; title?: string | undefined },
  db: Queryable | PoolClient = pool,
) {
  const { rows } = await db.query<SessionRow>(
    `UPDATE chat_sessions
     SET booking_state   = $2,
         message_count   = message_count + $3,
         last_message_at = now(),
         title           = COALESCE($4, title)
     WHERE id = $1
     RETURNING ${SESSION_COLUMNS}`,
    [sessionId, JSON.stringify(data.draft), data.messagesAdded, data.title ?? null],
  );
  return toSession(rows[0]!);
}
