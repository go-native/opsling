import os from 'node:os';
import type { Config } from '../../config/types.js';
import type { Reading } from '../../types/index.js';
import type { PollCollector } from '../types.js';

export const createLoadCollector = (config: Config): PollCollector => ({
  name: 'system.load',
  intervalMs: config.intervals.systemSeconds * 1000,
  async collect(): Promise<Reading[]> {
    const [one] = os.loadavg();
    const cores = Math.max(1, os.cpus().length);
    const perCore = (one ?? 0) / cores;
    const value = Number(perCore.toFixed(2));
    const threshold = config.systemThresholds.load;
    return [
      {
        key: { scope: 'system', metric: 'load' },
        value,
        threshold,
        unit: '/core',
        over: value >= threshold,
        severity: value >= threshold ? 'warning' : 'info',
        message: 'High load average',
        details: { cores, oneMin: Number((one ?? 0).toFixed(2)) },
        timestamp: new Date(),
      },
    ];
  },
});
