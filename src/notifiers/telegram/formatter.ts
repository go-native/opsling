import { formatDuration, formatTimestamp } from '../../lib/time.js';
import type { NotificationEvent, Severity } from '../../types/index.js';

const SEVERITY_EMOJI: Record<Severity, string> = {
  info: '🔵',
  warning: '🟡',
  critical: '🔴',
};

const KIND_PREFIX: Record<NotificationEvent['kind'], string> = {
  firing: '',
  renotify: 'Still firing — ',
  recovered: '✅ Recovered — ',
  event: '',
  heartbeat: '✅ ',
};

// Telegram MarkdownV2 reserved characters that must be escaped.
const MD2_ESCAPE_RE = /[_*\[\]()~`>#+\-=|{}.!\\]/g;
export const escapeMd2 = (s: string): string => s.replace(MD2_ESCAPE_RE, (c) => `\\${c}`);

const labelLine = (label: string, value: string): string =>
  `*${escapeMd2(label)}:* ${escapeMd2(value)}`;

const valueWithUnit = (value: number | undefined, unit: string | undefined): string | undefined => {
  if (value === undefined) return undefined;
  const trimmed = Number.isInteger(value) ? value.toString() : value.toFixed(1);
  return unit ? `${trimmed}${unit}` : trimmed;
};

export const formatMessage = (event: NotificationEvent): string => {
  const emoji = event.kind === 'recovered' ? '✅' : SEVERITY_EMOJI[event.severity];
  const prefix = KIND_PREFIX[event.kind];
  const headline = `${emoji} *${escapeMd2(prefix + event.title)}*`;

  const lines: string[] = [headline];

  if (event.hostname) lines.push(labelLine('host', event.hostname));
  if (event.key.subject) lines.push(labelLine('container', event.key.subject));

  const value = valueWithUnit(event.value, event.unit);
  const threshold = valueWithUnit(event.threshold, event.unit);
  if (
    value !== undefined &&
    threshold !== undefined &&
    event.kind !== 'recovered' &&
    event.kind !== 'event' &&
    event.kind !== 'heartbeat'
  ) {
    lines.push(`*${escapeMd2('value')}:* ${escapeMd2(`${value} (threshold ${threshold})`)}`);
  } else if (value !== undefined && event.kind !== 'event' && event.kind !== 'heartbeat') {
    lines.push(labelLine('value', value));
  }

  if (event.kind === 'recovered' || event.kind === 'renotify') {
    const peak = valueWithUnit(event.peakValue, event.unit);
    if (peak !== undefined) lines.push(labelLine('peak', peak));
    if (event.durationMs !== undefined && event.durationMs > 0) {
      const label = event.kind === 'recovered' ? 'incident lasted' : 'duration';
      lines.push(labelLine(label, formatDuration(event.durationMs)));
    }
  }

  if (event.details) {
    for (const [k, v] of Object.entries(event.details)) {
      if (k === 'container') continue;
      lines.push(labelLine(k, String(v)));
    }
  }

  if (event.message && event.kind === 'event') {
    lines.push('');
    lines.push(`\`${escapeMd2(event.message)}\``);
  }

  lines.push('');
  lines.push(`_${escapeMd2(formatTimestamp(event.timestamp))}_`);

  return lines.join('\n');
};
