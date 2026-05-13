import { describe, expect, it } from 'vitest';
import { escapeMd2, formatMessage } from '../../src/notifiers/telegram/formatter.js';
import type { NotificationEvent } from '../../src/types/index.js';

const baseEvent: NotificationEvent = {
  kind: 'firing',
  key: { scope: 'container', subject: 'api', metric: 'cpu' },
  severity: 'critical',
  title: 'High CPU',
  value: 96,
  threshold: 85,
  unit: '%',
  timestamp: new Date('2026-05-12T09:14:00Z'),
  hostname: 'hetzner-cx22',
};

describe('telegram formatter', () => {
  it('escapes MarkdownV2 reserved characters', () => {
    expect(escapeMd2('a.b_c-d!')).toBe('a\\.b\\_c\\-d\\!');
  });

  it('renders a critical firing alert', () => {
    const msg = formatMessage(baseEvent);
    expect(msg).toContain('🔴');
    expect(msg).toContain('High CPU');
    expect(msg).toContain('hetzner\\-cx22');
    expect(msg).toContain('api');
    expect(msg).toMatch(/96.*threshold 85/);
    expect(msg).toContain('12 May 2026');
  });

  it('renders a recovery alert with duration and peak', () => {
    const msg = formatMessage({
      ...baseEvent,
      kind: 'recovered',
      title: 'Recovered',
      severity: 'info',
      peakValue: 99,
      durationMs: 4 * 60_000 + 12_000,
    });
    expect(msg).toContain('✅');
    expect(msg).toContain('Recovered');
    expect(msg).toContain('4m 12s');
    expect(msg).toMatch(/peak.*99/);
  });

  it('renders an event with a code-formatted message', () => {
    const msg = formatMessage({
      ...baseEvent,
      kind: 'event',
      title: 'Container died: worker',
      message: 'exit code 137',
      severity: 'critical',
    });
    expect(msg).toContain('Container died');
    expect(msg).toContain('exit code 137');
  });
});
