import type { LoggerService } from '@nestjs/common';
import { currentRequestId } from './request-context.js';

type Level = 'debug' | 'info' | 'warn' | 'error' | 'fatal';

const EMAIL_PATTERN = /([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g;
const SECRET_KEYS = /pass|cookie|authorization|signature|secret|token|otp/i;
const PII_KEYS = /^(email|game_uid|gameUid)$/;

/** a***@example.com: enough to tell two customers apart in a log, not enough to contact one. */
export function maskEmail(value: string): string {
  return value.replace(EMAIL_PATTERN, '$1***@$2');
}

function maskMiddle(value: string): string {
  return value.length <= 2 ? '**' : `${value[0]}***${value[value.length - 1]}`;
}

/** Secrets are dropped, PII is masked and any email inside free text is masked too. */
export function redact(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (SECRET_KEYS.test(key)) out[key] = '[redacted]';
    else if (PII_KEYS.test(key) && typeof value === 'string') {
      out[key] = key === 'email' ? maskEmail(value) : maskMiddle(value);
    } else if (typeof value === 'string') out[key] = maskEmail(value);
    else out[key] = value;
  }
  return out;
}

/**
 * One JSON object per line with level, time, msg and request_id, for Nest's own messages too.
 * The request id comes from the async context, so code that logs does not pass it around.
 */
export class JsonLogger implements LoggerService {
  constructor(
    private readonly base: Record<string, unknown>,
    private readonly write: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
  ) {}

  log(message: unknown, ...rest: unknown[]) {
    this.emit('info', message, rest);
  }
  error(message: unknown, ...rest: unknown[]) {
    this.emit('error', message, rest);
  }
  warn(message: unknown, ...rest: unknown[]) {
    this.emit('warn', message, rest);
  }
  debug(message: unknown, ...rest: unknown[]) {
    this.emit('debug', message, rest);
  }
  verbose(message: unknown, ...rest: unknown[]) {
    this.emit('debug', message, rest);
  }
  fatal(message: unknown, ...rest: unknown[]) {
    this.emit('fatal', message, rest);
  }

  private emit(level: Level, message: unknown, rest: unknown[]) {
    // Nest passes the context name last. A stack trace is left out on purpose: it can quote input.
    const context = typeof rest[rest.length - 1] === 'string' ? rest[rest.length - 1] : undefined;
    const fields =
      message !== null && typeof message === 'object' && !(message instanceof Error)
        ? (message as Record<string, unknown>)
        : { msg: message instanceof Error ? message.message : String(message) };
    const requestId = currentRequestId();
    this.write(
      JSON.stringify({
        level,
        time: new Date().toISOString(),
        ...this.base,
        ...(context ? { context } : {}),
        ...(requestId ? { request_id: requestId } : {}),
        ...redact(fields),
      }),
    );
  }
}
