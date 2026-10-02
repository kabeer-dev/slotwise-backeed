import { pino } from 'pino';
import { env, isProd } from '../config/env.js';

const usePretty = !isProd && env.NODE_ENV !== 'test' && process.stdout.isTTY;

export const logger = pino({
  level: env.NODE_ENV === 'test' ? 'silent' : env.LOG_LEVEL,
  base: { service: 'slotwise-api' },
  redact: {
    paths: ['req.headers.authorization', 'req.headers.cookie', '*.password', '*.passwordHash', '*.token'],
    censor: '[redacted]',
  },
  ...(usePretty ? { transport: { target: 'pino-pretty', options: { singleLine: true, translateTime: 'HH:MM:ss' } } } : {}),
});

export type Logger = typeof logger;
