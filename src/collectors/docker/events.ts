import type { IncomingMessage } from 'node:http';
import type { Logger } from 'pino';
import type { Config } from '../../config/types.js';
import type { AlertManager } from '../../core/alert-manager.js';
import type { Severity } from '../../types/index.js';
import type { StreamCollector } from '../types.js';
import type { Docker } from './client.js';
import { isContainerWatched } from './watchlist.js';

interface DockerEvent {
  Type?: string;
  Action?: string;
  status?: string;
  id?: string;
  from?: string;
  Actor?: {
    ID?: string;
    Attributes?: Record<string, string>;
  };
  time?: number;
}

const ACTIONS_OF_INTEREST: Record<string, { severity: Severity; title: string }> = {
  start: { severity: 'info', title: 'Container started' },
  stop: { severity: 'warning', title: 'Container stopped' },
  die: { severity: 'critical', title: 'Container died' },
  oom: { severity: 'critical', title: 'Container OOM-killed' },
  kill: { severity: 'warning', title: 'Container killed' },
  restart: { severity: 'warning', title: 'Container restarted' },
};

const containerName = (event: DockerEvent): string =>
  event.Actor?.Attributes?.name ?? event.from ?? event.id?.slice(0, 12) ?? 'unknown';

export const createDockerEventsCollector = (
  docker: Docker,
  config: Config,
  alertManager: AlertManager,
  logger: Logger,
): StreamCollector => {
  let stream: IncomingMessage | null = null;
  let stopped = false;

  const connect = async (signal: AbortSignal): Promise<void> => {
    if (stopped) return;
    try {
      stream = (await docker.getEvents({
        filters: JSON.stringify({ type: ['container'] }),
      })) as IncomingMessage;
    } catch (err) {
      logger.error({ err }, 'docker events: failed to subscribe');
      schedule(signal);
      return;
    }

    let buf = '';
    stream.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf8');
      let nl = buf.indexOf('\n');
      while (nl !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        nl = buf.indexOf('\n');
        if (!line) continue;
        try {
          handleEvent(JSON.parse(line));
        } catch (err) {
          logger.warn({ err, line }, 'docker events: parse failure');
        }
      }
    });
    stream.on('error', (err) => {
      logger.warn({ err }, 'docker events: stream error');
    });
    stream.on('end', () => {
      logger.warn('docker events: stream ended');
      schedule(signal);
    });
    stream.on('close', () => {
      logger.warn('docker events: stream closed');
      schedule(signal);
    });
  };

  const handleEvent = (event: DockerEvent): void => {
    const action = event.Action ?? event.status;
    if (!action) return;
    const meta = ACTIONS_OF_INTEREST[action];
    if (!meta) return;

    const name = containerName(event);
    if (!isContainerWatched(name, config)) return;

    const attrs = event.Actor?.Attributes ?? {};
    const exitCode = attrs.exitCode ? Number(attrs.exitCode) : undefined;
    const details: Record<string, string | number | boolean> = {
      container: name,
      action,
      ...(attrs.image ? { image: attrs.image } : {}),
      ...(exitCode !== undefined ? { exitCode } : {}),
    };

    // Special-case OOM kill detection: docker emits `die` with exitCode=137 separately.
    const severity = exitCode === 137 && action === 'die' ? 'critical' : meta.severity;

    alertManager.emitEvent({
      key: { scope: 'container', subject: name, metric: `state:${action}` },
      severity,
      title: `${meta.title}: ${name}`,
      details,
    });
  };

  let reconnectTimer: NodeJS.Timeout | null = null;
  const schedule = (signal: AbortSignal): void => {
    if (stopped || signal.aborted) return;
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void connect(signal);
    }, 3000);
  };

  return {
    name: 'docker.events',
    async start(signal: AbortSignal): Promise<void> {
      await connect(signal);
    },
    stop(): void {
      stopped = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      stream?.destroy();
    },
  };
};
