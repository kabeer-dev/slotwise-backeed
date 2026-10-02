import { randomUUID } from 'node:crypto';
import { pinoHttp } from 'pino-http';
import { logger } from '../lib/logger.js';

const REQUEST_ID_RE = /^[\w-]{8,64}$/;

/**
 * Structured access log + request id. The id is taken from X-Request-Id when
 * a proxy supplies a sane one, echoed back in the response header, and
 * included in every error body so a user report can be traced to log lines.
 */
export const requestLogger = pinoHttp({
  logger,
  genReqId: (req, res) => {
    const incoming = req.headers['x-request-id'];
    const id = typeof incoming === 'string' && REQUEST_ID_RE.test(incoming) ? incoming : randomUUID();
    res.setHeader('X-Request-Id', id);
    return id;
  },
  customLogLevel: (_req, res, err) => {
    if (err || res.statusCode >= 500) return 'error';
    if (res.statusCode >= 400) return 'warn';
    return 'info';
  },
  customSuccessMessage: (req, res, time) => `${req.method} ${req.url} ${res.statusCode} ${Math.round(time)}ms`,
  customErrorMessage: (req, res) => `${req.method} ${req.url} ${res.statusCode}`,
  serializers: {
    req: (req) => ({ id: req.id, method: req.method, url: req.url }),
    res: (res) => ({ statusCode: res.statusCode }),
  },
  autoLogging: { ignore: (req) => req.url === '/health' },
});
