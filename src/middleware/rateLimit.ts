import { ipKeyGenerator, rateLimit, type Options } from 'express-rate-limit';
import { env, isTest } from '../config/env.js';

/**
 * In-memory rate limiting (per instance). Behind a load balancer with several
 * instances, plug in a shared store (rate-limit-redis) — the limiter
 * definitions below stay the same.
 */
const common: Partial<Options> = {
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  skip: () => isTest,
  handler: (_req, res, _next, options) => {
    res.status(options.statusCode).json({
      error: {
        code: 'RATE_LIMITED',
        message: typeof options.message === 'string' ? options.message : 'Too many requests',
        requestId: res.req.id,
      },
    });
  },
};

/** Broad protection for every route. */
export const globalLimiter = rateLimit({
  ...common,
  windowMs: 15 * 60_000,
  limit: 600,
  message: 'Too many requests, please slow down.',
});

/** Brute-force protection for login/signup. Only failed attempts count. */
export const authLimiter = rateLimit({
  ...common,
  windowMs: 15 * 60_000,
  limit: 20,
  skipSuccessfulRequests: true,
  message: 'Too many attempts. Please wait a few minutes and try again.',
});

/** Chat messages trigger paid LLM calls, so they are limited per user, not per IP. */
export const chatLimiter = rateLimit({
  ...common,
  windowMs: 60_000,
  limit: env.RATE_LIMIT_CHAT_PER_MINUTE,
  keyGenerator: (req) => req.auth?.userId ?? ipKeyGenerator(req.ip ?? 'unknown'),
  message: "You're sending messages too quickly. Please wait a moment.",
});
