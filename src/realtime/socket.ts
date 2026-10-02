import type { Server as HttpServer } from 'node:http';
import { Server } from 'socket.io';
import { env } from '../config/env.js';
import { verifyAccessToken } from '../lib/jwt.js';
import { logger } from '../lib/logger.js';
import type { AuthContext } from '../middleware/auth.js';
import type { ChatMessageDTO, ChatSessionDTO } from '../modules/chat/chat.types.js';

/**
 * Server → client push over WebSockets (Socket.IO, with long-polling fallback).
 *
 * Writes always go through the REST API (validated, rate limited, logged).
 * The socket only pushes what changed, to every tab the user has open:
 * new messages, the assistant "typing" state, session updates and
 * appointment changes. Each socket joins a private room per user, so
 * there is no client-controlled room joining to authorise.
 */
export interface ServerToClientEvents {
  'chat:message': (e: { sessionId: string; message: ChatMessageDTO }) => void;
  'chat:typing': (e: { sessionId: string; isTyping: boolean }) => void;
  'chat:session': (e: { session: ChatSessionDTO }) => void;
  'appointments:changed': (e: { reason: 'created' | 'cancelled'; appointmentId: string }) => void;
}

interface SocketData {
  auth: AuthContext;
}

type RealtimeServer = Server<Record<string, never>, ServerToClientEvents, Record<string, never>, SocketData>;

let io: RealtimeServer | null = null;
const userRoom = (userId: string) => `user:${userId}`;

export function initRealtime(httpServer: HttpServer): RealtimeServer {
  io = new Server<Record<string, never>, ServerToClientEvents, Record<string, never>, SocketData>(httpServer, {
    cors: { origin: env.corsOrigins },
    serveClient: false,
  });

  io.use((socket, next) => {
    const token = (socket.handshake.auth as { token?: unknown }).token;
    try {
      if (typeof token !== 'string') throw new Error('missing token');
      socket.data.auth = verifyAccessToken(token);
      next();
    } catch {
      next(new Error('UNAUTHORIZED'));
    }
  });

  io.on('connection', (socket) => {
    const { userId } = socket.data.auth;
    void socket.join(userRoom(userId));
    logger.debug({ userId, socketId: socket.id }, 'socket connected');
    socket.on('disconnect', (reason) => logger.debug({ userId, reason }, 'socket disconnected'));
  });

  return io;
}

export const realtime = {
  toUser<E extends keyof ServerToClientEvents>(userId: string, event: E, ...args: Parameters<ServerToClientEvents[E]>) {
    // No-op when sockets aren't initialised (tests, scripts).
    io?.to(userRoom(userId)).emit(event, ...args);
  },
  async close() {
    await io?.close();
    io = null;
  },
};
