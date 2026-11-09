import { Injectable } from '@nestjs/common';
import { DbService, type Tx } from '../db/db.service.js';
import type { OtpState } from './otp.js';

/** All SQL for customer OTP codes and customer sessions (db/migrations/0009_customer_auth.sql). */
@Injectable()
export class CustomerAuthRepository {
  constructor(private readonly db: DbService) {}

  transaction<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
    return this.db.transaction(work);
  }

  /**
   * Stores a new code unless the email is locked or got one less than `cooldownSeconds` ago.
   * One statement, so two requests at once cannot both pass the cooldown. The failure count is
   * left alone: asking for a new code must not reset the guesses left before the lock.
   */
  async storeCode(
    email: string,
    codeHash: string,
    ttlSeconds: number,
    cooldownSeconds: number,
  ): Promise<boolean> {
    const { rowCount } = await this.db.query(
      `INSERT INTO customer_otps (email, code_hash, expires_at)
       VALUES ($1, $2, now() + make_interval(secs => $3::double precision))
       ON CONFLICT (email) DO UPDATE
         SET code_hash = EXCLUDED.code_hash,
             expires_at = EXCLUDED.expires_at,
             consumed_at = NULL,
             last_sent_at = now()
         WHERE customer_otps.last_sent_at <= now() - make_interval(secs => $4::double precision)
           AND (customer_otps.locked_until IS NULL OR customer_otps.locked_until <= now())`,
      [email, codeHash, ttlSeconds, cooldownSeconds],
    );
    return rowCount === 1;
  }

  /** The row lock makes verifies of one email take turns, so a code can be accepted once. */
  async lockState(tx: Tx, email: string): Promise<OtpState | undefined> {
    const { rows } = await tx.query<{
      code_hash: string | null;
      expired: boolean;
      consumed: boolean;
      failed_attempts: number;
      locked_for: number | null;
    }>(
      `SELECT code_hash,
              expires_at <= now() AS expired,
              consumed_at IS NOT NULL AS consumed,
              failed_attempts,
              CASE WHEN locked_until > now()
                THEN ceil(extract(epoch FROM locked_until - now()))::int END AS locked_for
       FROM customer_otps WHERE email = $1 FOR UPDATE`,
      [email],
    );
    const row = rows[0];
    if (!row) return undefined;
    return {
      codeHash: row.code_hash,
      expired: row.expired,
      consumed: row.consumed,
      failedAttempts: row.failed_attempts,
      lockedForSeconds: row.locked_for,
    };
  }

  async recordFailure(tx: Tx, email: string, failedAttempts: number): Promise<void> {
    await tx.query('UPDATE customer_otps SET failed_attempts = $2 WHERE email = $1', [
      email,
      failedAttempts,
    ]);
  }

  /** The code is dropped too, so the lock ending does not bring the old code back. */
  async lock(tx: Tx, email: string, lockSeconds: number): Promise<void> {
    await tx.query(
      `UPDATE customer_otps
       SET failed_attempts = 0, code_hash = NULL,
           locked_until = now() + make_interval(secs => $2::double precision)
       WHERE email = $1`,
      [email, lockSeconds],
    );
  }

  /** Conditional on the code still being unused and unexpired, on top of the row lock. */
  async consume(tx: Tx, email: string, codeHash: string): Promise<boolean> {
    const { rowCount } = await tx.query(
      `UPDATE customer_otps SET consumed_at = now(), failed_attempts = 0
       WHERE email = $1 AND code_hash = $2 AND consumed_at IS NULL AND expires_at > now()`,
      [email, codeHash],
    );
    return rowCount === 1;
  }

  async createSession(tx: Tx, tokenHash: string, email: string, ttlSeconds: number): Promise<void> {
    await tx.query('DELETE FROM customer_sessions WHERE expires_at <= now()');
    await tx.query(
      `INSERT INTO customer_sessions (token_hash, email, expires_at)
       VALUES ($1, $2, now() + make_interval(secs => $3::double precision))`,
      [tokenHash, email, ttlSeconds],
    );
  }

  async findSessionEmail(tokenHash: string): Promise<string | undefined> {
    const { rows } = await this.db.query<{ email: string }>(
      'SELECT email FROM customer_sessions WHERE token_hash = $1 AND expires_at > now()',
      [tokenHash],
    );
    return rows[0]?.email;
  }

  async deleteSession(tokenHash: string): Promise<void> {
    await this.db.query('DELETE FROM customer_sessions WHERE token_hash = $1', [tokenHash]);
  }
}
