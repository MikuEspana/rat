// Alerts: Telegram (throttled per key) and console. Alert failures never break the bot.
import { type AlertLevel, type Alerts, type Clock, type Logger, redactSecrets } from '@rat/core';

const ICON: Record<AlertLevel, string> = { info: 'i', warn: '!', critical: '!!!' };

export class ThrottledAlerts implements Alerts {
  private readonly lastSent = new Map<string, number>();

  constructor(
    private readonly sink: (level: AlertLevel, text: string) => Promise<void>,
    private readonly clock: Clock,
    private readonly throttleMs = 10 * 60_000,
  ) {}

  async send(level: AlertLevel, key: string, text: string): Promise<void> {
    const now = this.clock.now().getTime();
    const last = this.lastSent.get(key);
    if (last !== undefined && now - last < this.throttleMs) return;
    this.lastSent.set(key, now);
    // an error text can carry an RPC URL with its api key: never send that to a chat
    await this.sink(level, redactSecrets(text));
  }
}

export function telegramSink(opts: { botToken: string; chatId: string; log?: Logger; fetchImpl?: typeof fetch }) {
  const f = opts.fetchImpl ?? fetch;
  return async (level: AlertLevel, text: string): Promise<void> => {
    try {
      const res = await f(`https://api.telegram.org/bot${opts.botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: opts.chatId, text: `[RAT RACE ${ICON[level]} ${level}] ${text}`, disable_web_page_preview: true }),
      });
      if (!res.ok) opts.log?.warn({ status: res.status }, 'telegram alert failed');
    } catch (err) {
      opts.log?.warn({ err }, 'telegram alert failed');
    }
  };
}

export function logSink(log: Logger) {
  return async (level: AlertLevel, text: string): Promise<void> => {
    const fn = level === 'critical' ? log.error.bind(log) : level === 'warn' ? log.warn.bind(log) : log.info.bind(log);
    fn({ alert: true }, text);
  };
}

export function fanOut(...sinks: ((level: AlertLevel, text: string) => Promise<void>)[]) {
  return async (level: AlertLevel, text: string): Promise<void> => {
    await Promise.all(sinks.map((s) => s(level, text)));
  };
}

/** Collects alerts in memory (tests, simulations). */
export class RecordingAlerts implements Alerts {
  readonly sent: { level: AlertLevel; key: string; text: string }[] = [];
  async send(level: AlertLevel, key: string, text: string): Promise<void> {
    this.sent.push({ level, key, text });
  }
  keys(): string[] {
    return this.sent.map((a) => a.key);
  }
}
