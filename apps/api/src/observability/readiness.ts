/** Pure part of /readyz: runs each check with its own deadline and reports which ones failed. */

export const CHECK_TIMEOUT_MS = 1000;

export type Check = () => Promise<unknown>;

export interface Readiness {
  ready: boolean;
  checks: Record<string, 'ok' | 'fail'>;
}

function withDeadline(check: Check, timeoutMs: number): Promise<'ok' | 'fail'> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<'fail'>((resolve) => {
    timer = setTimeout(() => resolve('fail'), timeoutMs);
  });
  const run = Promise.resolve()
    .then(check)
    .then(
      () => 'ok' as const,
      () => 'fail' as const,
    );
  return Promise.race([run, deadline]).finally(() => clearTimeout(timer));
}

/** All checks run at once, so the answer takes at most one timeout, not one per dependency. */
export async function evaluate(checks: Record<string, Check>, timeoutMs = CHECK_TIMEOUT_MS): Promise<Readiness> {
  const names = Object.keys(checks);
  const results = await Promise.all(names.map((name) => withDeadline(checks[name], timeoutMs)));
  const out: Record<string, 'ok' | 'fail'> = {};
  names.forEach((name, i) => {
    out[name] = results[i];
  });
  return { ready: results.every((r) => r === 'ok'), checks: out };
}
