import { createServer, type Server } from 'node:net';
import type { AddressInfo } from 'node:net';
import { ProblemError } from '../common/problem.js';
import type { Tx } from '../db/db.service.js';
import type { CustomerAuthRepository } from './customer-auth.repository.js';
import { CustomerAuthService } from './customer-auth.service.js';
import {
  decideVerify,
  generateOtpCode,
  hashOtp,
  OTP_LOCK_SECONDS,
  type OtpState,
} from './otp.js';
import { SmtpMailer, type MailMessage } from './smtp-mailer.js';

const SECRET = 'unit-test-otp-secret-0123456789';
const EMAIL = 'buyer@example.com';

describe('generateOtpCode', () => {
  it('always gives 6 digits, keeping leading zeros', () => {
    expect(generateOtpCode(() => 42)).toBe('000042');
    expect(generateOtpCode(() => 999_999)).toBe('999999');
    for (let i = 0; i < 200; i += 1) expect(generateOtpCode()).toMatch(/^\d{6}$/);
  });
});

describe('hashOtp', () => {
  it('is keyed and bound to the email', () => {
    const hash = hashOtp(SECRET, EMAIL, '123456');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashOtp(SECRET, 'other@example.com', '123456')).not.toBe(hash);
    expect(hashOtp(`${SECRET}x`, EMAIL, '123456')).not.toBe(hash);
  });
});

describe('decideVerify', () => {
  const right = hashOtp(SECRET, EMAIL, '123456');
  const wrong = hashOtp(SECRET, EMAIL, '654321');
  const fresh: OtpState = { codeHash: right, expired: false, consumed: false, failedAttempts: 0, lockedForSeconds: null };

  it.each<[string, OtpState | undefined, string, string]>([
    ['the right code', fresh, right, 'accept'],
    ['no code at all', undefined, right, 'no-code'],
    ['a wrong code', fresh, wrong, 'wrong'],
    ['the right code after it expired', { ...fresh, expired: true }, right, 'stale'],
    ['the right code after it was used', { ...fresh, consumed: true }, right, 'stale'],
    ['a wrong code once the stored one is used', { ...fresh, consumed: true }, wrong, 'wrong'],
    ['a code dropped by a lock', { ...fresh, codeHash: null }, right, 'wrong'],
    ['the 5th wrong code', { ...fresh, failedAttempts: 4 }, wrong, 'lock'],
    ['the right code while locked', { ...fresh, lockedForSeconds: 600 }, right, 'locked'],
  ])('%s gives %s', (_name, state, submitted, kind) => {
    expect(decideVerify(state, submitted).kind).toBe(kind);
  });

  it('locks for 15 minutes on the 5th failure', () => {
    expect(decideVerify({ ...fresh, failedAttempts: 4 }, wrong)).toEqual({ kind: 'lock', retryAfterSeconds: OTP_LOCK_SECONDS });
  });
});

/** The repository's SQL rules on a Map, with a clock the test moves. Real concurrency: security.mjs. */
class FakeRepository {
  now = 0;
  rows = new Map<string, { hash: string | null; expiresAt: number; consumed: boolean; failed: number; lockedUntil: number; sentAt: number }>();
  sessions = new Map<string, string>();

