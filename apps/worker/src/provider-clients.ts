/** HTTP calls to mock-game and mock-pay. Every timeout or transport error is "unknown". */

import { Logger } from '@nestjs/common';
import { acceptRequestId, currentRequestId } from './observability/request-context.js';

const logger = new Logger('ProviderClients');

/** The id of the request that queued the job, so mock-game logs line up with ours. */
function traceHeaders(): Record<string, string> {
  return { 'X-Request-Id': acceptRequestId(currentRequestId()) };
}

export type TopupLookup =
  | { state: 'found'; count: number }
  | { state: 'not_found' }
  | { state: 'unknown'; reason: string };

export type TopupResult =
  | { state: 'ok'; httpStatus: number }
  | { state: 'rejected'; httpStatus: number }
  | { state: 'failed'; httpStatus: number }
  | { state: 'unknown'; reason: string };

export type RefundResult =
  | { state: 'ok'; eventId: string }
  | { state: 'rejected'; httpStatus: number; code: string }
  | { state: 'retry'; reason: string };

export interface RefundRequest {
  refundRef: string;
  orderId: string;
  amountSatang: number;
  paidSatang: number;
  paymentEventId: string | null;
}

export interface TopupRequest {
  reference: string;
  game_uid: string;
  sku: string;
  qty: number;
}

/** The error's name only, because a message can carry a URL or a request detail. */
function reasonOf(error: unknown): string {
  return error instanceof Error ? error.name : 'Error';
}

export function createGameClient(baseUrl: string, getTimeoutMs: number, postTimeoutMs: number) {
  return {
    async getTopup(reference: string): Promise<TopupLookup> {
      try {
        const response = await fetch(`${baseUrl}/topups/${encodeURIComponent(reference)}`, {
          headers: traceHeaders(),
          redirect: 'manual',
          signal: AbortSignal.timeout(getTimeoutMs),
        });
        if (response.status === 404) {
          await response.arrayBuffer();
          return { state: 'not_found' };
        }
        if (!response.ok) {
          await response.arrayBuffer();
          return { state: 'unknown', reason: `GET answered ${response.status}` };
        }
        const body = (await response.json()) as { count?: unknown };
        if (typeof body.count === 'number' && body.count >= 1) {
          return { state: 'found', count: body.count };
        }
        return { state: 'unknown', reason: 'GET answered 200 without a count' };
      } catch (error) {
        return { state: 'unknown', reason: `GET ${reasonOf(error)}` };
      }
    },

    async postTopup(request: TopupRequest): Promise<TopupResult> {
      try {
        const response = await fetch(`${baseUrl}/topups`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...traceHeaders() },
          body: JSON.stringify(request),
          redirect: 'manual',
          signal: AbortSignal.timeout(postTimeoutMs),
        });
        await response.arrayBuffer();
        logger.log({ msg: 'mock-game POST /topups', reference: request.reference, sku: request.sku, http_status: response.status });
        if (response.ok) return { state: 'ok', httpStatus: response.status };
        if (response.status >= 400 && response.status < 500) {
          return { state: 'rejected', httpStatus: response.status };
        }
        if (response.status >= 500) return { state: 'failed', httpStatus: response.status };
        return { state: 'unknown', reason: `POST answered ${response.status}` };
      } catch (error) {
        logger.warn({ msg: 'mock-game POST /topups gave no answer', reference: request.reference, error: reasonOf(error) });
        return { state: 'unknown', reason: `POST ${reasonOf(error)}` };
      }
    },
  };
}

export type GameClient = ReturnType<typeof createGameClient>;

export function createPayClient(baseUrl: string, timeoutMs: number) {
  return {
    /**
     * refund_id is the idempotency key at the provider, so sending it twice is always safe.
     * paid_satang and payment_event_id let mock-pay refund an order that was paid by a webhook it
     * did not send itself (the review team signs its own): it records that payment first.
     */
    async postRefund(request: RefundRequest): Promise<RefundResult> {
      try {
        const response = await fetch(`${baseUrl}/refunds`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...traceHeaders() },
          body: JSON.stringify({
            refund_id: request.refundRef,
            order_id: request.orderId,
            amount_satang: request.amountSatang,
            paid_satang: request.paidSatang,
            ...(request.paymentEventId ? { payment_event_id: request.paymentEventId } : {}),
          }),
          redirect: 'manual',
          signal: AbortSignal.timeout(timeoutMs),
        });
        const body = (await response.json().catch(() => ({}))) as {
          event_id?: unknown;
          code?: unknown;
        };
        if (response.ok && typeof body.event_id === 'string') {
          return { state: 'ok', eventId: body.event_id };
        }
        if (response.status >= 400 && response.status < 500) {
          const code = typeof body.code === 'string' ? body.code : `HTTP_${response.status}`;
          return { state: 'rejected', httpStatus: response.status, code };
        }
        return { state: 'retry', reason: `POST /refunds answered ${response.status}` };
      } catch (error) {
        return { state: 'retry', reason: `POST /refunds ${reasonOf(error)}` };
      }
    },
  };
}

export type PayClient = ReturnType<typeof createPayClient>;
