/**
 * Counting semaphore: at most `limit` callers run their task at once, the rest queue FIFO.
 * Caps fan-outs whose per-item work opens sockets or spawns processes — backend waiters and
 * the ffmpeg/hashing completion work inside them — which unbounded would run once per job
 * simultaneously on a 1000-job project.
 */
export class Semaphore {
  private available: number;
  private readonly waiters: Array<() => void> = [];

  constructor(limit: number) {
    this.available = Math.max(1, limit);
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.available > 0) {
      this.available--;
    } else {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    try {
      return await fn();
    } finally {
      const next = this.waiters.shift();
      if (next) {
        next();
      } else {
        this.available++;
      }
    }
  }
}
