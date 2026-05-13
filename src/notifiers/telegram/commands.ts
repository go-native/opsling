import type { Logger } from 'pino';
import type { Docker } from '../../collectors/docker/client.js';
import type { PollCollector } from '../../collectors/types.js';
import type { AlertManager } from '../../core/alert-manager.js';
import { formatDuration, formatTimestamp } from '../../lib/time.js';
import type { Reading } from '../../types/index.js';
import type { TelegramClient } from './client.js';
import { escapeMd2 } from './formatter.js';

interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    chat: { id: number; type: string };
    text?: string;
    from?: { id: number; username?: string };
  };
}

interface ContainerSnapshot {
  name: string;
  state: string;
  status: string;
}

export interface TelegramCommandsOptions {
  client: TelegramClient;
  botToken: string;
  chatId: string;
  hostnameLabel: string;
  docker: Docker;
  systemCollectors: PollCollector[];
  alertManager: AlertManager;
  logger: Logger;
}

const TELEGRAM_API = 'https://api.telegram.org';

const STATE_EMOJI: Record<string, string> = {
  running: '🟢',
  paused: '⏸️',
  exited: '🔴',
  restarting: '🔄',
  dead: '💀',
  created: '⚪',
};

const SEVERITY_EMOJI = {
  info: '🔵',
  warning: '🟡',
  critical: '🔴',
};

const COMMANDS = [
  { command: 'status', description: 'Show system + container status' },
  { command: 'help', description: 'Show available commands' },
];

export class TelegramCommands {
  private offset = 0;
  private stopped = false;
  private readonly controller = new AbortController();

  constructor(private readonly opts: TelegramCommandsOptions) {}

  async start(parentSignal: AbortSignal): Promise<void> {
    parentSignal.addEventListener('abort', () => this.stop(), { once: true });
    await this.registerCommands();
    await this.skipBacklog();
    void this.loop();
    this.opts.logger.info('telegram commands: listening');
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.controller.abort();
  }

