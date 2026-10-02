import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
import { isProd } from '../config/env.js';
import { AppError, isPgError, PgErrorCode } from '../lib/errors.js';
import { formatZodIssues } from './validate.js';

export const notFound: RequestHandler = (req) => {
  throw new AppError(404, 'ROUTE_NOT_FOUND', `No route for ${req.method} ${req.path}`);
};

/** Translate anything thrown into a consistent JSON error envelope. */
function toAppError(err: unknown): AppError {
  if (err instanceof AppError) return err;

  if (err instanceof ZodError) {
    return new AppError(400, 'VALIDATION_ERROR', 'Invalid request', formatZodIssues(err, 'body'));
  }

  // body-parser errors
  const type = (err as { type?: string } | null)?.type;
  if (type === 'entity.parse.failed') return new AppError(400, 'INVALID_JSON', 'Malformed JSON body');
  if (type === 'entity.too.large') return new AppError(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large');

  if (isPgError(err)) {
    switch (err.code) {
      case PgErrorCode.EXCLUSION_VIOLATION:
        return new AppError(409, 'SLOT_UNAVAILABLE', 'That time slot was just taken. Please pick another one.');
      case PgErrorCode.UNIQUE_VIOLATION:
        return new AppError(409, 'CONFLICT', 'This record already exists');
      case PgErrorCode.FOREIGN_KEY_VIOLATION:
        return new AppError(409, 'REFERENCE_NOT_FOUND', 'A referenced record does not exist');
      case PgErrorCode.CHECK_VIOLATION:
        return new AppError(400, 'CONSTRAINT_VIOLATION', 'The request violates a data constraint');
      case PgErrorCode.INVALID_TEXT_REPRESENTATION:
        return new AppError(400, 'INVALID_ID', 'Malformed identifier');
    }
  }

  return new AppError(500, 'INTERNAL_ERROR', 'Something went wrong. Please try again.');
}

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  const appErr = toAppError(err);

  if (appErr.status >= 500) {
    req.log.error({ err }, 'Unhandled error');
  }

  if (res.headersSent) return;

  res.status(appErr.status).json({
    error: {
      code: appErr.code,
      message: appErr.status >= 500 && !isProd && err instanceof Error ? `${appErr.message} (${err.message})` : appErr.message,
      ...(appErr.details !== undefined ? { details: appErr.details } : {}),
      requestId: req.id,
    },
  });
};