  transaction<T>(work: (tx: Tx) => Promise<T>) {
    return work({} as Tx);
  }
  storeCode(email: string, hash: string, ttl: number, cooldown: number) {
    const row = this.rows.get(email);
    if (row && (row.sentAt > this.now - cooldown * 1000 || row.lockedUntil > this.now)) return Promise.resolve(false);
    this.rows.set(email, { hash, expiresAt: this.now + ttl * 1000, consumed: false, failed: row?.failed ?? 0, lockedUntil: row?.lockedUntil ?? 0, sentAt: this.now });
    return Promise.resolve(true);
  }
  lockState(_tx: Tx, email: string): Promise<OtpState | undefined> {
    const row = this.rows.get(email);
    if (!row) return Promise.resolve(undefined);
    return Promise.resolve({
      codeHash: row.hash,
      expired: row.expiresAt <= this.now,
      consumed: row.consumed,
      failedAttempts: row.failed,
      lockedForSeconds: row.lockedUntil > this.now ? Math.ceil((row.lockedUntil - this.now) / 1000) : null,
    });
  }
  recordFailure(_tx: Tx, email: string, failed: number) {
    this.rows.get(email)!.failed = failed;
    return Promise.resolve();
  }
  lock(_tx: Tx, email: string, seconds: number) {
    Object.assign(this.rows.get(email)!, { failed: 0, hash: null, lockedUntil: this.now + seconds * 1000 });
    return Promise.resolve();
  }
  consume(_tx: Tx, email: string, hash: string) {
    const row = this.rows.get(email)!;
    if (row.hash !== hash || row.consumed || row.expiresAt <= this.now) return Promise.resolve(false);
    Object.assign(row, { consumed: true, failed: 0 });
    return Promise.resolve(true);
  }
  createSession(_tx: Tx, tokenHash: string, email: string) {
    this.sessions.set(tokenHash, email);
    return Promise.resolve();
  }
  findSessionEmail(tokenHash: string) {
    return Promise.resolve(this.sessions.get(tokenHash));
  }
  deleteSession(tokenHash: string) {
    this.sessions.delete(tokenHash);
    return Promise.resolve();
  }
}

describe('CustomerAuthService', () => {
  let repository: FakeRepository;
  let sent: MailMessage[];
  let service: CustomerAuthService;

  beforeEach(() => {
    vi.stubEnv('OTP_HASH_SECRET', SECRET);
    repository = new FakeRepository();
    sent = [];
    service = new CustomerAuthService(repository as unknown as CustomerAuthRepository, {
      send: (message) => {
        sent.push(message);
        return Promise.resolve();
      },
    });
  });
  afterEach(() => vi.unstubAllEnvs());

  const lastCode = () => /\b(\d{6})\b/.exec(sent[sent.length - 1].text)![1];
  const codeOf = (promise: Promise<unknown>) =>
    promise.then(
      () => 'ok',
      (error: unknown) => (error instanceof ProblemError ? `${error.status} ${error.code}` : 'crash'),
    );

  it('mails a code, accepts it once and gives a session', async () => {
    await (await service.requestCode(EMAIL)).sent;
    expect(sent).toHaveLength(1);
    expect(sent[0].subject).not.toMatch(/\d{6}/);
    const { token } = await service.verify(EMAIL, lastCode());
    await expect(service.authenticate(token)).resolves.toBe(EMAIL);
    expect(await codeOf(service.verify(EMAIL, lastCode()))).toBe('401 OTP_INVALID');
  });

  it('does not count the right code sent again after use as a wrong guess', async () => {
    await (await service.requestCode(EMAIL)).sent;
    const code = lastCode();
    await service.verify(EMAIL, code);
    for (let i = 0; i < 9; i += 1) expect(await codeOf(service.verify(EMAIL, code))).toBe('401 OTP_INVALID');
    expect(repository.rows.get(EMAIL)?.failed).toBe(0);
  });

  it('refuses a code after 5 minutes', async () => {
    await (await service.requestCode(EMAIL)).sent;
    repository.now += 5 * 60_000;
    expect(await codeOf(service.verify(EMAIL, lastCode()))).toBe('401 OTP_INVALID');
  });

  it('locks for 15 minutes after 5 wrong codes, even for the right one', async () => {
    await (await service.requestCode(EMAIL)).sent;
    const code = lastCode();
    const wrong = code === '000000' ? '000001' : '000000';
    const answers = [];
    for (let i = 0; i < 5; i += 1) answers.push(await codeOf(service.verify(EMAIL, wrong)));
    expect(answers).toEqual([...Array(4).fill('401 OTP_INVALID'), '429 OTP_LOCKED']);
    expect(await codeOf(service.verify(EMAIL, code))).toBe('429 OTP_LOCKED');

    // No new code while locked, and the answer to the request does not change.
    await expect(service.requestCode(EMAIL)).resolves.toEqual({ sent: null });

    repository.now += 15 * 60_000;
    // The lock dropped the old code, so it does not come back when the lock ends.
    expect(await codeOf(service.verify(EMAIL, code))).toBe('401 OTP_INVALID');
    await (await service.requestCode(EMAIL)).sent;
    expect(await codeOf(service.verify(EMAIL, lastCode()))).toBe('ok');
  });

  it('does not reset the guess count when a new code is asked for', async () => {
    await (await service.requestCode(EMAIL)).sent;
    for (let i = 0; i < 4; i += 1) await codeOf(service.verify(EMAIL, '999999'));
    repository.now += 31_000;
    await (await service.requestCode(EMAIL)).sent;
    const code = lastCode();
    expect(await codeOf(service.verify(EMAIL, code === '999999' ? '999998' : '999999'))).toBe('429 OTP_LOCKED');
  });

  it('sends at most one code per 30 seconds to an email', async () => {
    await (await service.requestCode(EMAIL)).sent;
    await service.requestCode(EMAIL);
    expect(sent).toHaveLength(1);
  });

  it('answers the same way when the email cannot be sent', async () => {
    const failing = new CustomerAuthService(repository as unknown as CustomerAuthRepository, {
      send: () => Promise.reject(new Error('mailpit down')),
    });
    const { sent: delivery } = await failing.requestCode('x@example.com');
    await expect(delivery).resolves.toBeUndefined();
  });

  it('logout ends the session', async () => {
    await (await service.requestCode(EMAIL)).sent;
    const { token } = await service.verify(EMAIL, lastCode());
    await service.logout(token);
    await expect(service.authenticate(token)).resolves.toBeUndefined();
  });
});

