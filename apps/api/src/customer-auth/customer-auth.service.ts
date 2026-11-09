import { createHash, randomBytes } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ProblemError } from '../common/problem.js';
import { CustomerAuthRepository } from './customer-auth.repository.js';
import {
  decideVerify,
  generateOtpCode,
  hashOtp,
  OTP_COOLDOWN_SECONDS,
  OTP_LOCK_SECONDS,
  OTP_TTL_SECONDS,
  otpSecret,
} from './otp.js';
import type { Mailer } from './smtp-mailer.js';

export const MAILER = Symbol('MAILER');
const DEFAULT_SESSION_TTL_SECONDS = 24 * 60 * 60;

export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function sessionTtlSeconds(): number {
  const ttl = Number(process.env.CUSTOMER_SESSION_TTL_SECONDS ?? DEFAULT_SESSION_TTL_SECONDS);
  if (!Number.isInteger(ttl) || ttl <= 0) {
    throw new Error('CUSTOMER_SESSION_TTL_SECONDS must be a positive integer');
  }
  return ttl;
}

function otpMail(code: string) {
  return {
    // Not in the subject, which lock screens show.
    subject: 'InBlack Top-Up sign-in code',
    text: [
      `รหัสเข้าสู่ระบบ InBlack Top-Up ของคุณคือ ${code}`,
      'รหัสนี้ใช้ได้ 5 นาทีและใช้ได้ครั้งเดียว อย่าบอกรหัสนี้กับผู้อื่น',
      '',
      `Your InBlack Top-Up sign-in code is ${code}.`,
      'It works once, for 5 minutes. Do not share it with anyone.',
      '',
      'ถ้าคุณไม่ได้ขอรหัสนี้ ไม่ต้องทำอะไร / If you did not ask for this code, ignore this email.',
    ].join('\n'),
  };
}

export function invalidCode(): ProblemError {
  return new ProblemError(401, 'OTP_INVALID', 'the code is wrong or has expired');
}

export function lockedOut(retryAfterSeconds: number): ProblemError {
  return new ProblemError(429, 'OTP_LOCKED', 'too many wrong codes, try again later', {
    'Retry-After': String(retryAfterSeconds),
  });
}

@Injectable()
export class CustomerAuthService {
  private readonly logger = new Logger(CustomerAuthService.name);
  private readonly secret = otpSecret();
  readonly ttlSeconds = sessionTtlSeconds();

  constructor(
    private readonly repository: CustomerAuthRepository,
    @Inject(MAILER) private readonly mailer: Mailer,
  ) {}

  /**
   * Answers the same way whatever the email: no lookup of orders, and the email goes out in the
   * background, so neither the answer nor its timing says whether the address has orders, is
   * locked, or is inside the cooldown. Returns the send so tests can wait for it.
   */
  async requestCode(email: string): Promise<{ sent: Promise<void> | null }> {
    const code = generateOtpCode();
    const stored = await this.repository.storeCode(
      email,
      hashOtp(this.secret, email, code),
      OTP_TTL_SECONDS,
      OTP_COOLDOWN_SECONDS,
    );
    if (!stored) return { sent: null };
    const sent = this.mailer
      .send({ to: email, ...otpMail(code) })
      .catch((error: unknown) =>
        this.logger.warn(`otp email not sent: ${error instanceof Error ? error.message : String(error)}`),
      );
    return { sent };
  }

  /**
   * Every decision is taken under the row lock and committed before the answer, so a wrong code
   * is counted even though the request fails, and ten verifies at once accept the code once.
   */
  async verify(email: string, code: string): Promise<{ email: string; token: string }> {
    const submitted = hashOtp(this.secret, email, code);
    const outcome = await this.repository.transaction(async (tx) => {
      const decision = decideVerify(await this.repository.lockState(tx, email), submitted);
      switch (decision.kind) {
        case 'accept': {
          if (!(await this.repository.consume(tx, email, submitted))) return invalidCode();
          const token = randomBytes(32).toString('base64url');
          await this.repository.createSession(tx, hashSessionToken(token), email, this.ttlSeconds);
          return { token };
        }
        case 'wrong':
          await this.repository.recordFailure(tx, email, decision.failedAttempts);
          return invalidCode();
        case 'lock':
          await this.repository.lock(tx, email, OTP_LOCK_SECONDS);
          return lockedOut(decision.retryAfterSeconds);
        case 'locked':
          return lockedOut(decision.retryAfterSeconds);
        case 'no-code':
        case 'stale':
          return invalidCode();
      }
    });
    if (outcome instanceof ProblemError) throw outcome;
    return { email, token: outcome.token };
  }

  authenticate(token: string): Promise<string | undefined> {
    return this.repository.findSessionEmail(hashSessionToken(token));
  }

  logout(token: string): Promise<void> {
    return this.repository.deleteSession(hashSessionToken(token));
  }
}
