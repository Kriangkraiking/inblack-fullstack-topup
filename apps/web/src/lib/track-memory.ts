/**
 * After checkout the browser goes to mock-pay and comes back to /track?order_id=...
 * without the email. The email is kept in this tab's sessionStorage so the
 * tracking page can open the order without asking again. It never goes into a URL.
 */
const key = (orderId: string) => `inblack:track-email:${orderId}`;

export function rememberTrackEmail(orderId: string, email: string): void {
  try {
    sessionStorage.setItem(key(orderId), email);
  } catch {
    // Storage blocked: the customer types the email on the tracking page.
  }
}

export function recallTrackEmail(orderId: string): string | null {
  try {
    return sessionStorage.getItem(key(orderId));
  } catch {
    return null;
  }
}
