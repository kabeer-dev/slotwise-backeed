-- =============================================================================
-- Slotwise — PostgreSQL schema (DDL)
-- Target: PostgreSQL 14+   (gen_random_uuid() is core since 13)
--
-- The file is idempotent: it can be re-run safely on an existing database
-- (`npm run db:migrate` does exactly that). See database/README.md for the
-- reasoning behind the indexes and constraints.
-- =============================================================================

-- btree_gist lets one GiST exclusion constraint combine "=" on a uuid column
-- with "&&" (overlaps) on a time range. It powers double-booking prevention.
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- Generic updated_at maintenance -----------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

-- -----------------------------------------------------------------------------
-- businesses — the tenant. Every other row hangs off a business_id.
-- Opening hours live here (not in code) so each tenant can differ.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS businesses (
  id                     uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  slug                   text        NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9-]{3,60}$'),
  name                   text        NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  timezone               text        NOT NULL DEFAULT 'UTC',          -- IANA name, e.g. Asia/Karachi
  opens_at               time        NOT NULL DEFAULT '09:00',
  closes_at              time        NOT NULL DEFAULT '18:00',
  working_days           smallint[]  NOT NULL DEFAULT '{1,2,3,4,5,6}', -- ISO weekdays, 1 = Monday
  slot_interval_minutes  smallint    NOT NULL DEFAULT 15 CHECK (slot_interval_minutes BETWEEN 5 AND 240),
  booking_horizon_days   smallint    NOT NULL DEFAULT 60 CHECK (booking_horizon_days BETWEEN 1 AND 365),
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT businesses_hours_chk CHECK (closes_at > opens_at),
  CONSTRAINT businesses_working_days_chk CHECK (working_days <@ '{1,2,3,4,5,6,7}'::smallint[])
);

-- -----------------------------------------------------------------------------
-- users — authentication + profile. Emails are unique *per business*, so the
-- same person can be a customer of two tenants with separate accounts.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id    uuid        NOT NULL REFERENCES businesses (id) ON DELETE CASCADE,
  email          text        NOT NULL CHECK (email = lower(email) AND length(email) <= 254),
  password_hash  text        NOT NULL,
  full_name      text        NOT NULL CHECK (length(full_name) BETWEEN 1 AND 120),
  phone          text        CHECK (length(phone) <= 32),
  role           text        NOT NULL DEFAULT 'customer' CHECK (role IN ('customer', 'staff', 'admin')),
  last_login_at  timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_business_email_key UNIQUE (business_id, email),
  -- Target for composite foreign keys: guarantees child rows can only point at
  -- a user of the *same* business (cross-tenant references become impossible).
  CONSTRAINT users_business_id_key    UNIQUE (business_id, id)
);

-- -----------------------------------------------------------------------------
-- services — what can be booked, with its duration. The AI is given this list
-- so it maps "teeth cleaning" to a real service instead of inventing one.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS services (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id       uuid        NOT NULL REFERENCES businesses (id) ON DELETE CASCADE,
  name              text        NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  description       text        CHECK (length(description) <= 500),
  duration_minutes  smallint    NOT NULL CHECK (duration_minutes BETWEEN 5 AND 480),
  is_active         boolean     NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT services_business_name_key UNIQUE (business_id, name),
  CONSTRAINT services_business_id_key   UNIQUE (business_id, id)
);

-- -----------------------------------------------------------------------------
-- chat_sessions — one conversation thread and its metadata.
-- booking_state holds the slot-filling draft (service/date/time/notes + stage)
-- so a conversation can be resumed from any device. Messages are normalised
-- into chat_messages rather than stored as one growing JSON array.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS chat_sessions (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id      uuid        NOT NULL,
  user_id          uuid        NOT NULL,
  title            text        NOT NULL DEFAULT 'New conversation' CHECK (length(title) <= 120),
  status           text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'closed')),
  booking_state    jsonb       NOT NULL DEFAULT '{}'::jsonb,
  message_count    integer     NOT NULL DEFAULT 0 CHECK (message_count >= 0),
  last_message_at  timestamptz NOT NULL DEFAULT now(),
  metadata         jsonb       NOT NULL DEFAULT '{}'::jsonb,  -- e.g. user agent, channel, experiment flags
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chat_sessions_user_fk FOREIGN KEY (business_id, user_id)
    REFERENCES users (business_id, id) ON DELETE CASCADE,
  CONSTRAINT chat_sessions_booking_state_obj_chk CHECK (jsonb_typeof(booking_state) = 'object')
);

-- -----------------------------------------------------------------------------
-- chat_messages — conversation history. bigint identity gives a cheap,
-- strictly increasing key for ordering and keyset pagination.
-- payload carries structured UI actions (confirm card, booking form, ...).
-- client_message_id is an idempotency key supplied by the browser so a
-- retried POST cannot create the same user message twice.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS chat_messages (
  id                 bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id         uuid        NOT NULL REFERENCES chat_sessions (id) ON DELETE CASCADE,
  role               text        NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content            text        NOT NULL CHECK (length(content) BETWEEN 1 AND 4000),
  payload            jsonb,
  client_message_id  uuid,
  created_at         timestamptz NOT NULL DEFAULT now()
);

