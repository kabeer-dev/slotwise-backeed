import { createServer } from 'node:http';
import { getInterpreterInfo } from './ai/index.js';
import { createApp } from './app.js';
import { env } from './config/env.js';
import { pool } from './db/pool.js';
import { logger } from './lib/logger.js';
import { initRealtime, realtime } from './realtime/socket.js';

const app = createApp();
const server = createServer(app);
initRealtime(server);

server.listen(env.PORT, () => {
  const ai = getInterpreterInfo();
  logger.info({ port: env.PORT, env: env.NODE_ENV, ai }, `Slotwise API listening on :${env.PORT}`);
  if (ai.provider === 'mock') {
    logger.warn('AI_PROVIDER=mock — using the rule-based interpreter. Set MISTRAL_API_KEY to use the LLM.');
  }
});

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'Shutting down');
  const force = setTimeout(() => process.exit(1), 10_000).unref();
  server.close();
  await realtime.close();
  await pool.end();
  clearTimeout(force);
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => logger.error({ err: reason }, 'Unhandled promise rejection'));