  /** Set the bot's slash-command menu so they show in the Telegram UI. */
  private async registerCommands(): Promise<void> {
    try {
      const res = await fetch(`${TELEGRAM_API}/bot${this.opts.botToken}/setMyCommands`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ commands: COMMANDS }),
      });
      if (!res.ok) {
        this.opts.logger.warn({ status: res.status }, 'telegram commands: setMyCommands failed');
      }
    } catch (err) {
      this.opts.logger.warn({ err }, 'telegram commands: setMyCommands threw');
    }
  }

  /** Drop any pending updates that arrived while opsling was down. */
  private async skipBacklog(): Promise<void> {
    try {
      const url = `${TELEGRAM_API}/bot${this.opts.botToken}/getUpdates?offset=-1&timeout=0`;
      const res = await fetch(url, { signal: this.controller.signal });
      if (!res.ok) return;
      const data = (await res.json()) as { result?: TelegramUpdate[] };
      const last = data.result?.[data.result.length - 1];
      if (last) this.offset = last.update_id + 1;
    } catch (err) {
      this.opts.logger.warn({ err }, 'telegram commands: skipBacklog failed');
    }
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      try {
        const updates = await this.poll();
        for (const update of updates) {
          if (update.update_id >= this.offset) {
            this.offset = update.update_id + 1;
          }
          this.handle(update).catch((err) =>
            this.opts.logger.warn({ err }, 'telegram command handler failed'),
          );
        }
      } catch (err) {
        if (this.stopped) return;
        this.opts.logger.warn({ err }, 'telegram commands: getUpdates failed');
        await this.sleep(3000);
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(resolve, ms);
      this.controller.signal.addEventListener('abort', () => {
        clearTimeout(t);
        resolve();
      });
    });
  }

  private async poll(): Promise<TelegramUpdate[]> {
    const params = new URLSearchParams({
      timeout: '25',
      offset: String(this.offset),
      allowed_updates: '["message"]',
    });
    const url = `${TELEGRAM_API}/bot${this.opts.botToken}/getUpdates?${params}`;
    const res = await fetch(url, { signal: this.controller.signal });
    if (!res.ok) throw new Error(`getUpdates HTTP ${res.status}`);
    const data = (await res.json()) as { ok: boolean; result?: TelegramUpdate[] };
    return data.result ?? [];
  }

  private async handle(update: TelegramUpdate): Promise<void> {
    const msg = update.message;
    if (!msg?.text) return;

    // Only respond to messages from the configured chat.
    if (String(msg.chat.id) !== String(this.opts.chatId)) {
      this.opts.logger.warn(
        { chatId: msg.chat.id, from: msg.from?.username },
        'telegram commands: unauthorized chat — ignoring',
      );
      return;
    }

    const first = msg.text.trim().split(/\s+/)[0] ?? '';
    const cmd = first.split('@')[0]?.toLowerCase();

    switch (cmd) {
      case '/status':
        await this.handleStatus();
        break;
      case '/help':
      case '/start':
        await this.handleHelp();
        break;
      default:
        if (cmd?.startsWith('/')) {
          await this.safeSend('Unknown command\\. Try /status or /help\\.');
        }
    }
  }

  private async handleHelp(): Promise<void> {
    const lines = [
      '*Opsling commands*',
      ...COMMANDS.map((c) => `• /${c.command} — ${escapeMd2(c.description)}`),
    ];
    await this.safeSend(lines.join('\n'));
  }

  private async handleStatus(): Promise<void> {
    const [systemReadings, containers] = await Promise.all([
      this.collectSystem(),
      this.collectContainers(),
    ]);
    const incidents = this.opts.alertManager.getActiveIncidents();
    const text = this.formatStatus(systemReadings, containers, incidents);
    await this.safeSend(text);
  }

  private async collectSystem(): Promise<Reading[]> {
    const readings: Reading[] = [];
    for (const collector of this.opts.systemCollectors) {
      try {
        const r = await collector.collect(this.controller.signal);
        readings.push(...r);
      } catch (err) {
        this.opts.logger.warn({ err, collector: collector.name }, 'status: collector failed');
      }
    }
    return readings;
  }

  private async collectContainers(): Promise<ContainerSnapshot[]> {
    try {
      const list = await this.opts.docker.listContainers({ all: false });
      // /status shows everything actually running, including Opsling itself.
      // The WATCH/IGNORE config governs alerting, not visibility.
      return list
        .map((c) => ({
          name: c.Names[0]?.replace(/^\//, '') ?? c.Id.slice(0, 12),
          state: c.State ?? 'unknown',
          status: c.Status ?? '',
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
    } catch (err) {
      this.opts.logger.warn({ err }, 'status: failed to list containers');
      return [];
    }
  }

  private formatStatus(
    system: Reading[],
    containers: ContainerSnapshot[],
    incidents: ReturnType<AlertManager['getActiveIncidents']>,
  ): string {
    const fmtVal = (r: Reading) => {
      const v = Number.isInteger(r.value) ? String(r.value) : r.value.toFixed(1);
      const unit = r.unit ?? '';
      const over = r.over ? ' ⚠️' : '';
      return `${v}${unit}${over}`;
    };

    const findReading = (metric: string): Reading | undefined =>
      system.find((r) => r.key.metric === metric);
    const cpu = findReading('cpu');
    const memory = findReading('memory');
    const load = findReading('load');
    const disks = system.filter((r) => r.key.metric.startsWith('disk:'));

    const lines: string[] = [];
    lines.push(`📊 *Opsling status — ${escapeMd2(this.opts.hostnameLabel)}*`);
    lines.push('');
    lines.push('🖥️ *System*');
    if (cpu) lines.push(`🧠 CPU: ${escapeMd2(fmtVal(cpu))}`);
    if (memory) lines.push(`🧮 Memory: ${escapeMd2(fmtVal(memory))}`);
    if (load) lines.push(`⚖️ Load: ${escapeMd2(fmtVal(load))}`);
    for (const d of disks) {
      const mount = d.key.metric.slice('disk:'.length);
      lines.push(`💾 Disk ${escapeMd2(mount)}: ${escapeMd2(fmtVal(d))}`);
    }

    lines.push('');
    if (containers.length === 0) {
      lines.push('📦 *Containers*');
      lines.push('_No containers are running on this host\\._');
    } else {
      lines.push(`📦 *Containers* \\(${containers.length} running\\)`);
      for (const c of containers) {
        const emoji = STATE_EMOJI[c.state] ?? '⚪';
        lines.push(`${emoji} ${escapeMd2(c.name)}`);
      }
    }

    lines.push('');
    if (incidents.length === 0) {
      lines.push('✅ *No active incidents\\.*');
    } else {
      lines.push(`🚨 *Active incidents* \\(${incidents.length}\\)`);
      const now = Date.now();
      for (const inc of incidents) {
        const emoji = SEVERITY_EMOJI[inc.severity];
        const subject = inc.key.subject ?? '';
        const label = subject
          ? `${inc.key.scope}:${subject}:${inc.key.metric}`
          : `${inc.key.scope}:${inc.key.metric}`;
        const dur = formatDuration(now - inc.firedAt.getTime());
        const unit = inc.unit ?? '';
        lines.push(
          `${emoji} ${escapeMd2(label)} \\(${escapeMd2(`${inc.lastValue}${unit}`)} / threshold ${escapeMd2(`${inc.threshold}${unit}`)}, firing ${escapeMd2(dur)}\\)`,
        );
      }
    }

    lines.push('');
    lines.push(`_${escapeMd2(formatTimestamp())}_`);

    return lines.join('\n');
  }

  private async safeSend(text: string): Promise<void> {
    try {
      await this.opts.client.sendMessage(text);
    } catch (err) {
      this.opts.logger.warn({ err }, 'telegram commands: reply failed');
    }
  }
}
