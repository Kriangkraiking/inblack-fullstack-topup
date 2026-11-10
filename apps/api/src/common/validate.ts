import type { z } from 'zod';
import { ProblemError } from './problem.js';

interface ParseOptions {
  status?: number;
  /** Picks the code clients see for the first problem, when it should be more specific. */
  codeFor?: (issue: z.core.$ZodIssue) => string;
}

/** Runs a Zod schema and turns the first failure into a Problem Details error. */
export function parseWith<Schema extends z.ZodType>(
  schema: Schema,
  input: unknown,
  { status = 422, codeFor }: ParseOptions = {},
): z.output<Schema> {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  const path = issue.path.join('.');
  throw new ProblemError(
    status,
    codeFor?.(issue) ?? 'VALIDATION_ERROR',
    path ? `${path}: ${issue.message}` : issue.message,
  );
}

/**
 * 415 unless the body is declared as JSON. A cross-site HTML form can only send urlencoded,
 * multipart or text/plain without a CORS preflight, so sign-in routes that skip the Origin check
 * use this to refuse a forged login (login CSRF).
 */
export function requireJson(contentType: string | undefined): void {
  const mediaType = (contentType ?? '').split(';')[0].trim().toLowerCase();
  if (mediaType !== 'application/json') {
    throw new ProblemError(415, 'UNSUPPORTED_MEDIA_TYPE', 'send the body as application/json');
  }
}
