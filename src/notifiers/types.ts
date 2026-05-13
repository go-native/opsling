import type { NotificationEvent } from '../types/index.js';

export interface Notifier {
  name: string;
  send(event: NotificationEvent): Promise<void> | void;
}
