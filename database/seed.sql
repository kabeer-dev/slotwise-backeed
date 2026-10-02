-- =============================================================================
-- Slotwise — sample data
-- Idempotent: fixed ids + ON CONFLICT DO NOTHING, so it can be re-run.
-- Appointment times are computed relative to now() so the demo always has
-- upcoming bookings regardless of when it is seeded.
--
-- Demo logins (password for both: Demo@12345)
--   customer : demo@slotwise.dev
--   admin    : admin@slotwise.dev
-- =============================================================================

-- Tenants ---------------------------------------------------------------------
INSERT INTO businesses (id, slug, name, timezone, opens_at, closes_at, working_days, slot_interval_minutes)
VALUES
  ('b0000000-0000-4000-8000-000000000001', 'lumen-clinic', 'Lumen Health Clinic', 'Asia/Karachi', '09:00', '18:00', '{1,2,3,4,5,6}', 15),
  -- A second tenant, only to show that data is partitioned by business_id.
  ('b0000000-0000-4000-8000-000000000002', 'glow-studio',  'Glow Beauty Studio',  'Asia/Dubai',   '10:00', '20:00', '{1,2,3,4,5,6,7}', 30)
ON CONFLICT DO NOTHING;

-- Services --------------------------------------------------------------------
INSERT INTO services (id, business_id, name, description, duration_minutes, is_active)
VALUES
  ('5e000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001', 'General Consultation',  'Initial visit with a general physician.',          30, true),
  ('5e000000-0000-4000-8000-000000000002', 'b0000000-0000-4000-8000-000000000001', 'Follow-up Visit',       'Review of test results or ongoing treatment.',     15, true),
  ('5e000000-0000-4000-8000-000000000003', 'b0000000-0000-4000-8000-000000000001', 'Dental Cleaning',       'Scale and polish with a dental hygienist.',        45, true),
  ('5e000000-0000-4000-8000-000000000004', 'b0000000-0000-4000-8000-000000000001', 'Physiotherapy Session', 'Assessment and hands-on treatment session.',       60, true),
  ('5e000000-0000-4000-8000-000000000005', 'b0000000-0000-4000-8000-000000000001', 'Home Visit',            'Paused — kept to show inactive services.',         90, false),
  ('5e000000-0000-4000-8000-000000000101', 'b0000000-0000-4000-8000-000000000002', 'Haircut',               'Wash, cut and blow-dry.',                          60, true)
ON CONFLICT DO NOTHING;

-- Users (bcrypt hash of "Demo@12345", cost 10) --------------------------------
INSERT INTO users (id, business_id, email, password_hash, full_name, phone, role)
VALUES
  ('a0000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001', 'demo@slotwise.dev',
   '$2b$10$ghiljKTbLhfYYTi5RitXD.rwNfRQEUeKzxQo8JrnX0//O8yV7.nhK', 'Ayesha Khan', '+92 300 1234567', 'customer'),
  ('a0000000-0000-4000-8000-000000000002', 'b0000000-0000-4000-8000-000000000001', 'admin@slotwise.dev',
   '$2b$10$ghiljKTbLhfYYTi5RitXD.rwNfRQEUeKzxQo8JrnX0//O8yV7.nhK', 'Clinic Admin', NULL, 'admin'),
  ('a0000000-0000-4000-8000-000000000003', 'b0000000-0000-4000-8000-000000000001', 'bilal@example.com',
   '$2b$10$ghiljKTbLhfYYTi5RitXD.rwNfRQEUeKzxQo8JrnX0//O8yV7.nhK', 'Bilal Ahmed', NULL, 'customer')
ON CONFLICT DO NOTHING;

-- Chat session with history ---------------------------------------------------
INSERT INTO chat_sessions (id, business_id, user_id, title, booking_state, message_count, last_message_at)
VALUES
  ('c0000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001',
   'Dental cleaning booking', '{"stage": "collecting", "clarifications": 0}', 4, now() - interval '1 day')
ON CONFLICT DO NOTHING;

