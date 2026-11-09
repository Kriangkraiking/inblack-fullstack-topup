import { ProblemError } from '../common/problem.js';
import { formatEvent, OrderEventStream, parseLastEventId } from './order-event-stream.js';
import type { OrderEventSource, PublicOrderEvent } from './order-events.repository.js';

const ORDER = 'ORD-2587965432159-229';
const FLOW = ['PENDING_PAYMENT', 'PAID', 'IN_QUEUE', 'IN_PROGRESS', 'COMPLETED'];

function event(id: number, i: number): PublicOrderEvent {
  return {
    event_id: String(id),
    status: FLOW[i],
    from_status: i === 0 ? null : FLOW[i - 1],
    event_type: i === 0 ? 'order.created' : 'status.changed',
    occurred_at: new Date(1_800_000_000_000 + id).toISOString(),
  };
}

/** An in-memory order_events table. Ids are not consecutive, as with other orders in between. */
class FakeSource implements OrderEventSource {
  rows: PublicOrderEvent[] = [];
  reads = 0;
  gate?: Promise<void>;
  failNext = false;
  async eventsAfter(orderId: string, afterId: string, limit: number) {
    this.reads += 1;
    if (this.gate) await this.gate;
    if (this.failNext) {
      this.failNext = false;
      throw new Error('connection terminated');
    }
    expect(orderId).toBe(ORDER);
    return this.rows.filter((r) => BigInt(r.event_id) > BigInt(afterId)).slice(0, limit);
  }
  add(id: number) {
    this.rows.push(event(id, this.rows.length));
  }
}

function collect() {
  const frames: string[] = [];
  const ids = () => frames.map((f) => /^id: (\d+)$/m.exec(f)?.[1]);
  return { frames, ids, write: (f: string) => frames.push(f) };
}

describe('Last-Event-ID replay', () => {
  it('sends only the events after the given id, in id order', async () => {
    const source = new FakeSource();
    [3, 8, 21, 22, 40].forEach((id) => source.add(id));
    const out = collect();
    const stream = new OrderEventStream(source, ORDER, '8', out.write);
    await stream.drain();
    expect(out.ids()).toEqual(['21', '22', '40']);
    expect(stream.lastEventId).toBe('40');
  });

  it('a reconnect after a drop gets the missed events once, with no gap and no repeat', async () => {
    const source = new FakeSource();
    source.add(3);
    source.add(8);
    const first = collect();
    const a = new OrderEventStream(source, ORDER, '0', first.write);
    await a.drain();
    a.close(); // the client drops here

    source.add(21);
    source.add(22);
    const second = collect();
    const b = new OrderEventStream(source, ORDER, a.lastEventId, second.write);
    await b.drain();
    source.add(40);
    await b.drain();
    await b.drain(); // a duplicated signal

    expect([...first.ids(), ...second.ids()]).toEqual(['3', '8', '21', '22', '40']);
  });

  it('signals during a read cause one more read, never overlapping reads or repeats', async () => {
    const source = new FakeSource();
    source.add(1);
    let open!: () => void;
    source.gate = new Promise((resolve) => (open = resolve));
    const out = collect();
    const stream = new OrderEventStream(source, ORDER, '0', out.write);

    const first = stream.drain();
    source.add(2); // committed while the first read is in flight
    void stream.drain();
    void stream.drain();
    expect(source.reads).toBe(1);
    open();
    await first;
    expect(out.ids()).toEqual(['1', '2']);
    expect(source.reads).toBe(2);
  });

  it('reads in batches until it has caught up', async () => {
    const source = new FakeSource();
    for (let id = 1; id <= 450; id += 1) source.rows.push({ ...event(id, 1), event_id: String(id) });
    const out = collect();
    await new OrderEventStream(source, ORDER, '0', out.write).drain();
    expect(out.ids()).toHaveLength(450);
    expect(new Set(out.ids()).size).toBe(450);
  });

  it('a failed read loses nothing: the next trigger resumes from the last id sent', async () => {
    const source = new FakeSource();
    source.add(5);
    const out = collect();
    const errors: unknown[] = [];
    const stream = new OrderEventStream(source, ORDER, '0', out.write, (e) => errors.push(e));
    await stream.drain();
    source.add(6);
    source.failNext = true;
    await stream.drain();
    expect(errors).toHaveLength(1);
    await stream.drain();
    expect(out.ids()).toEqual(['5', '6']);
  });

  it('writes nothing once closed', async () => {
    const source = new FakeSource();
    source.add(1);
    const out = collect();
    const stream = new OrderEventStream(source, ORDER, '0', out.write);
    stream.close();
    await stream.drain();
    expect(out.frames).toEqual([]);
  });
});

describe('formatEvent', () => {
  it('uses the event id as the SSE id and carries no internal fields', () => {
    const frame = formatEvent(event(21, 1));
    expect(frame.startsWith('id: 21\ndata: ')).toBe(true);
    expect(frame.endsWith('\n\n')).toBe(true);
    const data = JSON.parse(frame.split('data: ')[1]) as Record<string, unknown>;
    expect(Object.keys(data).sort()).toEqual(['event_id', 'event_type', 'from_status', 'occurred_at', 'status']);
  });
});

describe('parseLastEventId', () => {
  it('prefers the header that EventSource sends on reconnect', () => {
    expect(parseLastEventId('42', '7')).toBe('42');
    expect(parseLastEventId(undefined, '7')).toBe('7');
    expect(parseLastEventId('', '7')).toBe('7');
    expect(parseLastEventId(undefined, undefined)).toBe('0');
    expect(parseLastEventId('007', undefined)).toBe('7');
  });

  it.each(['-1', '1.5', 'abc', '1e3', '9'.repeat(19), ['1', '2']])('refuses %j with 422', (value) => {
    expect(() => parseLastEventId(undefined, value)).toThrow(ProblemError);
  });
});
