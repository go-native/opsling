import type { Logger } from 'pino';
import type { TelegramConfig } from '../../config/types.js';
import type { NotificationEvent } from '../../types/index.js';
import type { Notifier } from '../types.js';
import { TelegramClient } from './client.js';
import { formatMessage } from './formatter.js';
import { TelegramQueue } from './queue.js';

export interface TelegramNotifier extends Notifier {
  drain(): Promise<void>;
}

export const createTelegramNotifier = (
  config: TelegramConfig,
  logger: Logger,
): TelegramNotifier => {
  const client = new TelegramClient(config);
  const queue = new TelegramQueue(client, logger);

  return {
    name: 'telegram',
    send(event: NotificationEvent): void {
      const text = formatMessage(event);
      const silent = event.kind === 'heartbeat';
      queue.enqueue(text, silent);
    },
    drain: () => queue.drain(),
  };
};
