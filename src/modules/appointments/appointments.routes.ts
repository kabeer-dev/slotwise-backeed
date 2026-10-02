import { Router } from 'express';
import { z } from 'zod';
import { DATE_RE, TIME_RE } from '../../lib/time.js';
import { getAuth, requireAuth } from '../../middleware/auth.js';
import { input, validate } from '../../middleware/validate.js';
import * as appointments from './appointments.service.js';

const ListQuery = z.object({
  scope: z.enum(['upcoming', 'history']).default('upcoming'),
});

const AvailabilityQuery = z.object({
  serviceId: z.uuid({ error: 'Invalid service' }),
  date: z.string({ error: 'Date is required' }).regex(DATE_RE, 'Date must be YYYY-MM-DD'),
});

const CreateBody = z.object({
  serviceId: z.uuid({ error: 'Please choose a service' }),
  date: z.string({ error: 'Please choose a date' }).regex(DATE_RE, 'Date must be YYYY-MM-DD'),
  time: z.string({ error: 'Please choose a time' }).regex(TIME_RE, 'Time must be HH:mm (24-hour)'),
  notes: z
    .string()
    .trim()
    .max(500, 'Notes must be 500 characters or fewer')
    .optional()
    .transform((v) => v || undefined),
  chatSessionId: z.uuid().optional(),
});

const IdParams = z.object({ id: z.uuid('Invalid appointment id') });

export const appointmentsRouter = Router();
appointmentsRouter.use(requireAuth);

appointmentsRouter.get('/', validate({ query: ListQuery }), async (req, res) => {
  const { scope } = input<typeof ListQuery>(req, 'query');
  res.json({ appointments: await appointments.listAppointments(getAuth(req), scope) });
});

// Declared before "/:id" so "availability" is not parsed as an id.
appointmentsRouter.get('/availability', validate({ query: AvailabilityQuery }), async (req, res) => {
  res.json(await appointments.getAvailability(getAuth(req), input<typeof AvailabilityQuery>(req, 'query')));
});

appointmentsRouter.post('/', validate({ body: CreateBody }), async (req, res) => {
  const body = input<typeof CreateBody>(req, 'body');
  const appointment = await appointments.createAppointment(getAuth(req), { ...body, source: 'form' });
  res.status(201).location(`/api/v1/appointments/${appointment.id}`).json({ appointment });
});

appointmentsRouter.get('/:id', validate({ params: IdParams }), async (req, res) => {
  const { id } = input<typeof IdParams>(req, 'params');
  res.json({ appointment: await appointments.getAppointment(getAuth(req), id) });
});

appointmentsRouter.post('/:id/cancel', validate({ params: IdParams }), async (req, res) => {
  const { id } = input<typeof IdParams>(req, 'params');
  res.json({ appointment: await appointments.cancelAppointment(getAuth(req), id) });
});
