import os from 'node:os';
import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';
import { DEFAULTS } from './defaults.js';
import type { Config } from './types.js';

/**
 * Parse a list-valued env var. Accepts two notations interchangeably:
 *   FOO=api,worker,postgres           ← comma-separated (simple, common)
 *   FOO=["api","worker","postgres"]   ← JSON array (explicit, copy-pasteable)
 * Whitespace around items is trimmed; empty items are dropped.
 */
const list = (raw: string | undefined): string[] => {
  const value = (raw ?? '').trim();
  if (!value) return [];
  if (value.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (Array.isArray(parsed)) {
        return parsed.map((v) => String(v).trim()).filter(Boolean);
      }
    } catch {
      // fall through to CSV
    }
  }
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
};

const bool = (raw: string | undefined, fallback: boolean): boolean => {
  if (raw === undefined || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
};

const num = (raw: string | undefined, fallback: number): number => {
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw new Error(`Expected number, got "${raw}"`);
  }
  return n;
};

const heartbeatTime = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'must be HH:MM (24h)')
  .nullable();

const RawEnv = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1, 'TELEGRAM_BOT_TOKEN is required'),
  TELEGRAM_CHAT_ID: z.string().min(1, 'TELEGRAM_CHAT_ID is required'),
  HOSTNAME_LABEL: z.string().optional(),
  IGNORE_CONTAINERS: z.string().optional(),
  CPU_THRESHOLD: z.string().optional(),
  MEMORY_THRESHOLD: z.string().optional(),
  DISK_THRESHOLD: z.string().optional(),
  LOAD_THRESHOLD: z.string().optional(),
  LOG_ERROR_PATTERNS: z.string().optional(),
  LOG_IGNORE_PATTERNS: z.string().optional(),
  LOG_ALERT_MIN_OCCURRENCES: z.string().optional(),
  LOG_ALERT_WINDOW_SECONDS: z.string().optional(),
  SYSTEM_INTERVAL_SECONDS: z.string().optional(),
  DISK_INTERVAL_SECONDS: z.string().optional(),
  REQUIRE_CONSECUTIVE: z.string().optional(),
  RENOTIFY_AFTER_MINUTES: z.string().optional(),
  SEND_RECOVERY: z.string().optional(),
  DAILY_HEARTBEAT_AT: z.string().optional(),
  LOG_LEVEL: z.string().optional(),
  HTTP_PORT: z.string().optional(),
  HOST_FS_ROOT: z.string().optional(),
  NODE_ENV: z.enum(['development', 'production', 'test']).optional(),
});

export interface LoadConfigOptions {
  /** Skip dotenv loading. Useful for tests. */
  skipDotenv?: boolean;
  /** Source env vars (defaults to process.env). */
  env?: NodeJS.ProcessEnv;
}

export const loadConfig = (options: LoadConfigOptions = {}): Config => {
  if (!options.skipDotenv) {
    loadDotenv();
  }
  const env = options.env ?? process.env;

  const parsed = RawEnv.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  const raw = parsed.data;

  const heartbeat = raw.DAILY_HEARTBEAT_AT?.trim() ? raw.DAILY_HEARTBEAT_AT.trim() : null;
  const heartbeatParsed = heartbeatTime.safeParse(heartbeat);
  if (!heartbeatParsed.success) {
    throw new Error(
      `Invalid DAILY_HEARTBEAT_AT: ${heartbeatParsed.error.issues[0]?.message ?? 'invalid'}`,
    );
  }

  // Default ignore list = ['opsling'] so the watchdog doesn't alert on its
  // own restarts. If the user explicitly sets IGNORE_CONTAINERS we respect
  // exactly what they specified — including the empty case, which means
  // "alert on everything including yourself" (rare, but their call).
  const ignoreContainers =
    raw.IGNORE_CONTAINERS === undefined
      ? [...DEFAULTS.ignoreContainers]
      : list(raw.IGNORE_CONTAINERS);

  return Object.freeze<Config>({
    hostnameLabel: raw.HOSTNAME_LABEL?.trim() || os.hostname(),
    telegram: {
      botToken: raw.TELEGRAM_BOT_TOKEN,
      chatId: raw.TELEGRAM_CHAT_ID,
    },
    ignoreContainers,
    systemThresholds: {
      cpu: num(raw.CPU_THRESHOLD, DEFAULTS.systemThresholds.cpu),
      memory: num(raw.MEMORY_THRESHOLD, DEFAULTS.systemThresholds.memory),
      disk: num(raw.DISK_THRESHOLD, DEFAULTS.systemThresholds.disk),
      load: num(raw.LOAD_THRESHOLD, DEFAULTS.systemThresholds.load),
    },
    logScan: {
      errorPatterns: list(raw.LOG_ERROR_PATTERNS).length
        ? list(raw.LOG_ERROR_PATTERNS)
        : [...DEFAULTS.logScan.errorPatterns],
      ignorePatterns: list(raw.LOG_IGNORE_PATTERNS),
      minOccurrences: num(raw.LOG_ALERT_MIN_OCCURRENCES, DEFAULTS.logScan.minOccurrences),
      windowSeconds: num(raw.LOG_ALERT_WINDOW_SECONDS, DEFAULTS.logScan.windowSeconds),
    },
    intervals: {
      systemSeconds: num(raw.SYSTEM_INTERVAL_SECONDS, DEFAULTS.intervals.systemSeconds),
      diskSeconds: num(raw.DISK_INTERVAL_SECONDS, DEFAULTS.intervals.diskSeconds),
    },
    alerting: {
      requireConsecutive: num(raw.REQUIRE_CONSECUTIVE, DEFAULTS.alerting.requireConsecutive),
      reNotifyAfterMinutes: num(raw.RENOTIFY_AFTER_MINUTES, DEFAULTS.alerting.reNotifyAfterMinutes),
      sendRecovery: bool(raw.SEND_RECOVERY, DEFAULTS.alerting.sendRecovery),
      dailyHeartbeatAt: heartbeatParsed.data,
    },
    hostFsRoot: raw.HOST_FS_ROOT?.trim() ? raw.HOST_FS_ROOT.trim().replace(/\/$/, '') : null,
    logLevel: raw.LOG_LEVEL?.trim() || DEFAULTS.logLevel,
    httpPort: num(raw.HTTP_PORT, DEFAULTS.httpPort),
    nodeEnv: raw.NODE_ENV ?? 'production',
  });
};
