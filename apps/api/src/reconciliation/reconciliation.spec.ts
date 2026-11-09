import { compareSettlement, type SystemEvent, type SystemSnapshot } from './compare-settlement.js';
import { parseSettlementCsv, type SettlementRow } from './settlement-csv.js';

const HEADER = 'event_id,order_id,type,amount_satang,settled_at';
const AT = '2026-11-06T10:15:00Z';

function row(event_id: string, type: SettlementRow['type'], amount: number, order_id = 'O1'): SettlementRow {
  return { event_id, order_id, type, amount_satang: amount, settled_at: AT };
}

function event(eventId: string, type: string, amount: number, extra: Partial<SystemEvent> = {}): SystemEvent {
  return {
    eventId,
    type,
    orderId: 'O1',
    amountSatang: amount,
    occurredAt: new Date(AT),
    outcome: 'paid',
    settledRefund: type === 'payment.refunded',
    ...extra,
  };
}

function snapshot(events: SystemEvent[], status = 'COMPLETED', paid = 1000): SystemSnapshot {
  return { events, orders: new Map([['O1', { id: 'O1', status, paidSatang: paid }]]) };
}

const types = (rows: SettlementRow[], system: SystemSnapshot) =>
  compareSettlement(rows, system).map((m) => m.type);

describe('compareSettlement', () => {
  it('reports nothing when both sides agree, including a partial refund', () => {
    const rows = [row('e1', 'payment.succeeded', 1000), row('e2', 'payment.refunded', 300)];
    const system = snapshot([event('e1', 'payment.succeeded', 1000), event('e2', 'payment.refunded', 300)]);

    expect(types(rows, system)).toEqual([]);
  });

  it('agrees on a full refund when the order is REFUNDED', () => {
    const rows = [row('e1', 'payment.succeeded', 1000), row('e2', 'payment.refunded', 1000)];
    const system = snapshot(
      [event('e1', 'payment.succeeded', 1000), event('e2', 'payment.refunded', 1000)],
      'REFUNDED',
    );

    expect(types(rows, system)).toEqual([]);
  });

  it('finds an event only at the provider', () => {
    expect(types([row('e9', 'payment.succeeded', 1000)], snapshot([]))).toEqual(['MISSING_IN_SYSTEM']);
  });

  it('finds an event for an order the system does not have', () => {
    const rows = [row('e1', 'payment.succeeded', 1000, 'NOPE')];
    expect(types(rows, snapshot([]))).toEqual(['MISSING_IN_SYSTEM']);
  });

  it('finds an event only in the system', () => {
    expect(types([], snapshot([event('e1', 'payment.succeeded', 1000)]))).toEqual(['MISSING_AT_PROVIDER']);
  });

  it('skips system events outside the window', () => {
    const system = snapshot([event('e1', 'payment.succeeded', 1000)]);

    expect(compareSettlement([], system, { from: new Date('2027-01-01T00:00:00Z') })).toEqual([]);
  });

  it('finds a different amount', () => {
    const rows = [row('e1', 'payment.succeeded', 999)];
    expect(types(rows, snapshot([event('e1', 'payment.succeeded', 1000)]))).toEqual(['AMOUNT_MISMATCH']);
  });

  it('finds a different type', () => {
    const rows = [row('e1', 'payment.refunded', 1000)];
    expect(types(rows, snapshot([event('e1', 'payment.succeeded', 1000)]))).toContain('STATUS_MISMATCH');
  });

  it('finds a refund that nothing in the system settled', () => {
    const rows = [row('e1', 'payment.succeeded', 1000), row('e2', 'payment.refunded', 300)];
    const system = snapshot([
      event('e1', 'payment.succeeded', 1000),
      event('e2', 'payment.refunded', 300, { settledRefund: false }),
    ]);

    expect(types(rows, system)).toEqual(['STATUS_MISMATCH']);
  });

  it('finds an order marked REFUNDED that the provider only partly refunded', () => {
    const rows = [row('e1', 'payment.succeeded', 1000), row('e2', 'payment.refunded', 300)];
    const system = snapshot(
      [event('e1', 'payment.succeeded', 1000), event('e2', 'payment.refunded', 300)],
      'REFUNDED',
    );

    expect(types(rows, system)).toEqual(['STATUS_MISMATCH']);
  });

  it('finds a full refund the order status does not show', () => {
    const rows = [row('e1', 'payment.succeeded', 1000), row('e2', 'payment.refunded', 1000)];
    const system = snapshot([event('e1', 'payment.succeeded', 1000), event('e2', 'payment.refunded', 1000)]);

    expect(types(rows, system)).toEqual(['STATUS_MISMATCH']);
  });

  it('ignores payment.failed on both sides', () => {
    const rows = [row('e1', 'payment.failed', 1000)];

    expect(types(rows, snapshot([event('e2', 'payment.failed', 1000)], 'PAYMENT_FAILED', 0))).toEqual([]);
  });
});

