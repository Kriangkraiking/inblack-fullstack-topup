import { createHash, randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { AdminAuthRepository } from './admin-auth.repository.js';
import type { Admin } from './admin-roles.js';
import {
  ADMIN_LOGIN_WINDOW_SECONDS,
  decideLoginAttempt,
  invalidCredentials,
  loginEmailKey,
  loginLocked,
  loginUsernameKey,
} from './login-limit.js';
import { DUMMY_HASH, verifyPassword } from './password.js';

/** Validated by the controller: a normalised email, or a username (never contains @). */
export type LoginIdentifier = { kind: 'email'; value: string } | { kind: 'username'; value: string };

const DEFAULT_TTL_SECONDS = 8 * 60 * 60;

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function sessionTtlSeconds(): number {
  const ttl = Number(process.env.ADMIN_SESSION_TTL_SECONDS ?? DEFAULT_TTL_SECONDS);
  if (!Number.isInteger(ttl) || ttl <= 0) {
    throw new Error('ADMIN_SESSION_TTL_SECONDS must be a positive integer');
  }
  return ttl;
}

@Injectable()
export class AdminAuthService {
  readonly ttlSeconds = sessionTtlSeconds();

  constructor(private readonly repository: AdminAuthRepository) {}

  /**
   * The same answer and about the same time for an unknown account and a wrong password. The
   * attempt is counted in Postgres before the password is checked (ADR 0005): per email, or for a
   * username per username and also per the account's email, so switching between the two does
   * not buy more guesses for one account.
   */
  async login(identifier: LoginIdentifier, password: string): Promise<{ admin: Admin; token: string }> {
    const key =
      identifier.kind === 'email' ? loginEmailKey(identifier.value) : loginUsernameKey(identifier.value);
    await this.countAttempt(key);
    const found =
      identifier.kind === 'email'
        ? await this.repository.findActiveByEmail(identifier.value)
        : await this.repository.findActiveByUsername(identifier.value);
    const accountKey = found && identifier.kind === 'username' ? loginEmailKey(found.email) : undefined;
    if (accountKey) await this.countAttempt(accountKey);
    const passwordOk = await verifyPassword(password, found?.password_hash ?? DUMMY_HASH);
    if (!found || !passwordOk) throw invalidCredentials();
    await this.repository.clearLoginAttempts(key);
    if (accountKey) await this.repository.clearLoginAttempts(accountKey);
    const token = randomBytes(32).toString('base64url');
    await this.repository.createSession(found.id, hashToken(token), this.ttlSeconds);
    return {
      admin: { id: found.id, email: found.email, username: found.username ?? null, role: found.role },
      token,
    };
  }

  private async countAttempt(key: string): Promise<void> {
    const decision = decideLoginAttempt(
      await this.repository.registerLoginAttempt(key, ADMIN_LOGIN_WINDOW_SECONDS),
    );
    if (decision.kind === 'locked') throw loginLocked(decision.retryAfterSeconds);
  }

  authenticate(token: string): Promise<Admin | undefined> {
    return this.repository.findSessionAdmin(hashToken(token));
  }

  logout(token: string): Promise<void> {
    return this.repository.deleteSession(hashToken(token));
  }
}
