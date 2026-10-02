import { pool, type Queryable } from '../../db/pool.js';
import type { BusyInterval } from './scheduling.js';
import type { AppointmentDTO, AppointmentScope, AppointmentSource } from './appointments.types.js';

interface AppointmentRow extends Omit<AppointmentDTO, 'startsAt' | 'endsAt' | 'createdAt'> {
  startsAt: Date;
  endsAt: Date;
  createdAt: Date;
}

const SELECT_APPOINTMENT = `
  SELECT a.id, a.status, a.source, a.notes,
         a.starts_at       AS "startsAt",
         a.ends_at         AS "endsAt",
         a.created_at      AS "createdAt",
         a.chat_session_id AS "chatSessionId",
         json_build_object('id', s.id, 'name', s.name, 'durationMinutes', s.duration_minutes) AS service
  FROM appointments a
  JOIN services s ON s.id = a.service_id`;

function toDTO(row: AppointmentRow): AppointmentDTO {
  return {
    ...row,
    startsAt: row.startsAt.toISOString(),
    endsAt: row.endsAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}

export async function listForUser(
  businessId: string,
  userId: string,
  scope: AppointmentScope,
  limit = 50,
  db: Queryable = pool,
): Promise<AppointmentDTO[]> {
  const filter =
    scope === 'upcoming'
      ? `AND a.status IN ('pending', 'confirmed') AND a.ends_at >= now() ORDER BY a.starts_at ASC`
      : `AND (a.status NOT IN ('pending', 'confirmed') OR a.ends_at < now()) ORDER BY a.starts_at DESC`;

  const { rows } = await db.query<AppointmentRow>(
    `${SELECT_APPOINTMENT}
     WHERE a.business_id = $1 AND a.user_id = $2 ${filter}
     LIMIT $3`,
    [businessId, userId, limit],
  );
  return rows.map(toDTO);
}

export async function findForUser(businessId: string, userId: string, id: string, db: Queryable = pool) {
  const { rows } = await db.query<AppointmentRow>(
    `${SELECT_APPOINTMENT} WHERE a.business_id = $1 AND a.user_id = $2 AND a.id = $3`,
    [businessId, userId, id],
  );
  return rows[0] ? toDTO(rows[0]) : null;
}

/** Live bookings overlapping [from, to). Uses the GiST index behind the exclusion constraint. */
export async function findBusyIntervals(businessId: string, from: Date, to: Date, db: Queryable = pool): Promise<BusyInterval[]> {
  const { rows } = await db.query<{ starts_at: Date; ends_at: Date }>(
    `SELECT starts_at, ends_at FROM appointments
     WHERE business_id = $1
       AND status IN ('pending', 'confirmed')
       AND tstzrange(starts_at, ends_at, '[)') && tstzrange($2, $3, '[)')`,
    [businessId, from, to],
  );
  return rows.map((r) => ({ start: r.starts_at.getTime(), end: r.ends_at.getTime() }));
}

export async function insert(
  data: {
    businessId: string;
    userId: string;
    serviceId: string;
    chatSessionId: string | null;
    startsAt: Date;
    endsAt: Date;
    notes: string | null;
    source: AppointmentSource;
  },
  db: Queryable = pool,
): Promise<AppointmentDTO> {
  const { rows } = await db.query<AppointmentRow>(
    `WITH a AS (
       INSERT INTO appointments (business_id, user_id, service_id, chat_session_id, starts_at, ends_at, notes, source, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'confirmed')
       RETURNING *
     )
     ${SELECT_APPOINTMENT.replace('FROM appointments a', 'FROM a')}`,
    [data.businessId, data.userId, data.serviceId, data.chatSessionId, data.startsAt, data.endsAt, data.notes, data.source],
  );
  return toDTO(rows[0]!);
}

export async function cancel(businessId: string, userId: string, id: string, db: Queryable = pool): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE appointments SET status = 'cancelled', cancelled_at = now()
     WHERE business_id = $1 AND user_id = $2 AND id = $3 AND status IN ('pending', 'confirmed')`,
    [businessId, userId, id],
  );
  return rowCount === 1;
}

export async function chatSessionBelongsTo(businessId: string, userId: string, sessionId: string, db: Queryable = pool) {
  const { rowCount } = await db.query(
    'SELECT 1 FROM chat_sessions WHERE business_id = $1 AND user_id = $2 AND id = $3',
    [businessId, userId, sessionId],
  );
  return rowCount === 1;
}
