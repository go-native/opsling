export type Severity = 'info' | 'warning' | 'critical';

export interface SystemThresholds {
  cpu: number;
  memory: number;
  disk: number;
  load: number;
}

export interface LogScanConfig {
  errorPatterns: string[];
  ignorePatterns: string[];
  minOccurrences: number;
  windowSeconds: number;
}

export interface AlertingConfig {
  requireConsecutive: number;
  reNotifyAfterMinutes: number;
  sendRecovery: boolean;
  dailyHeartbeatAt: string | null;
}

export interface IntervalsConfig {
  systemSeconds: number;
  diskSeconds: number;
}

export interface TelegramConfig {
  botToken: string;
  chatId: string;
}

export interface Config {
  hostnameLabel: string;
  telegram: TelegramConfig;
  ignoreContainers: string[];
  systemThresholds: SystemThresholds;
  logScan: LogScanConfig;
  intervals: IntervalsConfig;
  alerting: AlertingConfig;
  /**
   * When set, the disk collector reads the host's mount table and statfs's
   * each mount via this prefix. Used when Opsling runs in a container with
   * the host's root bind-mounted (e.g. `-v /:/host:ro,rslave`).
   */
  hostFsRoot: string | null;
  logLevel: string;
  httpPort: number;
  nodeEnv: 'development' | 'production' | 'test';
}
