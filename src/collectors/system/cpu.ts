import si from 'systeminformation';
import type { Config } from '../../config/types.js';
import type { Reading } from '../../types/index.js';
import type { PollCollector } from '../types.js';

export const createCpuCollector = (config: Config): PollCollector => ({
  name: 'system.cpu',
  intervalMs: config.intervals.systemSeconds * 1000,
  async collect(): Promise<Reading[]> {
    const load = await si.currentLoad();
    const value = Number(load.currentLoad.toFixed(1));
    const threshold = config.systemThresholds.cpu;
    return [
      {
        key: { scope: 'system', metric: 'cpu' },
        value,
        threshold,
        unit: '%',
        over: value >= threshold,
        severity: value >= threshold ? 'critical' : 'info',
        message: 'High CPU',
        timestamp: new Date(),
      },
    ];
  },
});
