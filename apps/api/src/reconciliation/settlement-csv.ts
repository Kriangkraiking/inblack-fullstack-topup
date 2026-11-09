import { z } from 'zod';
import { ProblemError } from '../common/problem.js';

const HEADER = 'event_id,order_id,type,amount_satang,settled_at';
const MAX_ROWS = 200_000;

// Plain values only. The provider's format has no quoting, and these patterns refuse it.
const providerId = z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/);
const rowSchema = z.object({
  event_id: providerId,
  order_id: providerId,
  type: z.enum(['payment.succeeded', 'payment.failed', 'payment.refunded']),
  amount_satang: z
    .string()
    .regex(/^\d{1,15}$/)
    .transform(Number),
  settled_at: z.iso.datetime({ offset: true }),
});

export type SettlementRow = z.output<typeof rowSchema>;

function invalid(detail: string): ProblemError {
  return new ProblemError(422, 'CSV_INVALID', detail);
}

/** Refuses the whole file on the first bad line, because a partial answer would look complete. */
export function parseSettlementCsv(text: string): SettlementRow[] {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

  if (lines[0] !== HEADER) throw invalid(`the first line must be ${HEADER}`);
  if (lines.length - 1 > MAX_ROWS) throw invalid(`at most ${MAX_ROWS} rows`);

  const seen = new Set<string>();
  return lines.slice(1).map((line, index) => {
    const lineNumber = index + 2;
    const fields = line.split(',');
    if (fields.length !== 5) throw invalid(`line ${lineNumber}: expected 5 fields`);
    const [event_id, order_id, type, amount_satang, settled_at] = fields;
    const parsed = rowSchema.safeParse({ event_id, order_id, type, amount_satang, settled_at });
    if (!parsed.success) {
      const field = parsed.error.issues[0].path.join('.');
      throw invalid(`line ${lineNumber}: ${field} is not valid`);
    }
    if (seen.has(parsed.data.event_id)) {
      throw invalid(`line ${lineNumber}: event_id appears more than once`);
    }
    seen.add(parsed.data.event_id);
    return parsed.data;
  });
}
