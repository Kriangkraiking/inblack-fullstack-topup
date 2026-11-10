/** Session tokens are 32 random bytes in base64url. */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** The value of one cookie, or undefined. Only the first cookie with that name counts. */
export function readCookie(cookieHeader: string | undefined, name: string): string | undefined {
  for (const part of (cookieHeader ?? '').split(';')) {
    const separator = part.indexOf('=');
    if (separator !== -1 && part.slice(0, separator).trim() === name) {
      return part.slice(separator + 1).trim();
    }
  }
  return undefined;
}

export function readTokenCookie(cookieHeader: string | undefined, name: string): string | undefined {
  const value = readCookie(cookieHeader, name);
  return value !== undefined && TOKEN_PATTERN.test(value) ? value : undefined;
}

/**
 * The same flags for every session cookie, admin and customer. Secure follows COOKIE_SECURE,
 * which compose and .env.example set to true: browsers keep Secure cookies on http://localhost,
 * and behind TLS it must be on. Unset means off, so a bare `node dist/main` on another plain-http
 * host still signs in (ADR 0005).
 */
export function sessionCookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'strict' as const,
    secure: process.env.COOKIE_SECURE === 'true',
    path: '/',
  };
}
