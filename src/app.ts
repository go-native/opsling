import type { Logger } from 'pino';
import { createDockerCollectors } from './collectors/docker/index.js';
import { createSystemCollectors } from './collectors/system/index.js';
import type { PollCollector, StreamCollector } from './collectors/types.js';
import type { Config } from './config/types.js';
import { AlertManager } from './core/alert-manager.js';
import { HealthServer } from './core/health.js';
import { type Job, Scheduler } from './core/scheduler.js';
import { NotifierRegistry } from './notifiers/index.js';
import { TelegramClient } from './notifiers/telegram/client.js';
import { TelegramCommands } from './notifiers/telegram/commands.js';
import { type TelegramNotifier, createTelegramNotifier } from './notifiers/telegram/index.js';

export interface App {
  start(signal: AbortSignal): Promise<void>;
  stop(): Promise<void>;
}

const toJob = (
  collector: PollCollector,
  alertManager: AlertManager,
  health: HealthServer,
  logger: Logger,
): Job => ({
  name: collector.name,
  intervalMs: collector.intervalMs,
  async run(signal: AbortSignal) {
    try {
      const readings = await collector.collect(signal);
      for (const r of readings) alertManager.ingest(r);
      health.setCollector(collector.name, true);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err, collector: collector.name }, 'collector failed');
      health.setCollector(collector.name, false, msg);
    }
  },
});

const scheduleHeartbeat = (
  config: Config,
  alertManager: AlertManager,
  logger: Logger,
  signal: AbortSignal,
  describeState: () => { containers: number },
): void => {
  const at = config.alerting.dailyHeartbeatAt;
  if (!at) return;

  const [hStr, mStr] = at.split(':') as [string, string];
  const targetH = Number(hStr);
  const targetM = Number(mStr);

  const scheduleNext = () => {
    if (signal.aborted) return;
    const now = new Date();
    const next = new Date(now);
    next.setHours(targetH, targetM, 0, 0);
    if (next.getTime() <= now.getTime()) {
      next.setDate(next.getDate() + 1);
    }
    const delay = next.getTime() - now.getTime();
    logger.info({ nextAt: next.toISOString() }, 'heartbeat scheduled');
    const timer = setTimeout(() => {
      const { containers } = describeState();
      alertManager.emitHeartbeat('Opsling alive', {
        containers,
        host: config.hostnameLabel,
      });
      scheduleNext();
    }, delay);
    signal.addEventListener('abort', () => clearTimeout(timer), { once: true });
  };

  scheduleNext();
};

export const createApp = (config: Config, logger: Logger): App => {
  const alertManager = new AlertManager({
    config: config.alerting,
    hostname: config.hostnameLabel,
  });
  const health = new HealthServer(config.httpPort, logger);
  const notifiers = new NotifierRegistry(logger);
  const telegram: TelegramNotifier = createTelegramNotifier(config.telegram, logger);
  notifiers.register(telegram);

  alertManager.onNotification((event) => {
    logger.info(
      {
        kind: event.kind,
        key: event.key,
        severity: event.severity,
        value: event.value,
        threshold: event.threshold,
      },
      'notification',
    );
    notifiers.dispatch(event);
  });

  const systemCollectors = createSystemCollectors(config);
  const docker = createDockerCollectors(config, alertManager, logger);

  const commandsClient = new TelegramClient(config.telegram);
  const commands = new TelegramCommands({
    client: commandsClient,
    botToken: config.telegram.botToken,
    chatId: config.telegram.chatId,
    hostnameLabel: config.hostnameLabel,
    docker: docker.client,
    systemCollectors,
    alertManager,
    logger,
  });

  let scheduler: Scheduler | null = null;
  let started = false;

  return {
    async start(signal: AbortSignal) {
      if (started) return;
      started = true;
      await health.start();

      scheduler = new Scheduler(logger, signal);
      const jobs: Job[] = [
        ...systemCollectors.map((c) => toJob(c, alertManager, health, logger)),
        ...docker.poll.map((c) => toJob(c, alertManager, health, logger)),
      ];
      scheduler.start(jobs);

      for (const stream of docker.stream as StreamCollector[]) {
        try {
          await stream.start(signal);
          health.setCollector(stream.name, true);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.error({ err, stream: stream.name }, 'stream collector failed to start');
          health.setCollector(stream.name, false, msg);
        }
      }

      try {
        await commands.start(signal);
        health.setCollector('telegram.commands', true);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error({ err }, 'telegram commands failed to start');
        health.setCollector('telegram.commands', false, msg);
      }

      scheduleHeartbeat(config, alertManager, logger, signal, () => ({
        containers: 0,
      }));

      logger.info(
        {
          host: config.hostnameLabel,
          ignore: config.ignoreContainers,
        },
        'opsling running',
      );
    },
    async stop() {
      commands.stop();
      scheduler?.stop();
      for (const stream of docker.stream) {
        try {
          await stream.stop();
        } catch (err) {
          logger.warn({ err, stream: stream.name }, 'stream stop failed');
        }
      }
      await telegram.drain();
      await health.stop();
    },
  };
};
