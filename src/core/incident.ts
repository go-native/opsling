import { nanoid } from 'nanoid';
import type { AlertKey, Severity } from '../types/index.js';

export type IncidentState = 'OK' | 'PENDING' | 'FIRING' | 'PENDING_RECOVERY';

export interface Incident {
  id: string;
  key: AlertKey;
  state: IncidentState;
  /** Consecutive over-threshold readings counted toward firing/recovering. */
  consecutiveOver: number;
  consecutiveUnder: number;
  /** When the incident first transitioned to FIRING. */
  firedAt: Date | null;
  /** Last time we notified about this incident. */
  lastNotifiedAt: Date | null;
  peakValue: number;
  lastValue: number;
  lastThreshold: number;
  lastSeverity: Severity;
  lastDetails?: Record<string, string | number | boolean>;
  lastUnit?: string;
}

export const newIncident = (key: AlertKey): Incident => ({
  id: nanoid(8),
  key,
  state: 'OK',
  consecutiveOver: 0,
  consecutiveUnder: 0,
  firedAt: null,
  lastNotifiedAt: null,
  peakValue: Number.NEGATIVE_INFINITY,
  lastValue: 0,
  lastThreshold: 0,
  lastSeverity: 'warning',
});
