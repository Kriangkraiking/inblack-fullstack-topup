import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

interface RequestContext {
  requestId: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

/** Letters, digits and . _ - only, so a client cannot put anything odd into logs or headers. */
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

/** Keeps a well-formed incoming id (nginx sets one on every request) and makes one otherwise. */
export function acceptRequestId(header: unknown): string {
  return typeof header === 'string' && REQUEST_ID_PATTERN.test(header) ? header : randomUUID();
}

export function runWithRequestId<T>(requestId: string, work: () => T): T {
  return storage.run({ requestId }, work);
}

export function currentRequestId(): string | undefined {
  return storage.getStore()?.requestId;
}
