import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { AppError } from './errors.js';
import type { AuthContext, UserRole } from '../middleware/auth.js';

interface TokenClaims {
  sub: string;
  bid: string;
  role: UserRole;
}

export function signAccessToken(ctx: AuthContext): string {
  const claims: TokenClaims = { sub: ctx.userId, bid: ctx.businessId, role: ctx.role };
  return jwt.sign(claims, env.JWT_SECRET, {
    expiresIn: env.JWT_EXPIRES_IN as jwt.SignOptions['expiresIn'],
    algorithm: 'HS256',
    issuer: 'slotwise-api',
  });
}

export function verifyAccessToken(token: string): AuthContext {
  try {
    const payload = jwt.verify(token, env.JWT_SECRET, {
      algorithms: ['HS256'],
      issuer: 'slotwise-api',
    }) as jwt.JwtPayload & Partial<TokenClaims>;

    if (!payload.sub || !payload.bid || !payload.role) throw new Error('Malformed token claims');
    return { userId: payload.sub, businessId: payload.bid, role: payload.role };
  } catch (err) {
    const expired = err instanceof jwt.TokenExpiredError;
    throw new AppError(401, expired ? 'TOKEN_EXPIRED' : 'INVALID_TOKEN', expired ? 'Your session has expired' : 'Invalid token');
  }
}
