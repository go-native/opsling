import type { Config } from '../../config/types.js';
import type { PollCollector } from '../types.js';
import { createCpuCollector } from './cpu.js';
import { createDiskCollector } from './disk.js';
import { createLoadCollector } from './load.js';
import { createMemoryCollector } from './memory.js';

export const createSystemCollectors = (config: Config): PollCollector[] => [
  createCpuCollector(config),
  createMemoryCollector(config),
  createLoadCollector(config),
  createDiskCollector(config),
];
