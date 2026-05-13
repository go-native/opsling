import type { Logger } from 'pino';
import type { NotificationEvent } from '../types/index.js';
import type { Notifier } from './types.js';

export class NotifierRegistry {
  private readonly notifiers: Notifier[] = [];

  constructor(private readonly logger: Logger) {}

  register(notifier: Notifier): void {
    this.notifiers.push(notifier);
  }

  dispatch(event: NotificationEvent): void {
    for (const notifier of this.notifiers) {
      try {
        const result = notifier.send(event);
        if (result instanceof Promise) {
          result.catch((err) =>
            this.logger.warn({ err, notifier: notifier.name }, 'notifier send failed'),
          );
        }
      } catch (err) {
        this.logger.warn({ err, notifier: notifier.name }, 'notifier send threw');
      }
    }
  }
}

export type { Notifier };
