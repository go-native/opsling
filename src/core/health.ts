import http from 'node:http';
import type { Logger } from 'pino';

export interface HealthState {
  collectors: Record<string, { ok: boolean; lastError?: string; lastRunAt?: string }>;
}

export class HealthServer {
  private readonly state: HealthState = { collectors: {} };
  private readonly startedAt = Date.now();
  private server: http.Server | null = null;

  constructor(
    private readonly port: number,
    private readonly logger: Logger,
  ) {}

  setCollector(name: string, ok: boolean, lastError?: string): void {
    this.state.collectors[name] = {
      ok,
      ...(lastError !== undefined ? { lastError } : {}),
      lastRunAt: new Date().toISOString(),
    };
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        if (req.url === '/health') {
          const allOk =
            Object.values(this.state.collectors).every((c) => c.ok) ||
            Object.keys(this.state.collectors).length === 0;
          const body = JSON.stringify({
            status: allOk ? 'ok' : 'degraded',
            uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
            collectors: this.state.collectors,
          });
          res.writeHead(allOk ? 200 : 503, { 'content-type': 'application/json' });
          res.end(body);
          return;
        }
        res.writeHead(404).end();
      });

      server.once('error', reject);
      server.listen(this.port, '0.0.0.0', () => {
        this.server = server;
        this.logger.info({ port: this.port }, 'health server listening');
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
    this.server = null;
  }
}
