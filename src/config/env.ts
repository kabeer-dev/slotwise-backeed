import { config } from 'dotenv';
import { z } from 'zod';

config({ quiet: true });

const bool = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(4000),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

    DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
    DATABASE_SSL: bool.default(false),
    DATABASE_POOL_MAX: z.coerce.number().int().positive().default(10),

    JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
    JWT_EXPIRES_IN: z.string().default('1d'),

    /** Comma-separated list of allowed browser origins. */
    CORS_ORIGINS: z.string().default('http://localhost:3000'),
    /** Number of reverse proxies in front of the app (Render/Railway = 1). Needed for correct client IPs in rate limiting. */
    TRUST_PROXY: z.coerce.number().int().min(0).default(0),

    /** Tenant used when signup/login don't specify one. */
    DEFAULT_BUSINESS_SLUG: z.string().default('lumen-clinic'),

    /** "mistral" or "mock". Defaults to mistral when a key is present. */
    AI_PROVIDER: z.enum(['mistral', 'mock']).optional(),
    MISTRAL_API_KEY: z.string().optional(),
    MISTRAL_MODEL: z.string().default('mistral-small-latest'),
    MISTRAL_BASE_URL: z.string().url().default('https://api.mistral.ai/v1'),
    AI_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
    /** How many previous messages are sent to the model as conversation memory. */
    AI_HISTORY_WINDOW: z.coerce.number().int().min(2).max(50).default(12),
    /** Store full prompts in ai_interactions (disable to reduce PII retention). */
    AI_LOG_PROMPTS: bool.default(true),

    RATE_LIMIT_CHAT_PER_MINUTE: z.coerce.number().int().positive().default(20),
  })
  .transform((env) => ({
    ...env,
    AI_PROVIDER: env.AI_PROVIDER ?? (env.MISTRAL_API_KEY ? 'mistral' : 'mock'),
    corsOrigins: env.CORS_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean),
  }))
  .superRefine((env, ctx) => {
    if (env.AI_PROVIDER === 'mistral' && !env.MISTRAL_API_KEY) {
      ctx.addIssue({ code: 'custom', path: ['MISTRAL_API_KEY'], message: 'required when AI_PROVIDER=mistral' });
    }
  });

function loadEnv() {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    // Fail fast: a misconfigured server should not start half-working.
    console.error(`Invalid environment configuration:\n${issues}`);
    process.exit(1);
  }
  return parsed.data;
}

export const env = loadEnv();
export type Env = typeof env;
export const isProd = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';
