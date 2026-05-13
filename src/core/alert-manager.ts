import type { AlertingConfig } from '../config/types.js';
import {
  type AlertKey,
  type NotificationEvent,
  type Reading,
  keyToString,
} from '../types/index.js';
import { type Incident, newIncident } from './incident.js';

export type Now = () => Date;

export interface AlertManagerOptions {
  config: AlertingConfig;
  hostname: string;
  now?: Now;
}

type Listener = (event: NotificationEvent) => void;

/**
 * State machine per `AlertKey`:
 *
 *   OK ──(over * requireConsecutive)──▶ FIRING ──(emit firing event)
 *   FIRING ──(under * requireConsecutive)──▶ OK    (emit recovered event)
 *   FIRING ──(time since last notify >= reNotifyAfter)──▶ FIRING (emit renotify)
 *
 * Event-style readings (e.g. container died, container restarted) bypass
 * hysteresis: they emit a one-shot 'event' notification and keep no state.
 */
export class AlertManager {
  private readonly incidents = new Map<string, Incident>();
  private readonly listeners = new Set<Listener>();
  private readonly now: Now;

  constructor(private readonly opts: AlertManagerOptions) {
    this.now = opts.now ?? (() => new Date());
  }

  onNotification(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Snapshot of all incidents currently in FIRING or PENDING_RECOVERY state. */
  getActiveIncidents(): Array<{
    key: AlertKey;
    firedAt: Date;
    peakValue: number;
    lastValue: number;
    threshold: number;
    severity: NotificationEvent['severity'];
    unit?: string;
  }> {
    const out: ReturnType<AlertManager['getActiveIncidents']> = [];
    for (const inc of this.incidents.values()) {
      if ((inc.state === 'FIRING' || inc.state === 'PENDING_RECOVERY') && inc.firedAt) {
        out.push({
          key: inc.key,
          firedAt: inc.firedAt,
          peakValue: inc.peakValue,
          lastValue: inc.lastValue,
          threshold: inc.lastThreshold,
          severity: inc.lastSeverity,
          ...(inc.lastUnit !== undefined ? { unit: inc.lastUnit } : {}),
        });
      }
    }
    return out;
  }

  /** Emit a one-shot event notification (no state tracked). */
  emitEvent(event: {
    key: AlertKey;
    severity: NotificationEvent['severity'];
    title: string;
    message?: string;
    details?: Record<string, string | number | boolean>;
  }): void {
    this.dispatch({
      kind: 'event',
      key: event.key,
      severity: event.severity,
      title: event.title,
      ...(event.message !== undefined ? { message: event.message } : {}),
      ...(event.details !== undefined ? { details: event.details } : {}),
      timestamp: this.now(),
      hostname: this.opts.hostname,
    });
  }

  emitHeartbeat(title: string, details?: Record<string, string | number | boolean>): void {
    this.dispatch({
      kind: 'heartbeat',
      key: { scope: 'system', metric: 'heartbeat' },
      severity: 'info',
      title,
      ...(details !== undefined ? { details } : {}),
      timestamp: this.now(),
      hostname: this.opts.hostname,
    });
  }

  /** Feed a threshold-based reading into the state machine. */
  ingest(reading: Reading): void {
    const id = keyToString(reading.key);
    let incident = this.incidents.get(id);
    if (!incident) {
      incident = newIncident(reading.key);
      this.incidents.set(id, incident);
    }

    incident.lastValue = reading.value;
    incident.lastThreshold = reading.threshold;
    incident.lastSeverity = reading.severity;
    if (reading.details !== undefined) incident.lastDetails = reading.details;
    if (reading.unit !== undefined) incident.lastUnit = reading.unit;

    if (reading.over) {
      incident.consecutiveOver += 1;
      incident.consecutiveUnder = 0;
      incident.peakValue = Math.max(incident.peakValue, reading.value);
    } else {
      incident.consecutiveUnder += 1;
      incident.consecutiveOver = 0;
    }

    const need = Math.max(1, this.opts.config.requireConsecutive);

    switch (incident.state) {
      case 'OK':
        if (reading.over) {
          incident.state = 'PENDING';
        }
        if (incident.state === 'PENDING' && incident.consecutiveOver >= need) {
          this.fire(incident, reading);
        }
        break;
      case 'PENDING':
        if (!reading.over) {
          incident.state = 'OK';
          incident.consecutiveOver = 0;
          incident.peakValue = Number.NEGATIVE_INFINITY;
        } else if (incident.consecutiveOver >= need) {
          this.fire(incident, reading);
        }
        break;
      case 'FIRING':
        if (!reading.over) {
          incident.state = 'PENDING_RECOVERY';
        } else {
          this.maybeRenotify(incident, reading);
        }
        break;
      case 'PENDING_RECOVERY':
        if (reading.over) {
          incident.state = 'FIRING';
          incident.consecutiveUnder = 0;
          this.maybeRenotify(incident, reading);
        } else if (incident.consecutiveUnder >= need) {
          this.recover(incident, reading);
        }
        break;
    }
  }

  private fire(incident: Incident, reading: Reading): void {
    incident.state = 'FIRING';
    incident.firedAt = reading.timestamp;
    incident.lastNotifiedAt = reading.timestamp;
    this.dispatch({
      kind: 'firing',
      key: incident.key,
      severity: reading.severity,
      title: reading.message ?? 'Threshold exceeded',
      value: reading.value,
      threshold: reading.threshold,
      ...(reading.unit !== undefined ? { unit: reading.unit } : {}),
      ...(reading.details !== undefined ? { details: reading.details } : {}),
      timestamp: reading.timestamp,
      hostname: this.opts.hostname,
    });
  }

  private maybeRenotify(incident: Incident, reading: Reading): void {
    const minutes = this.opts.config.reNotifyAfterMinutes;
    if (minutes <= 0 || !incident.lastNotifiedAt) return;
    const sinceMs = reading.timestamp.getTime() - incident.lastNotifiedAt.getTime();
    if (sinceMs < minutes * 60_000) return;
    incident.lastNotifiedAt = reading.timestamp;
    this.dispatch({
      kind: 'renotify',
      key: incident.key,
      severity: reading.severity,
      title: reading.message ?? 'Still firing',
      value: reading.value,
      threshold: reading.threshold,
      ...(reading.unit !== undefined ? { unit: reading.unit } : {}),
      peakValue: incident.peakValue,
      durationMs: incident.firedAt ? reading.timestamp.getTime() - incident.firedAt.getTime() : 0,
      ...(reading.details !== undefined ? { details: reading.details } : {}),
      timestamp: reading.timestamp,
      hostname: this.opts.hostname,
    });
  }

  private recover(incident: Incident, reading: Reading): void {
    const firedAt = incident.firedAt;
    const peak =
      incident.peakValue === Number.NEGATIVE_INFINITY ? reading.value : incident.peakValue;
    incident.state = 'OK';
    incident.consecutiveOver = 0;
    incident.consecutiveUnder = 0;
    incident.firedAt = null;
    incident.lastNotifiedAt = null;
    incident.peakValue = Number.NEGATIVE_INFINITY;

    if (!this.opts.config.sendRecovery) return;

    this.dispatch({
      kind: 'recovered',
      key: incident.key,
      severity: 'info',
      title: reading.message ?? 'Recovered',
      value: reading.value,
      threshold: reading.threshold,
      ...(reading.unit !== undefined ? { unit: reading.unit } : {}),
      peakValue: peak,
      durationMs: firedAt ? reading.timestamp.getTime() - firedAt.getTime() : 0,
      ...(reading.details !== undefined ? { details: reading.details } : {}),
      timestamp: reading.timestamp,
      hostname: this.opts.hostname,
    });
  }

  private dispatch(event: NotificationEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // listeners are expected to handle their own errors
      }
    }
  }
}
