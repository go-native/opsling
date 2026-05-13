import { type Logger, pino } from 'pino';

export interface LoggerOptions {
  level: string;
  pretty: boolean;
}

const REDACT_PATHS = [
  'telegram.botToken',
  'TELEGRAM_BOT_TOKEN',
  '*.token',
  '*.secret',
  '*.password',
  '*.apiKey',
];

export const createLogger = (options: LoggerOptions): Logger => {
  return pino({
    level: options.level,
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    base: { service: 'opsling' },
    timestamp: pino.stdTimeFunctions.isoTime,
    ...(options.pretty
      ? {
          transport: {
            target: 'pino-pretty',
            options: {
              colorize: true,
              ignore: 'service,hostname,pid',
              translateTime: 'HH:MM:ss.l',
            },
          },
        }
      : {}),
  });
};

export type { Logger };
