import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { loadConfig } from './config/env.js';
import type { Config } from './config/types.js';
import { printBanner } from './lib/banner.js';
import { createLogger } from './lib/logger.js';
import { ShutdownManager } from './lib/shutdown.js';

const readVersion = (): string => {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkgPath = join(here, '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
};

const loadConfigOrExit = (): Config => {
  try {
    return loadConfig();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`\nConfiguration error:\n${msg}\n\n`);
    process.exit(1);
  }
};

const main = async (): Promise<void> => {
  const version = readVersion();
  printBanner(version);

  const config = loadConfigOrExit();

  const logger = createLogger({
    level: config.logLevel,
    pretty: config.nodeEnv !== 'production',
  });

  const shutdown = new ShutdownManager(logger);
  shutdown.install();

  const app = createApp(config, logger);
  shutdown.register(() => app.stop());

  try {
    await app.start(shutdown.signal);
  } catch (err) {
    logger.error({ err }, 'failed to start');
    await shutdown.shutdown('startup-error', 1);
  }
};

void main();
