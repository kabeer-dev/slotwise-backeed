import bcrypt from 'bcryptjs';
import { env } from '../../config/env.js';
import { AppError, isPgError, PgErrorCode } from '../../lib/errors.js';
import { signAccessToken } from '../../lib/jwt.js';
import type { AuthContext } from '../../middleware/auth.js';
import { getBusiness, getBusinessBySlug, toPublicBusiness } from '../catalog/catalog.service.js';
import type { Business } from '../catalog/catalog.types.js';
import * as users from './auth.repository.js';
import type { LoginInput, SignupInput } from './auth.schemas.js';

const BCRYPT_COST = 10;
// Compared against when the email doesn't exist, so "unknown email" and
// "wrong password" take the same time (no account enumeration via timing).
const DUMMY_HASH = bcrypt.hashSync('timing-equaliser-password', BCRYPT_COST);

export interface UserDTO {
  id: string;
  email: string;
  fullName: string;
  phone: string | null;
  role: string;
  createdAt: string;
}

function toUserDTO(u: users.UserRecord): UserDTO {
  return { id: u.id, email: u.email, fullName: u.fullName, phone: u.phone, role: u.role, createdAt: u.createdAt.toISOString() };
}

function session(user: users.UserRecord, business: Business) {
  return {
    token: signAccessToken({ userId: user.id, businessId: user.businessId, role: user.role }),
    user: toUserDTO(user),
    business: toPublicBusiness(business),
  };
}

export async function signup(input: SignupInput) {
  const business = await getBusinessBySlug(input.businessSlug ?? env.DEFAULT_BUSINESS_SLUG);
  const passwordHash = await bcrypt.hash(input.password, BCRYPT_COST);

  try {
    const user = await users.insertUser({
      businessId: business.id,
      email: input.email,
      passwordHash,
      fullName: input.fullName,
      phone: input.phone,
    });
    return session(user, business);
  } catch (err) {
    if (isPgError(err) && err.code === PgErrorCode.UNIQUE_VIOLATION) {
      throw AppError.conflict('EMAIL_TAKEN', 'An account with this email already exists', [
        { location: 'body', field: 'email', message: 'An account with this email already exists' },
      ]);
    }
    throw err;
  }
}

export async function login(input: LoginInput) {
  const business = await getBusinessBySlug(input.businessSlug ?? env.DEFAULT_BUSINESS_SLUG);
  const user = await users.findUserByEmail(business.id, input.email);
  const ok = await bcrypt.compare(input.password, user?.passwordHash ?? DUMMY_HASH);

  if (!user || !ok) throw new AppError(401, 'INVALID_CREDENTIALS', 'Incorrect email or password');

  await users.touchLastLogin(user.id);
  return session(user, business);
}

export async function me(auth: AuthContext) {
  const [user, business] = await Promise.all([users.findUserById(auth.businessId, auth.userId), getBusiness(auth.businessId)]);
  // Token is valid but the account is gone (deleted) — treat as signed out.
  if (!user) throw new AppError(401, 'ACCOUNT_NOT_FOUND', 'Your account no longer exists');
  return { user: toUserDTO(user), business: toPublicBusiness(business) };
}
