import type { Readable } from 'node:stream';
import type { Logger } from 'pino';
import type { Config } from '../../config/types.js';
import type { AlertManager } from '../../core/alert-manager.js';
import type { StreamCollector } from '../types.js';
import type { Docker } from './client.js';
import { type Pattern, RollingCounter, compilePatterns } from './log-matcher.js';
import { isContainerWatched } from './watchlist.js';

interface ContainerTail {
  name: string;
  stream: Readable;
  counter: RollingCounter;
  cooldownUntil: number;
  lastSample: string;
}

const COOLDOWN_MS = 5 * 60 * 1000;

/**
 * Demultiplex docker's log stream framing.
 * Each frame: [streamType(1)][padding(3)][size(4 BE)][payload]
 */
const parseLogFrame = (buf: Buffer, onLine: (line: string) => void, residual: Buffer): Buffer => {
  let work: Buffer = Buffer.concat([residual, buf]);
  while (work.length >= 8) {
    const size = work.readUInt32BE(4);
    if (work.length < 8 + size) break;
    const payload = work.subarray(8, 8 + size).toString('utf8');
    work = Buffer.from(work.subarray(8 + size));
    for (const line of payload.split('\n')) {
      if (line.length > 0) onLine(line);
    }
  }
  return Buffer.from(work);
};

export const createDockerLogsCollector = (
  docker: Docker,
  config: Config,
  alertManager: AlertManager,
  logger: Logger,
): StreamCollector => {
  const tails = new Map<string, ContainerTail>();
  let stopped = false;
  let pollTimer: NodeJS.Timeout | null = null;
  const errorPatterns: Pattern[] = compilePatterns(config.logScan.errorPatterns);
  const ignorePatterns: Pattern[] = compilePatterns(config.logScan.ignorePatterns);
  const windowMs = config.logScan.windowSeconds * 1000;

  const onLine = (name: string, tail: ContainerTail, line: string): void => {
    if (ignorePatterns.some((p) => p.test(line))) return;
    if (!errorPatterns.some((p) => p.test(line))) return;
    const now = Date.now();
    if (now < tail.cooldownUntil) {
      tail.counter.add(now);
      return;
    }
    tail.lastSample = line.slice(0, 300);
    const count = tail.counter.add(now);
    if (count >= config.logScan.minOccurrences) {
      alertManager.emitEvent({
        key: { scope: 'container', subject: name, metric: 'logs' },
        severity: 'critical',
        title: `Errors in logs — ${name}`,
        message: tail.lastSample,
        details: {
          container: name,
          matches: count,
          windowSeconds: config.logScan.windowSeconds,
        },
      });
      tail.counter.reset();
      tail.cooldownUntil = now + COOLDOWN_MS;
    }
  };

  const attach = async (name: string, id: string): Promise<void> => {
    if (tails.has(name)) return;
    try {
      const container = docker.getContainer(id);
      const stream = (await container.logs({
        follow: true,
        stdout: true,
        stderr: true,
        tail: 0,
        timestamps: false,
      })) as unknown as Readable;

      const tail: ContainerTail = {
        name,
        stream,
        counter: new RollingCounter(windowMs),
        cooldownUntil: 0,
        lastSample: '',
      };
      tails.set(name, tail);

      let residual: Buffer = Buffer.from([]);
      stream.on('data', (chunk: Buffer) => {
        residual = parseLogFrame(chunk, (line) => onLine(name, tail, line), residual);
      });
      stream.on('error', (err) => {
        logger.warn({ err, container: name }, 'log tail: stream error');
      });
      const cleanup = () => {
        tails.delete(name);
      };
      stream.on('end', cleanup);
      stream.on('close', cleanup);
      logger.info({ container: name }, 'log tail: attached');
    } catch (err) {
      logger.warn({ err, container: name }, 'log tail: failed to attach');
    }
  };

  const detach = (name: string): void => {
    const tail = tails.get(name);
    if (!tail) return;
    tail.stream.destroy();
    tails.delete(name);
  };

  const reconcile = async (): Promise<void> => {
    if (stopped) return;
    try {
      const containers = await docker.listContainers({ filters: { status: ['running'] } });
      const live = new Set<string>();
      for (const info of containers) {
        const name = info.Names[0]?.replace(/^\//, '') ?? info.Id.slice(0, 12);
        if (!isContainerWatched(name, config)) continue;
        live.add(name);
        await attach(name, info.Id);
      }
      for (const name of tails.keys()) {
        if (!live.has(name)) detach(name);
      }
    } catch (err) {
      logger.warn({ err }, 'log tail: reconcile failed');
    }
  };

  return {
    name: 'docker.logs',
    async start(signal: AbortSignal): Promise<void> {
      await reconcile();
      pollTimer = setInterval(() => void reconcile(), 15_000);
      signal.addEventListener(
        'abort',
        () => {
          this.stop();
        },
        { once: true },
      );
    },
    stop(): void {
      stopped = true;
      if (pollTimer) clearInterval(pollTimer);
      for (const tail of tails.values()) tail.stream.destroy();
      tails.clear();
    },
  };
};
