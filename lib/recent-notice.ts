type RecentNotice<T> = {
  value: T;
  expiresAt: number;
  delivered: boolean;
};

export class RecentNoticeBuffer<T> {
  private entries: RecentNotice<T>[] = [];
  private readonly ttlMs: number;
  private readonly maxEntries: number;

  constructor(
    ttlMs: number,
    maxEntries = 4,
  ) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
  }

  remember(value: T, now = Date.now()): void {
    this.prune(now);
    this.entries.push({ value, expiresAt: now + this.ttlMs, delivered: false });
    if (this.entries.length > this.maxEntries) {
      this.entries.splice(0, this.entries.length - this.maxEntries);
    }
  }

  take(now = Date.now()): T[] {
    this.prune(now);
    const pending = this.entries.filter((entry) => !entry.delivered);
    for (const entry of pending) entry.delivered = true;
    return pending.map((entry) => entry.value);
  }

  private prune(now: number): void {
    this.entries = this.entries.filter((entry) => entry.expiresAt > now);
  }
}
