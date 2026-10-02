import type { Request, RequestHandler } from 'express';
import type { ZodError, ZodType, z } from 'zod';
import { AppError } from '../lib/errors.js';

type Part = 'params' | 'query' | 'body';
type Schemas = Partial<Record<Part, ZodType>>;

export interface FieldIssue {
  location: Part;
  field: string;
  message: string;
}

export function formatZodIssues(error: ZodError, location: Part): FieldIssue[] {
  return error.issues.map((issue) => ({
    location,
    field: issue.path.join('.') || '(root)',
    message: issue.message,
  }));
}

/**
 * Validates and coerces request parts with zod. Parsed values are exposed on
 * req.validated (Express 5 makes req.query read-only, so we don't overwrite it).
 * Unknown body keys are stripped by zod's default object behaviour.
 */
export function validate(schemas: Schemas): RequestHandler {
  return (req, _res, next) => {
    const validated: NonNullable<Request['validated']> = {};
    const issues: FieldIssue[] = [];

    for (const part of ['params', 'query', 'body'] as const) {
      const schema = schemas[part];
      if (!schema) continue;
      const result = schema.safeParse(req[part] ?? {});
      if (result.success) validated[part] = result.data;
      else issues.push(...formatZodIssues(result.error, part));
    }

    if (issues.length > 0) {
      throw new AppError(400, 'VALIDATION_ERROR', issues[0]?.message ?? 'Invalid request', issues);
    }
    req.validated = validated;
    next();
  };
}

/** Typed accessor for validated input, e.g. `input<typeof LoginSchema>(req, 'body')`. */
export function input<S extends ZodType>(req: Request, part: Part): z.output<S> {
  return req.validated?.[part] as z.output<S>;
}
