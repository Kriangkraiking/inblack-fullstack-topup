import { Injectable } from '@nestjs/common';
import { eventsTokenSecret, signEventsToken, verifyEventsToken } from './events-token.js';

/** Reads the secret when the app starts, so a missing one stops the API instead of every stream. */
@Injectable()
export class EventsTokenService {
  private readonly secret = eventsTokenSecret();

  issue(orderId: string): { events_token: string; events_token_expires_at: string } {
    const { token, expiresAt } = signEventsToken(this.secret, orderId);
    return { events_token: token, events_token_expires_at: new Date(expiresAt * 1000).toISOString() };
  }

  verify(orderId: string, token: unknown): number | null {
    return verifyEventsToken(this.secret, orderId, token);
  }
}
