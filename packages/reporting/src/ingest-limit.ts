/**
 * The token bucket both public ingest routes share.
 *
 * `./next`'s analytics collector and its client-error collector are the only
 * two routes in this package a host mounts unauthenticated, and both write to
 * the database on a stranger's say-so. They had one limiter between them: the
 * analytics one. The error route went without until it was noticed that
 * `reporting_errors` never prunes an open row (migrations/0003_errors.sql),
 * so an unbounded public write lands in a table nothing ages out — the two
 * decisions are safe apart and not together.
 *
 * Per process, not per deploy: several containers each keep their own, so the
 * real ceiling is this times the container count. Enough to bound abuse,
 * never to meter.
 */
export class Buckets {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();
  constructor(
    private readonly perMinute: number,
    private readonly now: () => Date,
  ) {}
  take(key: string, n: number): boolean {
    const t = this.now().getTime();
    const b = this.buckets.get(key) ?? { tokens: this.perMinute, at: t };
    b.tokens = Math.min(this.perMinute, b.tokens + ((t - b.at) / 60_000) * this.perMinute);
    b.at = t;
    if (b.tokens < n) {
      this.buckets.set(key, b);
      return false;
    }
    b.tokens -= n;
    this.buckets.set(key, b);
    if (this.buckets.size > 10_000) this.buckets.clear();
    return true;
  }
}
