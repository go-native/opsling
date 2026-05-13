import type { Reading } from '../types/index.js';

/**
 * Pull-style collector — invoked by the scheduler on an interval.
 * Returns zero or more readings per tick.
 */
export interface PollCollector {
  name: string;
  intervalMs: number;
  collect(signal: AbortSignal): Promise<Reading[]>;
}

/**
 * Stream-style collector — owns its own lifecycle. Pushes readings as
 * they happen (e.g. Docker events, log tails).
 */
export interface StreamCollector {
  name: string;
  start(signal: AbortSignal): Promise<void> | void;
  stop(): Promise<void> | void;
}
