import { eventsTokenSecret, signEventsToken, verifyEventsToken } from './events-token.js';

const SECRET = 'test_only_order_events_secret_change_me';
const ORDER = 'ORD-2587965432159-229';
const OTHER = 'ORD-0000000000001-001';
const NOW = 1_800_000_000;

describe('events token', () => {
  it('accepts its own token for the same order until it expires', () => {
    const { token, expiresAt } = signEventsToken(SECRET, ORDER, NOW, 3600);
    expect(expiresAt).toBe(NOW + 3600);
    expect(verifyEventsToken(SECRET, ORDER, token, NOW)).toBe(NOW + 3600);
    expect(verifyEventsToken(SECRET, ORDER, token, NOW + 3599)).toBe(NOW + 3600);
  });

  it('refuses an expired token', () => {
    const { token } = signEventsToken(SECRET, ORDER, NOW, 3600);
    expect(verifyEventsToken(SECRET, ORDER, token, NOW + 3600)).toBeNull();
  });

  it('refuses a token issued for another order', () => {
    const { token } = signEventsToken(SECRET, OTHER, NOW);
    expect(verifyEventsToken(SECRET, ORDER, token, NOW)).toBeNull();
  });

  it('refuses a token signed with another secret', () => {
    const { token } = signEventsToken('another_secret_of_some_length', ORDER, NOW);
    expect(verifyEventsToken(SECRET, ORDER, token, NOW)).toBeNull();
  });

  it('refuses a token whose expiry was pushed out', () => {
    const { token } = signEventsToken(SECRET, ORDER, NOW, 60);
    const [v, , sig] = token.split('.');
    expect(verifyEventsToken(SECRET, ORDER, `${v}.${NOW + 999_999}.${sig}`, NOW + 120)).toBeNull();
  });

  it.each([undefined, '', 'v1', 'v1.abc.def', ['v1.1.x'], 42, 'v2.1800003600.' + 'A'.repeat(43)])(
    'refuses malformed input %j',
    (token) => {
      expect(verifyEventsToken(SECRET, ORDER, token, NOW)).toBeNull();
    },
  );

  it('needs a secret of at least 16 characters', () => {
    expect(() => eventsTokenSecret({})).toThrow(/ORDER_EVENTS_TOKEN_SECRET/);
    expect(() => eventsTokenSecret({ ORDER_EVENTS_TOKEN_SECRET: 'short' })).toThrow();
    expect(eventsTokenSecret({ ORDER_EVENTS_TOKEN_SECRET: SECRET })).toBe(SECRET);
  });
});
