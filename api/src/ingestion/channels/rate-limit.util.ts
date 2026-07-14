/**
 * Fixed-window rate limiter for the PUBLIC capture endpoints (they sit outside
 * auth, so they are the one place an attacker can hammer for free).
 *
 * In-process by design, like the ingestion worker: Railway runs a single `api`
 * service today. Limits are therefore per replica — the effective ceiling scales
 * with replica count, which is fine for an abuse guard (it is not a billing
 * quota). If the API is ever scaled out and a hard global cap is needed, only
 * this class changes: swap the Map for a Redis INCR/EXPIRE or a Postgres counter
 * and nothing else in the channel code moves.
 */
export class RateLimiter {
  private readonly hits = new Map<string, { n: number; resetAt: number }>();

  /** true = allowed. Call once per request, AFTER cheap routing, BEFORE any work. */
  allow(key: string, limit: number, windowMs = 60_000, now = Date.now()): boolean {
    if (limit <= 0) return true;
    const cur = this.hits.get(key);
    if (!cur || cur.resetAt <= now) {
      this.hits.set(key, { n: 1, resetAt: now + windowMs });
      if (this.hits.size > 5000) this.sweep(now);
      return true;
    }
    cur.n += 1;
    return cur.n <= limit;
  }

  /** Seconds until the window resets — the Retry-After header. */
  retryAfter(key: string, now = Date.now()): number {
    const cur = this.hits.get(key);
    if (!cur || cur.resetAt <= now) return 0;
    return Math.max(1, Math.ceil((cur.resetAt - now) / 1000));
  }

  private sweep(now: number) {
    for (const [k, v] of this.hits) if (v.resetAt <= now) this.hits.delete(k);
  }

  /** tests */
  reset() { this.hits.clear(); }
}
