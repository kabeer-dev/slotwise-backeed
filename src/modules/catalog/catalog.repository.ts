import { pool, type Queryable } from '../../db/pool.js';
import type { Business, Service } from './catalog.types.js';

const BUSINESS_COLUMNS = `
  id, slug, name, timezone,
  to_char(opens_at, 'HH24:MI')  AS "opensAt",
  to_char(closes_at, 'HH24:MI') AS "closesAt",
  working_days                  AS "workingDays",
  slot_interval_minutes         AS "slotIntervalMinutes",
  booking_horizon_days          AS "bookingHorizonDays"`;

const SERVICE_COLUMNS = `
  id, name, description,
  duration_minutes AS "durationMinutes",
  is_active        AS "isActive"`;

export async function findBusinessById(id: string, db: Queryable = pool): Promise<Business | null> {
  const { rows } = await db.query<Business>(`SELECT ${BUSINESS_COLUMNS} FROM businesses WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

export async function findBusinessBySlug(slug: string, db: Queryable = pool): Promise<Business | null> {
  const { rows } = await db.query<Business>(`SELECT ${BUSINESS_COLUMNS} FROM businesses WHERE slug = $1`, [slug]);
  return rows[0] ?? null;
}

export async function listServices(businessId: string, db: Queryable = pool): Promise<Service[]> {
  const { rows } = await db.query<Service>(
    `SELECT ${SERVICE_COLUMNS} FROM services
     WHERE business_id = $1 AND is_active
     ORDER BY name`,
    [businessId],
  );
  return rows;
}

export async function findServiceById(businessId: string, serviceId: string, db: Queryable = pool): Promise<Service | null> {
  const { rows } = await db.query<Service>(
    `SELECT ${SERVICE_COLUMNS} FROM services WHERE business_id = $1 AND id = $2`,
    [businessId, serviceId],
  );
  return rows[0] ?? null;
}
