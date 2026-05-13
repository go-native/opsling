import type { Logger } from 'pino';

export interface Job {
  name: string;
  intervalMs: number;
  run(signal: AbortSignal): Promise<void> | void;
}

export class Scheduler {
  private readonly timers: NodeJS.Timeout[] = [];

  constructor(
    private readonly logger: Logger,
    private readonly signal: AbortSignal,
  ) {}

  start(jobs: Job[]): void {
    for (const job of jobs) {
      this.schedule(job);
    }
    this.signal.addEventListener('abort', () => this.stop(), { once: true });
  }

  private schedule(job: Job): void {
    let running = false;
    const tick = async () => {
      if (this.signal.aborted || running) return;
      running = true;
      try {
        await job.run(this.signal);
      } catch (err) {
        this.logger.error({ err, job: job.name }, 'scheduled job failed');
      } finally {
        running = false;
      }
    };
    // first run immediately so the user gets fresh data on startup
    void tick();
    const timer = setInterval(tick, job.intervalMs);
    this.timers.push(timer);
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers.length = 0;
  }
}
