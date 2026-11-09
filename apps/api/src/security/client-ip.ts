import type { Request } from 'express';

const IP_PATTERN = /^[0-9A-Fa-f:.]{2,45}$/;

/**
 * The address rate limits count against. nginx sets X-Real-IP to $remote_addr and replaces
 * whatever the client sent (proxy_set_header), and the API ports are not published outside the
 * compose network, so this header can only come from nginx. Anything that does not look like
 * an address falls back to the socket, which is nginx itself.
 */
export function clientIp(request: Pick<Request, 'headers' | 'socket'>): string {
  const header = request.headers['x-real-ip'];
  const value = typeof header === 'string' ? header.trim() : '';
  if (IP_PATTERN.test(value)) return value;
  return request.socket.remoteAddress ?? 'unknown';
}
