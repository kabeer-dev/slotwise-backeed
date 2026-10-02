import { Router } from 'express';
import { getAuth, requireAuth } from '../../middleware/auth.js';
import { authLimiter } from '../../middleware/rateLimit.js';
import { input, validate } from '../../middleware/validate.js';
import { LoginSchema, SignupSchema } from './auth.schemas.js';
import * as authService from './auth.service.js';

export const authRouter = Router();

authRouter.post('/signup', authLimiter, validate({ body: SignupSchema }), async (req, res) => {
  res.status(201).json(await authService.signup(input<typeof SignupSchema>(req, 'body')));
});

authRouter.post('/login', authLimiter, validate({ body: LoginSchema }), async (req, res) => {
  res.json(await authService.login(input<typeof LoginSchema>(req, 'body')));
});

authRouter.get('/me', requireAuth, async (req, res) => {
  res.json(await authService.me(getAuth(req)));
});
