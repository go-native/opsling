import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/env.js';

const minimal = {
  TELEGRAM_BOT_TOKEN: 'fake-token',
  TELEGRAM_CHAT_ID: '12345',
};

describe('loadConfig', () => {
  it('throws when telegram credentials are missing', () => {
    expect(() => loadConfig({ skipDotenv: true, env: {} as NodeJS.ProcessEnv })).toThrow(
      /TELEGRAM_BOT_TOKEN/,
    );
  });

  it('applies defaults when only required vars are set', () => {
    const config = loadConfig({ skipDotenv: true, env: { ...minimal } as NodeJS.ProcessEnv });
    expect(config.systemThresholds.cpu).toBe(85);
    expect(config.systemThresholds.disk).toBe(90);
    expect(config.alerting.requireConsecutive).toBe(2);
    expect(config.alerting.reNotifyAfterMinutes).toBe(30);
    expect(config.alerting.sendRecovery).toBe(true);
    expect(config.alerting.dailyHeartbeatAt).toBeNull();
    expect(config.ignoreContainers).toContain('opsling');
  });

  it('parses CSV lists', () => {
    const config = loadConfig({
      skipDotenv: true,
      env: {
        ...minimal,
        IGNORE_CONTAINERS: 'opsling, traefik, watchtower',
        LOG_ERROR_PATTERNS: 'ERROR,FATAL',
      } as NodeJS.ProcessEnv,
    });
    expect(config.ignoreContainers).toEqual(['opsling', 'traefik', 'watchtower']);
    expect(config.logScan.errorPatterns).toEqual(['ERROR', 'FATAL']);
  });

  it('parses JSON-array lists', () => {
    const config = loadConfig({
      skipDotenv: true,
      env: {
        ...minimal,
        IGNORE_CONTAINERS: '["opsling","traefik","watchtower"]',
        LOG_ERROR_PATTERNS: '["ERROR","FATAL","Traceback"]',
      } as NodeJS.ProcessEnv,
    });
    expect(config.ignoreContainers).toEqual(['opsling', 'traefik', 'watchtower']);
    expect(config.logScan.errorPatterns).toEqual(['ERROR', 'FATAL', 'Traceback']);
  });

  it('falls back to CSV when JSON-array parsing fails', () => {
    const config = loadConfig({
      skipDotenv: true,
      env: {
        ...minimal,
        // looks like array but malformed — treated as one string item, not an error
        IGNORE_CONTAINERS: '[not, valid, json',
      } as NodeJS.ProcessEnv,
    });
    expect(config.ignoreContainers).toEqual(['[not', 'valid', 'json']);
  });

  it('rejects invalid heartbeat time', () => {
    expect(() =>
      loadConfig({
        skipDotenv: true,
        env: { ...minimal, DAILY_HEARTBEAT_AT: '25:99' } as NodeJS.ProcessEnv,
      }),
    ).toThrow(/HH:MM/);
  });

  it('accepts a valid heartbeat time', () => {
    const config = loadConfig({
      skipDotenv: true,
      env: { ...minimal, DAILY_HEARTBEAT_AT: '09:00' } as NodeJS.ProcessEnv,
    });
    expect(config.alerting.dailyHeartbeatAt).toBe('09:00');
  });

  it('defaults to ignoring opsling itself when IGNORE_CONTAINERS is unset', () => {
    const config = loadConfig({
      skipDotenv: true,
      env: { ...minimal } as NodeJS.ProcessEnv,
    });
    expect(config.ignoreContainers).toEqual(['opsling']);
  });

  it('respects an explicit IGNORE_CONTAINERS value exactly', () => {
    const config = loadConfig({
      skipDotenv: true,
      env: { ...minimal, IGNORE_CONTAINERS: 'other,thing' } as NodeJS.ProcessEnv,
    });
    expect(config.ignoreContainers).toEqual(['other', 'thing']);
    // user opted out of the opsling default — we don't force it back
    expect(config.ignoreContainers).not.toContain('opsling');
  });
});
