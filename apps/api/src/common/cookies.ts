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
 * The same flags for every session cookie, admin and customer. Secure is off by default because
 * compose serves plain http on localhost; COOKIE_SECURE=true turns it on behind TLS.
 */
export function sessionCookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'strict' as const,
    secure: process.env.COOKIE_SECURE === 'true',
    path: '/',
  };
}
