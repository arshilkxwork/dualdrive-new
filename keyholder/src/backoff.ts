// How long to wait before reopening the event stream: 1s, 2s, 4s and so on
// up to 30s, so a gateway that is down or restarting isn't hit every couple
// of seconds. A connection that opens properly starts the count again.

export class Backoff {
  private failures = 0;

  constructor(
    private readonly firstMs = 1000,
    private readonly maxMs = 30_000,
  ) {}

  // The wait before the next attempt, counting this one as a failure.
  next(): number {
    const delay = Math.min(this.maxMs, this.firstMs * 2 ** Math.min(this.failures, 30));
    this.failures++;
    return delay;
  }

  reset(): void {
    this.failures = 0;
  }
}

// fetch reports a refused or timed-out connection as "fetch failed" and keeps
// the reason (ECONNREFUSED, ETIMEDOUT, ...) on `cause`. The log needs it.
export function describeNetworkError(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }
  const cause = (error as Error & { cause?: unknown }).cause;
  const code = typeof cause === 'object' && cause !== null && 'code' in cause ? String((cause as { code: unknown }).code) : null;
  return code && !error.message.includes(code) ? `${error.message} (${code})` : error.message;
}
