import PQueue from 'p-queue';
import type { Logger } from 'pino';
import type { TelegramClient } from './client.js';

/**
 * Telegram per-chat limit is ~1 message/second. We stay below that and
 * retry with exponential backoff on transient failures.
 */
export class TelegramQueue {
  private readonly queue = new PQueue({ concurrency: 1, interval: 1100, intervalCap: 1 });

  constructor(
    private readonly client: TelegramClient,
    private readonly logger: Logger,
  ) {}

  enqueue(text: string, silent = false): void {
    void this.queue.add(async () => this.sendWithRetry(text, silent));
  }

  private async sendWithRetry(text: string, silent: boolean, attempt = 1): Promise<void> {
    try {
      await this.client.sendMessage(text, { silent });
    } catch (err) {
      if (attempt >= 4) {
        this.logger.error({ err, attempt }, 'telegram send failed (gave up)');
        return;
      }
      const backoffMs = 500 * 2 ** attempt;
      this.logger.warn({ err, attempt, backoffMs }, 'telegram send failed, retrying');
      await new Promise((r) => setTimeout(r, backoffMs));
      await this.sendWithRetry(text, silent, attempt + 1);
    }
  }

  async drain(): Promise<void> {
    await this.queue.onIdle();
  }
}
