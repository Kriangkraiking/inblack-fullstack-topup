import { Injectable } from '@nestjs/common';
import { DbService, type Tx } from '../db/db.service.js';
import type { Admin, AdminRole } from './admin-roles.js';
import type { LoginAttempt } from './login-limit.js';

/** All SQL for admin login, sessions and the audit log. */

export interface AdminWithHash extends Admin {
  password_hash: string;
}

export interface AuditRow {
  id: string;
  admin_email: string;
  action: string;
  target: string | null;
  detail: Record<string, unknown>;
  created_at: Date;
}

@Injectable()
export class AdminAuthRepository {
  constructor(private readonly db: DbService) {}

  async findActiveByEmail(email: string): Promise<AdminWithHash | undefined> {
    const { rows } = await this.db.query<AdminWithHash>(
      'SELECT id, email, role, password_hash FROM admin_users WHERE email = $1 AND active',
      [email],
    );
    return rows[0];
  }

  /** Counts one attempt for this email key, see db/migrations/0010 admin_login_attempt. */
  async registerLoginAttempt(emailKey: string, windowSeconds: number): Promise<LoginAttempt> {
    const { rows } = await this.db.query<{ attempts: number; retry_after_seconds: number }>(
      'SELECT attempts, retry_after_seconds FROM admin_login_attempt($1, $2)',
      [emailKey, windowSeconds],
    );
    return { attempts: rows[0].attempts, retryAfterSeconds: rows[0].retry_after_seconds };
  }

  async clearLoginAttempts(emailKey: string): Promise<void> {
    await this.db.query('DELETE FROM admin_login_attempts WHERE email_hash = $1', [emailKey]);
  }

  /** The session row and the audit row commit together. */
  async createSession(adminId: string, tokenHash: string, ttlSeconds: number): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.query('DELETE FROM admin_sessions WHERE expires_at <= now()');
      await tx.query(
        `INSERT INTO admin_sessions (token_hash, admin_id, expires_at)
         VALUES ($1, $2, now() + make_interval(secs => $3::double precision))`,
        [tokenHash, adminId, ttlSeconds],
      );
      await this.insertAudit(tx, adminId, 'admin.login', null, {});
    });
  }

  /** Reads active on every request, so disabling an admin ends their sessions at once. */
  async findSessionAdmin(tokenHash: string): Promise<Admin | undefined> {
    const { rows } = await this.db.query<{ id: string; email: string; role: AdminRole }>(
      `SELECT a.id, a.email, a.role
       FROM admin_sessions s JOIN admin_users a ON a.id = s.admin_id
       WHERE s.token_hash = $1 AND s.expires_at > now() AND a.active`,
      [tokenHash],
    );
    return rows[0];
  }

  async deleteSession(tokenHash: string): Promise<void> {
    await this.db.query('DELETE FROM admin_sessions WHERE token_hash = $1', [tokenHash]);
  }

  /** Takes the caller's transaction, so an action and its audit row cannot come apart. */
  async insertAudit(
    tx: Tx,
    adminId: string,
    action: string,
    target: string | null,
    detail: Record<string, unknown>,
  ): Promise<void> {
    await tx.query(
      'INSERT INTO admin_audit_logs (admin_id, action, target, detail) VALUES ($1, $2, $3, $4)',
      [adminId, action, target, JSON.stringify(detail)],
    );
  }

  async listAudit(limit: number, beforeId: string | null, action: string | null): Promise<AuditRow[]> {
    const { rows } = await this.db.query<AuditRow>(
      `SELECT l.id, a.email AS admin_email, l.action, l.target, l.detail, l.created_at
       FROM admin_audit_logs l JOIN admin_users a ON a.id = l.admin_id
       WHERE ($2::bigint IS NULL OR l.id < $2::bigint)
         AND ($3::text IS NULL OR l.action = $3::text)
       ORDER BY l.id DESC
       LIMIT $1`,
      [limit, beforeId, action],
    );
    return rows;
  }
}
