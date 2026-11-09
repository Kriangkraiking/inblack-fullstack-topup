import { isValidOrderId } from '@inblack/domain';
import { ProblemError } from '../common/problem.js';

/**
 * Keyset position in ORDER BY created_at DESC, id DESC. created_at travels as microseconds since
 * the epoch in text, because a JS Date keeps only milliseconds: a cursor rounded to the
 * millisecond would repeat or skip orders created within the same millisecond.
 */
export interface OrderCursor {
  createdUs: string;
  id: string;
}

const CURSOR_TEXT = /^(\d{1,19}):(ORD-\d{13}-\d{3})$/;

export function encodeCursor({ createdUs, id }: OrderCursor): string {
  return Buffer.from(`${createdUs}:${id}`, 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): OrderCursor {
  const match = /^[A-Za-z0-9_-]{1,128}$/.test(cursor)
    ? CURSOR_TEXT.exec(Buffer.from(cursor, 'base64url').toString('utf8'))
    : null;
  if (!match || !isValidOrderId(match[2])) {
    throw new ProblemError(422, 'INVALID_CURSOR', 'cursor is not one this API returned');
  }
  return { createdUs: match[1], id: match[2] };
}

/** Asks for one row more than the page, so the last page says it is the last. */
export function pageOf<Row extends { created_us: string; id: string }>(rows: Row[], limit: number) {
  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  return {
    items,
    nextCursor: rows.length > limit && last ? encodeCursor({ createdUs: last.created_us, id: last.id }) : null,
  };
}
