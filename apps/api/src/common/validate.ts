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
