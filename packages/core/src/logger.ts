// pino logger with secret redaction and bigint support.
import pino, { type DestinationStream, type Logger } from 'pino';

export type { Logger } from 'pino';

/** Field names that must never reach a log line, at any of the first three levels. */
const SECRET_FIELDS = [
  'secret',
  'secretKey',
  'privateKey',
  'secretEnc',
  'keyEncryptionKey',
  'keyEncryptionKeyPrevious',
  'apiKey',
  'botToken',
  'databaseUrl',
  'databaseUrlReadonly',
  'password',
  'authorization',
  'x-api-key',
];

export const REDACT_PATHS = SECRET_FIELDS.flatMap((f) => [f, `*.${f}`, `*.*.${f}`]);

function toLoggable(value: unknown, depth = 0): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (depth > 6 || value === null || typeof value !== 'object') return value;
  if (value instanceof Error || value instanceof Date || value instanceof Uint8Array) return value;
  if (Array.isArray(value)) return value.map((v) => toLoggable(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = toLoggable(v, depth + 1);
  return out;
}

export interface LoggerOptions {
  level?: string;
  name?: string;
  destination?: DestinationStream;
}

export function createLogger(opts: LoggerOptions = {}): Logger {
  return pino(
    {
      name: opts.name ?? 'rat',
      level: opts.level ?? 'info',
      redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
      formatters: {
        log: (obj) => toLoggable(obj) as Record<string, unknown>,
      },
      serializers: { err: pino.stdSerializers.err },
    },
    opts.destination,
  );
}

/** Logger that drops everything (tests). */
export function silentLogger(): Logger {
  return pino({ level: 'silent' });
}
