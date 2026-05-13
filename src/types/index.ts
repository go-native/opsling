import type { Severity } from '../config/types.js';

export type { Severity };

/**
 * Identifies an alert "channel" — one state machine per key.
 * Examples:
 *   { scope: 'system', metric: 'cpu' }
 *   { scope: 'container', subject: 'api', metric: 'memory' }
 *   { scope: 'container', subject: 'api', metric: 'state' }
 *   { scope: 'container', subject: 'api', metric: 'logs' }
 */
export interface AlertKey {
  scope: 'system' | 'container';
  metric: string;
  subject?: string;
}

export const keyToString = (key: AlertKey): string =>
  key.subject ? `${key.scope}:${key.subject}:${key.metric}` : `${key.scope}:${key.metric}`;

/**
 * A reading produced by a Collector. The alert manager turns sequences of
 * readings into incidents.
 *
 * - `over === true` means the reading is "bad" (crossed the threshold or
 *   the discrete event itself is an alert, e.g. a container died).
 * - For event-style readings (container start/stop/die/etc.), `value` and
 *   `threshold` may be 0 and the message field carries the human payload.
 */
export interface Reading {
  key: AlertKey;
  value: number;
  threshold: number;
  unit?: string;
  over: boolean;
  severity: Severity;
  /** Optional one-line summary that overrides default formatting. */
  message?: string;
  /** Free-form details surfaced in the notification body. */
  details?: Record<string, string | number | boolean>;
  timestamp: Date;
}

export type NotificationKind = 'firing' | 'recovered' | 'renotify' | 'event' | 'heartbeat';

export interface NotificationEvent {
  kind: NotificationKind;
  key: AlertKey;
  severity: Severity;
  title: string;
  /** Headline value at the moment of notification. */
  value?: number;
  threshold?: number;
  unit?: string;
  peakValue?: number;
  durationMs?: number;
  message?: string;
  details?: Record<string, string | number | boolean>;
  timestamp: Date;
  hostname: string;
}