describe('parseSettlementCsv', () => {
  const line = `evt_1,ORD-1,payment.succeeded,1000,${AT}`;

  it('reads CRLF, a BOM and trailing blank lines', () => {
    const rows = parseSettlementCsv(`﻿${HEADER}\r\n${line}\r\n\r\n`);

    expect(rows).toEqual([
      { event_id: 'evt_1', order_id: 'ORD-1', type: 'payment.succeeded', amount_satang: 1000, settled_at: AT },
    ]);
  });

  it('reads a file with no rows', () => {
    expect(parseSettlementCsv(`${HEADER}\n`)).toEqual([]);
  });

  it.each([
    ['an empty file', ''],
    ['a wrong header', `a,b,c,d,e\n${line}`],
    ['too few fields', `${HEADER}\nevt_1,ORD-1`],
    ['a fractional amount', `${HEADER}\nevt_1,ORD-1,payment.succeeded,10.50,${AT}`],
    ['a negative amount', `${HEADER}\nevt_1,ORD-1,payment.succeeded,-1,${AT}`],
    ['an unknown type', `${HEADER}\nevt_1,ORD-1,payment.x,1,${AT}`],
    ['a bad date', `${HEADER}\nevt_1,ORD-1,payment.succeeded,1,yesterday`],
    ['a quoted field', `${HEADER}\n"evt_1",ORD-1,payment.succeeded,1,${AT}`],
    ['a repeated event', `${HEADER}\n${line}\n${line}`],
  ])('refuses %s with 422', (_, text) => {
    expect(() => parseSettlementCsv(text)).toThrow(
      expect.objectContaining({ status: 422, code: 'CSV_INVALID' }) as Error,
    );
  });

  describe('pending refunds', () => {
    const NOW = new Date('2026-11-06T12:00:00Z');
    const pending = (minutesOld: number, hasOpenJob: boolean) => ({
      refundRef: 'rf_1',
      orderId: 'O1',
      amountSatang: 5000,
      createdAt: new Date(NOW.getTime() - minutesOld * 60_000),
      hasOpenJob,
    });
    const withPending = (refund: ReturnType<typeof pending>): SystemSnapshot => ({
      ...snapshot([event('e1', 'payment.succeeded', 1000)]),
      pendingRefunds: [refund],
    });
    const rows = [row('e1', 'payment.succeeded', 1000)];

    it('leaves a fresh refund that a job is still sending alone', () => {
      expect(compareSettlement(rows, withPending(pending(1, true)), {}, NOW)).toEqual([]);
    });

    it('reports a refund no job will send', () => {
      const found = compareSettlement(rows, withPending(pending(1, false)), {}, NOW);
      expect(found.map((m) => [m.type, m.order_id, m.system_amount_satang])).toEqual([
        ['STATUS_MISMATCH', 'O1', 5000],
      ]);
      expect(found[0].detail).toMatch(/no job/);
    });

    it('reports a refund PENDING for longer than the limit', () => {
      const found = compareSettlement(rows, withPending(pending(16, true)), {}, NOW);
      expect(found.map((m) => m.type)).toEqual(['STATUS_MISMATCH']);
      expect(found[0].detail).toMatch(/16 minutes/);
    });
  });
});
