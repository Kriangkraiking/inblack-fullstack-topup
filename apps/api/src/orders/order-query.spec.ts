import { ProblemError } from '../common/problem.js';
import { decodeCursor, encodeCursor, pageOf } from './order-cursor.js';
import { CURRENT_STATUSES, PAST_STATUSES, parseAdminListQuery, parseMyListQuery } from './order-query-input.js';
import { OrderQueryService } from './order-query.service.js';
import type { OrderQueryRepository } from './order-query.repository.js';
import type { OrdersRepository } from './orders.repository.js';
import type { EventsTokenService } from '../realtime/events-token.service.js';

const ID = 'ORD-2587965432159-229';

const codeOf = (run: () => unknown) => {
  try {
    run();
    return 'ok';
  } catch (error) {
    return (error as ProblemError).code;
  }
};

describe('order cursor', () => {
  it('round-trips microseconds and the id exactly', () => {
    const cursor = { createdUs: '1762423200123456', id: ID };
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
  });

  it.each(['', 'not base64!', encodeCursor({ createdUs: '1', id: 'ORD-2587965432159-458' }), Buffer.from('1:x').toString('base64url')])(
    'refuses %s',
    (cursor) => {
      expect(codeOf(() => decodeCursor(cursor))).toBe('INVALID_CURSOR');
    },
  );

  it('gives a next cursor only when there is a row past the page', () => {
    const rows = [1, 2, 3].map((n) => ({ created_us: String(n), id: ID }));
    expect(pageOf(rows, 3).nextCursor).toBeNull();
    const page = pageOf(rows, 2);
    expect(page.items).toHaveLength(2);
    expect(decodeCursor(page.nextCursor as string)).toEqual({ createdUs: '2', id: ID });
  });
});

describe('parseAdminListQuery', () => {
  it('reads filters, an exact order id or an exact email', () => {
    const byId = parseAdminListQuery({ q: ID.toLowerCase(), status: 'PAID,COMPLETED', limit: '10' });
    expect(byId.filter).toMatchObject({ orderId: ID, email: null, statuses: ['PAID', 'COMPLETED'] });
    expect(byId.limit).toBe(10);
    expect(parseAdminListQuery({ q: ' Buyer@Example.com ' }).filter.email).toBe('buyer@example.com');
  });

  it.each([
    [{ q: 'ORD-2587965432159-458' }, 'INVALID_ORDER_ID'],
    [{ q: 'buyer' }, 'VALIDATION_ERROR'],
    [{ status: 'PAID,NOPE' }, 'VALIDATION_ERROR'],
    [{ limit: '1000' }, 'VALIDATION_ERROR'],
    [{ from: '2026-11-10T00:00:00Z', to: '2026-11-09T00:00:00Z' }, 'VALIDATION_ERROR'],
    [{ from: 'yesterday' }, 'VALIDATION_ERROR'],
    [{ cursor: 'garbage' }, 'INVALID_CURSOR'],
    [{ q: ['a', 'b'] }, 'VALIDATION_ERROR'],
  ])('refuses %j', (query, code) => {
    expect(codeOf(() => parseAdminListQuery(query))).toBe(code);
  });
});

describe('parseMyListQuery', () => {
  it('splits every status into exactly one tab', () => {
    expect(parseMyListQuery({}).statuses).toBe(CURRENT_STATUSES);
    expect(parseMyListQuery({ tab: 'past' }).statuses).toBe(PAST_STATUSES);
    expect(new Set([...CURRENT_STATUSES, ...PAST_STATUSES]).size).toBe(10);
    expect(CURRENT_STATUSES.length + PAST_STATUSES.length).toBe(10);
    expect(PAST_STATUSES).toEqual(expect.arrayContaining(['COMPLETED', 'REFUNDED', 'EXPIRED']));
  });
});

describe('OrderQueryService.getForViewer', () => {
  const order = {
    id: ID,
    email: 'owner@example.com',
    game_uid: 'player_01',
    status: 'PAID',
    payment_method: 'PROMPTPAY',
    voucher_code: null,
    subtotal_satang: '34900',
    discount_satang: '0',
    net_satang: '34900',
    fee_satang: '0',
    total_satang: '34900',
    vat_satang: '2283',
    paid_satang: '34900',
    refunded_satang: '0',
    currency: 'THB',
    expires_at: new Date(0),
    created_at: new Date(0),
  };
  const events = [
    { id: '1', event_type: 'order.created', from_status: null, to_status: 'PENDING_PAYMENT', actor: 'api:orders', reason: 'order created', created_at: new Date(0) },
  ];
  const service = new OrderQueryService(
    { findOrderById: (id: string) => Promise.resolve(id === ID ? order : undefined), findItems: () => Promise.resolve([]) } as unknown as OrdersRepository,
    { findEvents: () => Promise.resolve(events) } as unknown as OrderQueryRepository,
    { issue: () => ({ events_token: 't', events_token_expires_at: 'x' }) } as unknown as EventsTokenService,
  );
  const answer = (promise: Promise<unknown>) =>
    promise.then(
      (body) => body as Record<string, unknown>,
      (error: ProblemError) => `${error.status} ${error.code} ${error.message}`,
    );

  it('gives the owner the order and a timeline without actors', async () => {
    const body = (await answer(service.getForViewer(ID, { customerEmail: 'owner@example.com' }))) as Record<string, unknown>;
    expect(body.email).toBe('owner@example.com');
    expect(JSON.stringify(body.timeline)).not.toContain('actor');
    expect(body.events_token).toBe('t');
  });

  it('answers another customer, no session and an unknown order with the same 404', async () => {
    const missing = await answer(service.getForViewer('ORD-0000000000001-001', { customerEmail: 'owner@example.com' }));
    expect(missing).toBe('404 ORDER_NOT_FOUND no order matches these details');
    expect(await answer(service.getForViewer(ID, { customerEmail: 'other@example.com' }))).toBe(missing);
    expect(await answer(service.getForViewer(ID, {}))).toBe(missing);
    expect(await answer(service.getForViewer('ORD-2587965432159-458', { customerEmail: 'owner@example.com' }))).toBe(missing);
  });

  it('shows any admin the order, masked for viewer', async () => {
    const viewer = (await answer(service.getForViewer(ID, { admin: { id: '1', email: 'v@x.test', role: 'viewer' } }))) as Record<string, unknown>;
    expect(viewer.email).toBe('o***@example.com');
    expect(viewer.game_uid).toBe('pl****01');
    const support = (await answer(service.getForViewer(ID, { admin: { id: '2', email: 's@x.test', role: 'support' } }))) as Record<string, unknown>;
    expect(support.email).toBe('owner@example.com');
    expect(JSON.stringify(support.timeline)).toContain('actor');
  });
});
