import { hasRole, type AdminRole } from '../admin/admin-roles.js';

/** b***@example.com. The domain stays: support needs it to spot typos, and it names no one. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at <= 0) return '***';
  return `${email[0]}***${email.slice(at)}`;
}

/** pl****01 for 8 characters or more, otherwise the first character only. */
export function maskGameUid(gameUid: string): string {
  if (gameUid.length >= 8) return `${gameUid.slice(0, 2)}****${gameUid.slice(-2)}`;
  return `${gameUid.slice(0, 1)}***`;
}

/** Spec 4: support and above see email and Game UID in full, viewer sees them masked. */
export function seesFullPii(role: AdminRole): boolean {
  return hasRole(role, 'support');
}

export function maskPii<T extends { email: string; game_uid: string }>(row: T, role: AdminRole): T {
  if (seesFullPii(role)) return row;
  return { ...row, email: maskEmail(row.email), game_uid: maskGameUid(row.game_uid) };
}
