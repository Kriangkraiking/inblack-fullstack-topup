import { STATUS_CODES } from 'node:http';
import { HttpException } from '@nestjs/common';
import { DomainError, type DomainErrorCode } from '@inblack/domain';

export const PROBLEM_CONTENT_TYPE = 'application/problem+json';

/** An error the API means to send, with the machine-readable code clients depend on. */
export class ProblemError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    detail: string,
  ) {
    super(detail);
    this.name = 'ProblemError';
  }
}

const DOMAIN_ERROR_STATUS: Record<DomainErrorCode, number> = {
  INVALID_TRANSITION: 409,
  INVALID_ORDER_ID: 422,
  INVALID_AMOUNT: 422,
  INVALID_QUANTITY: 422,
  EMPTY_CART: 422,
  PER_ORDER_LIMIT: 422,
  PER_CUSTOMER_LIMIT: 409,
  VOUCHER_INACTIVE: 422,
  VOUCHER_EXHAUSTED: 409,
  VOUCHER_MIN_SUBTOTAL: 422,
  REFUND_EXCEEDS_PAID: 409,
};

/** SQLSTATE codes from db/migrations/0002_orders.sql, plus the retryable Postgres ones. */
const DB_ERROR_PROBLEMS: Record<string, { status: number; code: string; detail: string }> = {
  IB001: { status: 409, code: 'INVALID_TRANSITION', detail: 'this status change is not allowed' },
  IB003: { status: 409, code: 'ORDER_LOCKED', detail: 'this order field cannot change' },
  IB005: { status: 409, code: 'PRECONDITION_FAILED', detail: 'the order does not meet the condition for this status' },
  IB006: { status: 409, code: 'INVALID_REFUND_CHANGE', detail: 'this refund change is not allowed' },
  '40001': { status: 503, code: 'DATABASE_BUSY', detail: 'please try again' },
  '40P01': { status: 503, code: 'DATABASE_BUSY', detail: 'please try again' },
  '57014': { status: 503, code: 'DATABASE_BUSY', detail: 'please try again' },
  '57P01': { status: 503, code: 'DATABASE_UNAVAILABLE', detail: 'please try again' },
};

export interface ProblemFields {
  status: number;
  code: string;
  detail: string;
}

/** Business errors are safe to store and replay. Anything else may succeed on a retry. */
export function businessProblem(error: unknown): ProblemFields | null {
  if (error instanceof ProblemError && error.status < 500) {
    return { status: error.status, code: error.code, detail: error.message };
  }
  if (error instanceof DomainError) {
    return { status: DOMAIN_ERROR_STATUS[error.code], code: error.code, detail: error.message };
  }
  return null;
}

function httpExceptionProblem(error: HttpException): ProblemFields {
  const status = error.getStatus();
  // The same body for every 404, so a hidden route looks exactly like a missing one.
  if (status === 404) return { status, code: 'NOT_FOUND', detail: 'no such resource' };
  // Not error.message: for a broken body it is the JSON parser's own text.
  return {
    status,
    code: status === 400 ? 'BAD_REQUEST' : `HTTP_${status}`,
    detail: STATUS_CODES[status] ?? 'request rejected',
  };
}

export function toProblem(error: unknown): ProblemFields {
  const business = businessProblem(error);
  if (business) return business;
  if (error instanceof ProblemError) {
    return { status: error.status, code: error.code, detail: error.message };
  }
  if (error instanceof HttpException) return httpExceptionProblem(error);

  const known = error as { code?: unknown; status?: unknown; message?: unknown };
  if (typeof known.code === 'string' && known.code in DB_ERROR_PROBLEMS) {
    return DB_ERROR_PROBLEMS[known.code];
  }
  // Errors raised by Express middleware, such as a body over the size limit.
  if (typeof known.status === 'number' && known.status >= 400 && known.status < 500) {
    return { status: known.status, code: `HTTP_${known.status}`, detail: STATUS_CODES[known.status] ?? 'request rejected' };
  }
  // pg-pool reports an exhausted pool or a dead server without a SQLSTATE.
  if (error instanceof Error && /timeout exceeded when trying to connect|ECONNREFUSED|Connection terminated/.test(error.message)) {
    return { status: 503, code: 'DATABASE_UNAVAILABLE', detail: 'please try again' };
  }
  return { status: 500, code: 'INTERNAL_ERROR', detail: 'something went wrong' };
}

/** RFC 9457. Holds nothing per-request, so a stored body can be replayed byte for byte. */
export function renderProblem({ status, code, detail }: ProblemFields): string {
  return JSON.stringify({
    type: `urn:inblack:problem:${code}`,
    title: STATUS_CODES[status] ?? 'Error',
    status,
    code,
    detail,
  });
}