describe('SmtpMailer', () => {
  let server: Server;
  let received: string;

  beforeAll(async () => {
    server = createServer((socket) => {
      socket.setEncoding('utf8');
      let inData = false;
      socket.write('220 fake ready\r\n');
      socket.on('data', (chunk: string) => {
        received += chunk;
        for (const line of chunk.split('\r\n').filter(Boolean)) {
          if (inData) {
            if (line === '.') {
              inData = false;
              socket.write('250 queued\r\n');
            }
          } else if (line.startsWith('EHLO')) socket.write('250-fake\r\n250 SIZE 1000\r\n');
          else if (line === 'DATA') {
            inData = true;
            socket.write('354 go\r\n');
          } else if (line === 'QUIT') socket.end('221 bye\r\n');
          else socket.write('250 ok\r\n');
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
  beforeEach(() => {
    received = '';
  });

  it('delivers a UTF-8 body as base64', async () => {
    const port = (server.address() as AddressInfo).port;
    await new SmtpMailer('127.0.0.1', port, 'no-reply@inblackm.test').send({
      to: EMAIL,
      subject: 'code',
      text: 'รหัสของคุณคือ 123456',
    });
    expect(received).toContain(`RCPT TO:<${EMAIL}>`);
    const body = /base64\r\n\r\n([A-Za-z0-9+/=\r\n]+)\r\n\.\r\n/.exec(received)![1];
    expect(Buffer.from(body.replace(/\r\n/g, ''), 'base64').toString('utf8')).toBe('รหัสของคุณคือ 123456');
  });

  it('refuses an address that could inject a header', async () => {
    const port = (server.address() as AddressInfo).port;
    await expect(
      new SmtpMailer('127.0.0.1', port).send({ to: 'a@b.co>\r\nBcc: x@y.z', subject: 's', text: 't' }),
    ).rejects.toThrow('unsafe address');
  });
});