INSERT INTO chat_messages (session_id, role, content, payload, created_at)
SELECT 'c0000000-0000-4000-8000-000000000001'::uuid, m.role, m.content, m.payload::jsonb, now() - interval '1 day' + m.offset_s * interval '1 second'
FROM (VALUES
  ('assistant', 'Hi Ayesha! I can book an appointment at Lumen Health Clinic for you.', '{"quickReplies": ["Book a general consultation", "Show my appointments"]}', 0),
  ('user',      'I need a dental cleaning in two days, around 10am', NULL, 20),
  ('assistant', 'Great — Dental Cleaning in two days at 10:00 AM (45 min). Shall I book it?', '{"quickReplies": ["Yes, book it", "Change the time"], "meta": {"intent": "book", "ai": "ok"}}', 22),
  ('user',      'Yes please', NULL, 30),
  ('assistant', 'You''re booked! Dental Cleaning at 10:00 AM. See you then.', '{"quickReplies": ["Show my appointments"], "meta": {"intent": "confirm", "ai": "ok"}}', 31)
) AS m(role, content, payload, offset_s)
WHERE NOT EXISTS (
  SELECT 1 FROM chat_messages WHERE session_id = 'c0000000-0000-4000-8000-000000000001'
);

-- Appointments ----------------------------------------------------------------
-- "Next working day after tomorrow" in the clinic's timezone, skipping Sunday.
WITH base AS (
  SELECT d + CASE WHEN extract(isodow FROM d) = 7 THEN 1 ELSE 0 END AS day
  FROM (SELECT (now() AT TIME ZONE 'Asia/Karachi')::date + 2 AS d) s
)
INSERT INTO appointments (id, business_id, user_id, service_id, chat_session_id, starts_at, ends_at, status, source, notes, cancelled_at)
SELECT v.id::uuid, 'b0000000-0000-4000-8000-000000000001', v.user_id::uuid, v.service_id::uuid, v.chat_session_id::uuid,
       ((base.day + v.day_offset) + v.start_time::time) AT TIME ZONE 'Asia/Karachi',
       ((base.day + v.day_offset) + v.start_time::time + v.minutes * interval '1 minute') AT TIME ZONE 'Asia/Karachi',
       v.status, v.source, v.notes,
       CASE WHEN v.status = 'cancelled' THEN now() ELSE NULL END
FROM base, (VALUES
  -- Ayesha: booked via chat (matches the session above)
  ('ad000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', '5e000000-0000-4000-8000-000000000003',
   'c0000000-0000-4000-8000-000000000001', 0, '10:00', 45, 'confirmed', 'chat', 'Sensitive gums'),
  -- Bilal: occupies 11:00–11:30 on the same day, so that slot shows as taken
  ('ad000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000003', '5e000000-0000-4000-8000-000000000001',
   NULL, 0, '11:00', 30, 'confirmed', 'form', NULL),
  -- Ayesha: a cancelled booking (ignored by the overlap constraint)
  ('ad000000-0000-4000-8000-000000000003', 'a0000000-0000-4000-8000-000000000001', '5e000000-0000-4000-8000-000000000004',
   NULL, 1, '15:00', 60, 'cancelled', 'form', NULL),
  -- Ayesha: a past, completed visit
  ('ad000000-0000-4000-8000-000000000004', 'a0000000-0000-4000-8000-000000000001', '5e000000-0000-4000-8000-000000000001',
   NULL, -9, '09:30', 30, 'completed', 'form', 'Annual check-up')
) AS v(id, user_id, service_id, chat_session_id, day_offset, start_time, minutes, status, source, notes)
ON CONFLICT DO NOTHING;

-- One logged AI interaction (what the assistant stores for every LLM call) -----
INSERT INTO ai_interactions (business_id, session_id, user_id, provider, model, prompt_version, status,
                             latency_ms, prompt_tokens, completion_tokens, raw_output, parsed_output)
SELECT 'b0000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001',
       'mistral', 'mistral-small-latest', 'booking-v1', 'success', 842, 612, 71,
       '{"intent":"book","service":"Dental Cleaning","date":null,"time":"10:00","notes":null,"needs_clarification":false,"reply":"Sure!"}',
       '{"intent":"book","service":"Dental Cleaning","time":"10:00"}'
WHERE NOT EXISTS (
  SELECT 1 FROM ai_interactions WHERE session_id = 'c0000000-0000-4000-8000-000000000001'
);
