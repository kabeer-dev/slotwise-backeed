import type { Request, RequestHandler } from 'express';
import { AppError } from '../lib/errors.js';
import { verifyAccessToken } from '../lib/jwt.js';

export type UserRole = 'customer' | 'staff' | 'admin';

/** Who is calling. Every tenant-scoped query takes its business_id from here, never from the client. */
export interface AuthContext {
  userId: string;
  businessId: string;
  role: UserRole;
}

export const requireAuth: RequestHandler = (req, _res, next) => {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) throw AppError.unauthorized();
  req.auth = verifyAccessToken(header.slice('Bearer '.length).trim());
  next();
};

export function requireRole(...roles: UserRole[]): RequestHandler {
  return (req, _res, next) => {
    if (!req.auth || !roles.includes(req.auth.role)) throw AppError.forbidden();
    next();
  };
}

export function getAuth(req: Request): AuthContext {
  if (!req.auth) throw AppError.unauthorized();
  return req.auth;
}
