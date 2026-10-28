import type { z } from 'zod';
import { AppError } from './errors.js';

/** Parses input with Zod, throwing a VALIDATION_ERROR listing each bad field. */
export function parseOrThrow<T extends z.ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new AppError(
      'VALIDATION_ERROR',
      'Request validation failed',
      result.error.issues.map((i) => ({ field: i.path.join('.') || '(root)', message: i.message })),
    );
  }
  return result.data;
}
