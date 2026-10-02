import { pool, type Queryable } from '../../db/pool.js';
import type { UserRole } from '../../middleware/auth.js';

export interface UserRecord {
  id: string;
  businessId: string;
  email: string;
  passwordHash: string;
  fullName: string;
  phone: string | null;
  role: UserRole;
  createdAt: Date;
}

const USER_COLUMNS = `
  id, business_id AS "businessId", email, password_hash AS "passwordHash",
  full_name AS "fullName", phone, role, created_at AS "createdAt"`;

export async function findUserByEmail(businessId: string, email: string, db: Queryable = pool) {
  const { rows } = await db.query<UserRecord>(
    `SELECT ${USER_COLUMNS} FROM users WHERE business_id = $1 AND email = $2`,
    [businessId, email],
  );
  return rows[0] ?? null;
}

export async function findUserById(businessId: string, id: string, db: Queryable = pool) {
  const { rows } = await db.query<UserRecord>(
    `SELECT ${USER_COLUMNS} FROM users WHERE business_id = $1 AND id = $2`,
    [businessId, id],
  );
  return rows[0] ?? null;
}

export async function insertUser(
  data: { businessId: string; email: string; passwordHash: string; fullName: string; phone?: string | undefined },
  db: Queryable = pool,
) {
  const { rows } = await db.query<UserRecord>(
    `INSERT INTO users (business_id, email, password_hash, full_name, phone)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING ${USER_COLUMNS}`,
    [data.businessId, data.email, data.passwordHash, data.fullName, data.phone ?? null],
  );
  return rows[0]!;
}

export async function touchLastLogin(id: string, db: Queryable = pool) {
  await db.query('UPDATE users SET last_login_at = now() WHERE id = $1', [id]);
}
