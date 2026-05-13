import { NotifierError } from '../../lib/errors.js';

const TELEGRAM_API = 'https://api.telegram.org';

export interface TelegramClientOptions {
  botToken: string;
  chatId: string;
}

export class TelegramClient {
  constructor(private readonly opts: TelegramClientOptions) {}

  async sendMessage(text: string, opts: { silent?: boolean } = {}): Promise<void> {
    const url = `${TELEGRAM_API}/bot${this.opts.botToken}/sendMessage`;
    const body = {
      chat_id: this.opts.chatId,
      text,
      parse_mode: 'MarkdownV2',
      disable_web_page_preview: true,
      disable_notification: opts.silent ?? false,
    };
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new NotifierError('telegram', `HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
  }
}
