import { createHash, randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ProblemError } from '../common/problem.js';
import { AdminAuthRepository } from './admin-auth.repository.js';
import type { Admin } from './admin-roles.js';
import { DUMMY_HASH, verifyPassword } from './password.js';

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

  /** The same answer and about the same time for an unknown email and a wrong password. */
  async login(email: string, password: string): Promise<{ admin: Admin; token: string }> {
    const found = await this.repository.findActiveByEmail(email);
    const passwordOk = await verifyPassword(password, found?.password_hash ?? DUMMY_HASH);
    if (!found || !passwordOk) {
      throw new ProblemError(401, 'INVALID_CREDENTIALS', 'email or password is incorrect');
    }
    const token = randomBytes(32).toString('base64url');
    await this.repository.createSession(found.id, hashToken(token), this.ttlSeconds);
    return { admin: { id: found.id, email: found.email, role: found.role }, token };
  }

  authenticate(token: string): Promise<Admin | undefined> {
    return this.repository.findSessionAdmin(hashToken(token));
  }

  logout(token: string): Promise<void> {
    return this.repository.deleteSession(hashToken(token));
  }
}
