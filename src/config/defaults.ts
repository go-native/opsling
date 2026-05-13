export const DEFAULTS = {
  systemThresholds: {
    cpu: 85,
    memory: 85,
    disk: 90,
    load: 4.0,
  },
  logScan: {
    errorPatterns: ['ERROR', 'FATAL', 'panic', 'Exception', 'Traceback'],
    ignorePatterns: [] as string[],
    minOccurrences: 3,
    windowSeconds: 60,
  },
  intervals: {
    systemSeconds: 30,
    diskSeconds: 300,
  },
  alerting: {
    requireConsecutive: 2,
    reNotifyAfterMinutes: 30,
    sendRecovery: true,
  },
  ignoreContainers: ['opsling'],
  httpPort: 4717,
  logLevel: 'info',
} as const;
