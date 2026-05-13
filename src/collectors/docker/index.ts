import type { Logger } from 'pino';
import type { Config } from '../../config/types.js';
import type { AlertManager } from '../../core/alert-manager.js';
import type { PollCollector, StreamCollector } from '../types.js';
import { type Docker, createDockerClient } from './client.js';
import { createDockerEventsCollector } from './events.js';
import { createDockerLogsCollector } from './logs.js';

export interface DockerCollectors {
  client: Docker;
  poll: PollCollector[];
  stream: StreamCollector[];
}

export const createDockerCollectors = (
  config: Config,
  alertManager: AlertManager,
  logger: Logger,
): DockerCollectors => {
  const client = createDockerClient();
  return {
    client,
    poll: [],
    stream: [
      createDockerEventsCollector(client, config, alertManager, logger),
      createDockerLogsCollector(client, config, alertManager, logger),
    ],
  };
};
