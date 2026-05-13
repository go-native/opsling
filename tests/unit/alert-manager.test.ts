import { describe, expect, it } from 'vitest';
import { AlertManager } from '../../src/core/alert-manager.js';
import type { NotificationEvent, Reading } from '../../src/types/index.js';

const baseConfig = {
  requireConsecutive: 2,
  reNotifyAfterMinutes: 30,
  sendRecovery: true,
  dailyHeartbeatAt: null,
};

const makeManager = (overrides: Partial<typeof baseConfig> = {}) => {
  const events: NotificationEvent[] = [];
  let now = new Date('2026-05-12T09:00:00Z').getTime();
  const manager = new AlertManager({
    config: { ...baseConfig, ...overrides },
    hostname: 'test-host',
    now: () => new Date(now),
  });
  manager.onNotification((e) => events.push(e));
  const advance = (ms: number) => {
    now += ms;
  };
  return { manager, events, advance, getNow: () => new Date(now) };
};

const reading = (over: boolean, value: number, at: Date): Reading => ({
  key: { scope: 'system', metric: 'cpu' },
  value,
  threshold: 85,
  unit: '%',
  over,
  severity: over ? 'critical' : 'info',
  message: 'High CPU',
  timestamp: at,
});

describe('AlertManager', () => {
  it('fires after requireConsecutive over-threshold readings', () => {
    const { manager, events, getNow } = makeManager();
    manager.ingest(reading(true, 90, getNow()));
    expect(events).toHaveLength(0);
    manager.ingest(reading(true, 92, getNow()));
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe('firing');
  });

  it('does not fire on a single spike', () => {
    const { manager, events, getNow } = makeManager();
    manager.ingest(reading(true, 90, getNow()));
    manager.ingest(reading(false, 70, getNow()));
    manager.ingest(reading(true, 91, getNow()));
    manager.ingest(reading(false, 65, getNow()));
    expect(events).toHaveLength(0);
  });

  it('sends a recovered event after sustained under-threshold readings', () => {
    const { manager, events, getNow } = makeManager();
    manager.ingest(reading(true, 90, getNow()));
    manager.ingest(reading(true, 92, getNow()));
    manager.ingest(reading(false, 70, getNow()));
    manager.ingest(reading(false, 65, getNow()));
    expect(events.map((e) => e.kind)).toEqual(['firing', 'recovered']);
    expect(events[1]?.peakValue).toBe(92);
  });

  it('skips recovery message when sendRecovery=false', () => {
    const { manager, events, getNow } = makeManager({ sendRecovery: false });
    manager.ingest(reading(true, 90, getNow()));
    manager.ingest(reading(true, 92, getNow()));
    manager.ingest(reading(false, 70, getNow()));
    manager.ingest(reading(false, 65, getNow()));
    expect(events.map((e) => e.kind)).toEqual(['firing']);
  });

  it('re-notifies after the cooldown when still firing', () => {
    const { manager, events, advance, getNow } = makeManager({ reNotifyAfterMinutes: 5 });
    manager.ingest(reading(true, 90, getNow()));
    manager.ingest(reading(true, 92, getNow()));
    expect(events).toHaveLength(1);
    advance(2 * 60 * 1000);
    manager.ingest(reading(true, 93, getNow()));
    expect(events).toHaveLength(1); // still within cooldown
    advance(4 * 60 * 1000); // total 6 min since firing
    manager.ingest(reading(true, 95, getNow()));
    expect(events).toHaveLength(2);
    expect(events[1]?.kind).toBe('renotify');
  });

  it('does not re-notify when reNotifyAfterMinutes is 0', () => {
    const { manager, events, advance, getNow } = makeManager({ reNotifyAfterMinutes: 0 });
    manager.ingest(reading(true, 90, getNow()));
    manager.ingest(reading(true, 92, getNow()));
    advance(60 * 60 * 1000);
    manager.ingest(reading(true, 93, getNow()));
    expect(events.map((e) => e.kind)).toEqual(['firing']);
  });

  it('treats different keys independently', () => {
    const { manager, events, getNow } = makeManager();
    manager.ingest({ ...reading(true, 90, getNow()), key: { scope: 'system', metric: 'cpu' } });
    manager.ingest({ ...reading(true, 90, getNow()), key: { scope: 'system', metric: 'memory' } });
    manager.ingest({ ...reading(true, 92, getNow()), key: { scope: 'system', metric: 'cpu' } });
    manager.ingest({ ...reading(true, 92, getNow()), key: { scope: 'system', metric: 'memory' } });
    expect(events).toHaveLength(2);
    expect(events.map((e) => e.key.metric).sort()).toEqual(['cpu', 'memory']);
  });

  it('emits a one-shot event without state tracking', () => {
    const { manager, events } = makeManager();
    manager.emitEvent({
      key: { scope: 'container', subject: 'api', metric: 'state:die' },
      severity: 'critical',
      title: 'Container died: api',
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe('event');
  });

  it('records the incident duration on recovery', () => {
    const { manager, events, advance, getNow } = makeManager();
    manager.ingest(reading(true, 90, getNow()));
    manager.ingest(reading(true, 92, getNow()));
    advance(3 * 60 * 1000);
    manager.ingest(reading(false, 60, getNow()));
    manager.ingest(reading(false, 55, getNow()));
    const recovered = events.find((e) => e.kind === 'recovered');
    expect(recovered?.durationMs).toBe(3 * 60 * 1000);
  });
});
