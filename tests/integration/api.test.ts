import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { pool } from '../../src/db/pool.js';
import { futureWorkingDay } from '../fixtures.js';

const dbAvailable = inject('dbAvailable');
const app = createApp();

const DENTAL = '5e000000-0000-4000-8000-000000000003';
const CONSULT = '5e000000-0000-4000-8000-000000000001';

async function signup(overrides: Record<string, string> = {}) {
  const res = await request(app)
    .post('/api/v1/auth/signup')
    .send({ fullName: 'Test User', email: `user-${randomUUID()}@example.com`, password: 'Passw0rd!', ...overrides });
  expect(res.status).toBe(201);
  return res.body as { token: string; user: { id: string } };
}

describe.skipIf(!dbAvailable)('API integration (real PostgreSQL)', () => {
  let token: string;
  const auth = () => ({ Authorization: `Bearer ${token}` });

  beforeAll(async () => {
    ({ token } = await signup());
  });
  afterAll(async () => {
    await pool.end();
  });

  describe('auth', () => {
    it('logs in with seeded demo credentials (email is case-insensitive)', async () => {
      const res = await request(app).post('/api/v1/auth/login').send({ email: 'Demo@Slotwise.dev', password: 'Demo@12345' });
      expect(res.status).toBe(200);
      expect(res.body.user.fullName).toBe('Ayesha Khan');
      expect(res.body.business.timezone).toBe('Asia/Karachi');
    });

    it('rejects wrong passwords and unknown emails identically', async () => {
      const a = await request(app).post('/api/v1/auth/login').send({ email: 'demo@slotwise.dev', password: 'wrong-pass1' });
      const b = await request(app).post('/api/v1/auth/login').send({ email: 'nobody@slotwise.dev', password: 'wrong-pass1' });
      expect([a.status, b.status]).toEqual([401, 401]);
      expect(a.body.error.code).toBe(b.body.error.code);
    });

    it('validates signup input with field-level details', async () => {
      const res = await request(app).post('/api/v1/auth/signup').send({ email: 'not-an-email', password: 'short' });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.details.map((d: { field: string }) => d.field)).toEqual(expect.arrayContaining(['fullName', 'email', 'password']));
    });

    it('returns 409 for duplicate emails', async () => {
      const res = await request(app).post('/api/v1/auth/signup').send({ fullName: 'Dup', email: 'demo@slotwise.dev', password: 'Passw0rd!' });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('EMAIL_TAKEN');
    });

    it('requires a valid bearer token', async () => {
      expect((await request(app).get('/api/v1/appointments')).status).toBe(401);
      const bad = await request(app).get('/api/v1/appointments').set('Authorization', 'Bearer nope');
      expect(bad.status).toBe(401);
      expect(bad.body.error.code).toBe('INVALID_TOKEN');
    });

    it('returns the current user', async () => {
      const res = await request(app).get('/api/v1/auth/me').set(auth());
      expect(res.status).toBe(200);
      expect(res.body.user.fullName).toBe('Test User');
    });
  });

  describe('appointments', () => {
    const day = futureWorkingDay(7);

    it('lists bookable services (inactive ones hidden)', async () => {
      const res = await request(app).get('/api/v1/services').set(auth());
      expect(res.status).toBe(200);
      const names = res.body.services.map((s: { name: string }) => s.name);
      expect(names).toContain('Dental Cleaning');
      expect(names).not.toContain('Home Visit');
    });

    it('returns availability for a day', async () => {
      const res = await request(app).get('/api/v1/appointments/availability').query({ serviceId: DENTAL, date: day }).set(auth());
      expect(res.status).toBe(200);
      expect(res.body.slots).toContain('09:00');
      expect(res.body.slots).not.toContain('17:30'); // 45 min would end after closing
    });

    it('creates, rejects a clash with alternatives, and cancels', async () => {
      const created = await request(app).post('/api/v1/appointments').set(auth()).send({ serviceId: DENTAL, date: day, time: '14:00', notes: '  ' });
      expect(created.status).toBe(201);
      expect(created.body.appointment).toMatchObject({ status: 'confirmed', source: 'form', notes: null });

      const clash = await request(app).post('/api/v1/appointments').set(auth()).send({ serviceId: CONSULT, date: day, time: '14:30' });
      expect(clash.status).toBe(409);
      expect(clash.body.error.code).toBe('SLOT_UNAVAILABLE');
      expect(clash.body.error.details.alternatives.length).toBeGreaterThan(0);

      const id = created.body.appointment.id;
      const cancelled = await request(app).post(`/api/v1/appointments/${id}/cancel`).set(auth());
      expect(cancelled.status).toBe(200);
      expect(cancelled.body.appointment.status).toBe('cancelled');

      const again = await request(app).post(`/api/v1/appointments/${id}/cancel`).set(auth());
      expect(again.status).toBe(409);

      // Cancelled slot is free again.
      const rebook = await request(app).post('/api/v1/appointments').set(auth()).send({ serviceId: CONSULT, date: day, time: '14:30' });
      expect(rebook.status).toBe(201);
    });

    it('enforces business rules with 422', async () => {
      const res = await request(app).post('/api/v1/appointments').set(auth()).send({ serviceId: DENTAL, date: day, time: '07:00' });
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('OUTSIDE_HOURS');
    });

    it('prevents double booking under concurrency (exclusion constraint)', async () => {
      const other = await signup();
      const body = { serviceId: DENTAL, date: day, time: '16:00' };
      const results = await Promise.all([
        request(app).post('/api/v1/appointments').set(auth()).send(body),
        request(app).post('/api/v1/appointments').set({ Authorization: `Bearer ${other.token}` }).send(body),
        request(app).post('/api/v1/appointments').set(auth()).send({ ...body, time: '16:15' }),
      ]);
      const statuses = results.map((r) => r.status).sort();
      expect(statuses).toEqual([201, 409, 409]);
    });

    it('does not leak other users\' appointments', async () => {
      const mine = await request(app).get('/api/v1/appointments').set(auth());
      const other = await signup();
      const theirs = await request(app).get('/api/v1/appointments').set({ Authorization: `Bearer ${other.token}` });
      expect(mine.body.appointments.length).toBeGreaterThan(0);
      expect(theirs.body.appointments).toEqual([]);
      const id = mine.body.appointments[0].id;
      expect((await request(app).get(`/api/v1/appointments/${id}`).set({ Authorization: `Bearer ${other.token}` })).status).toBe(404);
    });
  });

  describe('chat booking flow', () => {
    const day = futureWorkingDay(9);
    let sessionId: string;
    const send = (content: string, clientMessageId?: string) =>
      request(app).post(`/api/v1/chat/sessions/${sessionId}/messages`).set(auth()).send({ content, clientMessageId });

    it('opens a session with a greeting', async () => {
      const res = await request(app).post('/api/v1/chat/sessions').set(auth());
      expect(res.status).toBe(201);
      sessionId = res.body.session.id;
      expect(res.body.messages[0].role).toBe('assistant');
      expect(res.body.messages[0].payload.quickReplies.length).toBeGreaterThan(0);
    });

    it('collects details over several turns, confirms via button and books', async () => {
      let res = await send('I would like a physio session');
      expect(res.status).toBe(201);
      expect(res.body.session.bookingState.serviceId).toBe('5e000000-0000-4000-8000-000000000004');
      expect(res.body.session.title).toBe('I would like a physio session');

      res = await send(`${day} at 11am`);
      expect(res.body.assistantMessage.payload.action.type).toBe('confirm_booking');
      expect(res.body.session.bookingState.stage).toBe('awaiting_confirmation');

      res = await request(app).post(`/api/v1/chat/sessions/${sessionId}/confirm`).set(auth());
      expect(res.status).toBe(201);
      expect(res.body.assistantMessage.payload.action.type).toBe('booking_confirmed');
      expect(res.body.assistantMessage.payload.action.appointment).toMatchObject({ source: 'chat', chatSessionId: sessionId });
      expect(res.body.session.bookingState.stage).toBe('collecting');

      const confirmAgain = await request(app).post(`/api/v1/chat/sessions/${sessionId}/confirm`).set(auth());
      expect(confirmAgain.status).toBe(409);
    });

    it('rejects duplicate messages by clientMessageId (idempotency)', async () => {
      const id = randomUUID();
      expect((await send('hello', id)).status).toBe(201);
      const dup = await send('hello', id);
      expect(dup.status).toBe(409);
      expect(dup.body.error.code).toBe('DUPLICATE_MESSAGE');
    });

    it('falls back to the booking form when the AI is unavailable', async () => {
      const res = await send('book a cleaning #ai-down');
      expect(res.status).toBe(201);
      expect(res.body.assistantMessage.payload.action).toMatchObject({ type: 'booking_form', reason: 'assistant_unavailable' });
      expect(res.body.assistantMessage.payload.meta.ai).toBe('fallback');
    });

    it('logs every AI interaction, including failures', async () => {
      const { rows } = await pool.query<{ status: string; count: string }>(
        'SELECT status, count(*) FROM ai_interactions WHERE session_id = $1 GROUP BY status',
        [sessionId],
      );
      const byStatus = Object.fromEntries(rows.map((r) => [r.status, Number(r.count)]));
      expect(byStatus.success).toBeGreaterThanOrEqual(2);
      expect(byStatus.error).toBe(1);
    });

    it('posts form bookings made inside a conversation back into it', async () => {
      const res = await request(app)
        .post('/api/v1/appointments')
        .set(auth())
        .send({ serviceId: CONSULT, date: day, time: '15:00', chatSessionId: sessionId });
      expect(res.status).toBe(201);

      // The domain-event handler runs asynchronously.
      await new Promise((r) => setTimeout(r, 150));
      const messages = await request(app).get(`/api/v1/chat/sessions/${sessionId}/messages`).set(auth());
      const last = messages.body.messages.at(-1);
      expect(last.payload.action.type).toBe('booking_confirmed');
      expect(last.payload.meta.via).toBe('form');
    });

    it('returns paginated history', async () => {
      const page = await request(app).get(`/api/v1/chat/sessions/${sessionId}/messages`).query({ limit: 3 }).set(auth());
      expect(page.body.messages).toHaveLength(3);
      expect(page.body.nextCursor).toBe(page.body.messages[0].id);
      const older = await request(app).get(`/api/v1/chat/sessions/${sessionId}/messages`).query({ limit: 3, before: page.body.nextCursor }).set(auth());
      expect(Number(older.body.messages.at(-1).id)).toBeLessThan(Number(page.body.messages[0].id));
    });

    it('isolates tenants: a user of another business cannot read this session', async () => {
      const outsider = await signup({ businessSlug: 'glow-studio' });
      const res = await request(app).get(`/api/v1/chat/sessions/${sessionId}`).set({ Authorization: `Bearer ${outsider.token}` });
      expect(res.status).toBe(404);
      const services = await request(app).get('/api/v1/services').set({ Authorization: `Bearer ${outsider.token}` });
      expect(services.body.services.map((s: { name: string }) => s.name)).toEqual(['Haircut']);
    });
  });

  describe('errors', () => {
    it('uses a consistent envelope with request ids', async () => {
      const res = await request(app).get('/api/v1/nope').set('X-Request-Id', 'test-request-123');
      expect(res.status).toBe(404);
      expect(res.headers['x-request-id']).toBe('test-request-123');
      expect(res.body.error).toMatchObject({ code: 'ROUTE_NOT_FOUND', requestId: 'test-request-123' });
    });

    it('handles malformed JSON and bad ids', async () => {
      const json = await request(app).post('/api/v1/auth/login').set('Content-Type', 'application/json').send('{"email":');
      expect(json.status).toBe(400);
      expect(json.body.error.code).toBe('INVALID_JSON');
      const id = await request(app).get('/api/v1/appointments/not-a-uuid').set(auth());
      expect(id.status).toBe(400);
    });
  });
});
