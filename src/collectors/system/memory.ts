import si from 'systeminformation';
import type { Config } from '../../config/types.js';
import type { Reading } from '../../types/index.js';
import type { PollCollector } from '../types.js';

export const createMemoryCollector = (config: Config): PollCollector => ({
  name: 'system.memory',
  intervalMs: config.intervals.systemSeconds * 1000,
  async collect(): Promise<Reading[]> {
    const mem = await si.mem();
    const usedPercent = mem.total > 0 ? (mem.active / mem.total) * 100 : 0;
    const value = Number(usedPercent.toFixed(1));
    const threshold = config.systemThresholds.memory;
    return [
      {
        key: { scope: 'system', metric: 'memory' },
        value,
        threshold,
        unit: '%',
        over: value >= threshold,
        severity: value >= threshold ? 'critical' : 'info',
        message: 'High Memory',
        details: {
          usedGB: Number((mem.active / 1024 ** 3).toFixed(2)),
          totalGB: Number((mem.total / 1024 ** 3).toFixed(2)),
        },
        timestamp: new Date(),
      },
    ];
  },
});
