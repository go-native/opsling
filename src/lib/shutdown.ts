import type { Logger } from 'pino';

type ShutdownHandler = () => Promise<void> | void;

export class ShutdownManager {
  private handlers: ShutdownHandler[] = [];
  private shuttingDown = false;
  private readonly controller = new AbortController();

  constructor(private readonly logger: Logger) {}

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  register(handler: ShutdownHandler): void {
    this.handlers.push(handler);
  }

  install(): void {
    const handle = (signal: NodeJS.Signals) => {
      void this.shutdown(signal);
    };
    process.on('SIGINT', handle);
    process.on('SIGTERM', handle);
    process.on('uncaughtException', (err) => {
      this.logger.error({ err }, 'uncaught exception');
      void this.shutdown('uncaughtException', 1);
    });
    process.on('unhandledRejection', (reason) => {
      this.logger.error({ reason }, 'unhandled rejection');
    });
  }

  async shutdown(reason: string, exitCode = 0): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    this.logger.info({ reason }, 'shutting down');
    this.controller.abort();

    const settled = await Promise.allSettled(this.handlers.map((h) => h()));
    for (const result of settled) {
      if (result.status === 'rejected') {
        this.logger.warn({ err: result.reason }, 'shutdown handler failed');
      }
    }

    this.logger.info('bye');
    setImmediate(() => process.exit(exitCode));
  }
}
