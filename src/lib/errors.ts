/**
 * Application error carrying an HTTP status and a stable, machine-readable code.
 * Anything thrown that is NOT an AppError is treated as a 500 and its message
 * is hidden from clients in production.
 */
export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }

  static badRequest(message: string, details?: unknown) {
    return new AppError(400, 'BAD_REQUEST', message, details);
  }
  static unauthorized(message = 'Authentication required') {
    return new AppError(401, 'UNAUTHORIZED', message);
  }
  static forbidden(message = 'You do not have access to this resource') {
    return new AppError(403, 'FORBIDDEN', message);
  }
  static notFound(resource = 'Resource') {
    return new AppError(404, 'NOT_FOUND', `${resource} not found`);
  }
  static conflict(code: string, message: string, details?: unknown) {
    return new AppError(409, code, message, details);
  }
  static unprocessable(code: string, message: string, details?: unknown) {
    return new AppError(422, code, message, details);
  }
}

/** Postgres SQLSTATE codes we translate into client-facing errors. */
export const PgErrorCode = {
  UNIQUE_VIOLATION: '23505',
  FOREIGN_KEY_VIOLATION: '23503',
  CHECK_VIOLATION: '23514',
  EXCLUSION_VIOLATION: '23P01',
  INVALID_TEXT_REPRESENTATION: '22P02',
} as const;

export function isPgError(err: unknown): err is { code: string; constraint?: string; detail?: string } {
  return typeof err === 'object' && err !== null && 'code' in err && typeof (err as { code: unknown }).code === 'string'
    && /^[0-9A-Z]{5}$/.test((err as { code: string }).code);
}