-- -----------------------------------------------------------------------------
-- appointments — scheduling data and status.
-- The exclusion constraint is the real guard against double booking: two
-- concurrent requests for the same slot cannot both commit, regardless of
-- what the application checked beforehand. Cancelled rows are ignored.
-- (Assumption: one bookable resource per business — see database/README.md.)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS appointments (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id      uuid        NOT NULL,
  user_id          uuid        NOT NULL,
  service_id       uuid        NOT NULL,
  chat_session_id  uuid        REFERENCES chat_sessions (id) ON DELETE SET NULL,
  starts_at        timestamptz NOT NULL,
  ends_at          timestamptz NOT NULL,
  status           text        NOT NULL DEFAULT 'confirmed'
                               CHECK (status IN ('pending', 'confirmed', 'cancelled', 'completed', 'no_show')),
  source           text        NOT NULL DEFAULT 'form' CHECK (source IN ('chat', 'form', 'staff')),
  notes            text        CHECK (length(notes) <= 1000),
  cancelled_at     timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT appointments_user_fk FOREIGN KEY (business_id, user_id)
    REFERENCES users (business_id, id) ON DELETE CASCADE,
  CONSTRAINT appointments_service_fk FOREIGN KEY (business_id, service_id)
    REFERENCES services (business_id, id) ON DELETE RESTRICT,
  CONSTRAINT appointments_time_chk CHECK (ends_at > starts_at),
  CONSTRAINT appointments_cancelled_chk CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL)),
  CONSTRAINT appointments_no_overlap EXCLUDE USING gist (
    business_id WITH =,
    tstzrange(starts_at, ends_at, '[)') WITH &&
  ) WHERE (status IN ('pending', 'confirmed'))
);

-- -----------------------------------------------------------------------------
-- ai_interactions — one row per LLM call, for debugging and analytics
-- (latency, token usage, failure rate, prompt version). Kept separate from
-- chat_messages so it can have its own retention policy.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ai_interactions (
  id                 bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id        uuid        NOT NULL REFERENCES businesses (id) ON DELETE CASCADE,
  session_id         uuid        REFERENCES chat_sessions (id) ON DELETE SET NULL,
  user_id            uuid        REFERENCES users (id) ON DELETE SET NULL,
  provider           text        NOT NULL,
  model              text        NOT NULL,
  prompt_version     text        NOT NULL,
  status             text        NOT NULL CHECK (status IN ('success', 'invalid_output', 'error', 'timeout')),
  latency_ms         integer     NOT NULL CHECK (latency_ms >= 0),
  prompt_tokens      integer,
  completion_tokens  integer,
  request_messages   jsonb,
  raw_output         text,
  parsed_output      jsonb,
  error              text,
  created_at         timestamptz NOT NULL DEFAULT now()
);

-- =============================================================================
-- Indexes (rationale in database/README.md)
-- =============================================================================

-- Login: users_business_email_key (UNIQUE) already serves WHERE business_id = $1 AND email = $2.

-- Booking UI: active services for a tenant.
CREATE INDEX IF NOT EXISTS services_business_active_idx
  ON services (business_id) WHERE is_active;

-- "My conversations", newest first.
CREATE INDEX IF NOT EXISTS chat_sessions_user_recent_idx
  ON chat_sessions (user_id, last_message_at DESC);

-- Message history + keyset pagination: WHERE session_id = $1 AND id < $2 ORDER BY id DESC.
CREATE INDEX IF NOT EXISTS chat_messages_session_id_idx
  ON chat_messages (session_id, id);

-- Idempotency of user messages.
CREATE UNIQUE INDEX IF NOT EXISTS chat_messages_client_id_uidx
  ON chat_messages (session_id, client_message_id) WHERE client_message_id IS NOT NULL;

-- "My appointments" (upcoming / past) for a customer.
CREATE INDEX IF NOT EXISTS appointments_user_starts_idx
  ON appointments (user_id, starts_at);

-- Staff calendar / day view of live bookings for a tenant.
-- (Availability overlap checks use the GiST index behind appointments_no_overlap.)
CREATE INDEX IF NOT EXISTS appointments_business_live_starts_idx
  ON appointments (business_id, starts_at) WHERE status IN ('pending', 'confirmed');

-- FK lookups that would otherwise seq-scan on delete/update of the parent.
CREATE INDEX IF NOT EXISTS appointments_service_idx      ON appointments (service_id);
CREATE INDEX IF NOT EXISTS appointments_chat_session_idx ON appointments (chat_session_id) WHERE chat_session_id IS NOT NULL;

-- AI observability: per-session debugging, tenant dashboards, failure triage.
CREATE INDEX IF NOT EXISTS ai_interactions_session_idx
  ON ai_interactions (session_id, created_at);
CREATE INDEX IF NOT EXISTS ai_interactions_business_created_idx
  ON ai_interactions (business_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ai_interactions_failures_idx
  ON ai_interactions (created_at DESC) WHERE status <> 'success';

-- =============================================================================
-- updated_at triggers
-- =============================================================================
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['businesses', 'users', 'services', 'chat_sessions', 'appointments'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I_set_updated_at ON %I', t, t);
    EXECUTE format(
      'CREATE TRIGGER %I_set_updated_at BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION set_updated_at()',
      t, t
    );
  END LOOP;
END;
$$;
