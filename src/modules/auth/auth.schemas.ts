import { z } from 'zod';

const email = z
  .string({ error: 'Email is required' })
  .trim()
  .toLowerCase()
  .pipe(z.email('Enter a valid email address').max(254));

const businessSlug = z.string().regex(/^[a-z0-9-]{3,60}$/, 'Invalid business').optional();

export const SignupSchema = z.object({
  fullName: z.string({ error: 'Please enter your full name' }).trim().min(2, 'Please enter your full name').max(120),
  email,
  password: z
    .string({ error: 'Password is required' })
    .min(8, 'Password must be at least 8 characters')
    // bcrypt only uses the first 72 bytes; reject longer input instead of silently truncating it.
    .max(72, 'Password must be at most 72 characters')
    .regex(/[A-Za-z]/, 'Password must contain a letter')
    .regex(/\d/, 'Password must contain a number'),
  phone: z.string().trim().max(32).optional(),
  businessSlug,
});

export const LoginSchema = z.object({
  email,
  password: z.string({ error: 'Password is required' }).min(1, 'Password is required').max(72),
  businessSlug,
});

export type SignupInput = z.infer<typeof SignupSchema>;
export type LoginInput = z.infer<typeof LoginSchema>;
