/** HTTP calls to mock-game and mock-pay. Every timeout or transport error is "unknown". */

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
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(request),
          redirect: 'manual',
          signal: AbortSignal.timeout(postTimeoutMs),
        });
        await response.arrayBuffer();
        if (response.ok) return { state: 'ok', httpStatus: response.status };
        if (response.status >= 400 && response.status < 500) {
          return { state: 'rejected', httpStatus: response.status };
        }
        if (response.status >= 500) return { state: 'failed', httpStatus: response.status };
        return { state: 'unknown', reason: `POST answered ${response.status}` };
      } catch (error) {
        return { state: 'unknown', reason: `POST ${reasonOf(error)}` };
      }
    },
  };
}

export type GameClient = ReturnType<typeof createGameClient>;

export function createPayClient(baseUrl: string, timeoutMs: number) {
  return {
    /** refund_id is the idempotency key at the provider, so sending it twice is always safe. */
    async postRefund(refundRef: string, orderId: string, amount: number): Promise<RefundResult> {
      try {
        const response = await fetch(`${baseUrl}/refunds`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refund_id: refundRef, order_id: orderId, amount_satang: amount }),
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
