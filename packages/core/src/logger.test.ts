import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createLogger } from './logger';

function capture() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      lines.push(chunk.toString());
      cb();
    },
  });
  return { lines, stream };
}

describe('logger', () => {
  it('redacts secrets at several depths and serializes bigint', () => {
    const { lines, stream } = capture();
    const log = createLogger({ destination: stream, level: 'info' });
    log.info(
      {
        secretKey: 'TOP-SECRET-1',
        keyEncryptionKey: 'TOP-SECRET-2',
        wallet: { privateKey: 'TOP-SECRET-3', secretEnc: 'TOP-SECRET-4' },
        config: { jupiter: { apiKey: 'TOP-SECRET-5' }, telegram: { botToken: 'TOP-SECRET-6' } },
        amount: 30_000_000n,
      },
      'hello',
    );
    const out = lines.join('');
    for (let i = 1; i <= 6; i++) expect(out).not.toContain(`TOP-SECRET-${i}`);
    expect(out).toContain('[REDACTED]');
    expect(out).toContain('"amount":"30000000"');
  });
});
