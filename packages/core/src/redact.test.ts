import { describe, expect, it } from 'vitest';
import { redactSecrets } from './redact';

describe('redactSecrets', () => {
  it('removes api keys in URLs, Telegram bot tokens, database passwords and x-api-key headers', () => {
    expect(redactSecrets('request to https://mainnet.helius-rpc.com/?api-key=abc123-def failed')).toBe('request to https://mainnet.helius-rpc.com/?api-key=[redacted] failed');
    expect(redactSecrets('https://rpc.example/x?cluster=m&apikey=S3CR3T&z=1')).toBe('https://rpc.example/x?cluster=m&apikey=[redacted]&z=1');
    expect(redactSecrets('POST https://api.telegram.org/bot123456:AAH-xyz_987/sendMessage')).toBe('POST https://api.telegram.org/bot[redacted]/sendMessage');
    expect(redactSecrets('connect postgres://rat:hunter2pass@db.host:5432/rat')).toBe('connect postgres://[redacted]@db.host:5432/rat');
    expect(redactSecrets('{"x-api-key": "jup-secret-1"}')).toBe('{"x-api-key": "[redacted]"}');
    expect(redactSecrets('fetch failed: ECONNREFUSED 127.0.0.1:8899')).toBe('fetch failed: ECONNREFUSED 127.0.0.1:8899');
    expect(redactSecrets('https://solscan.io/tx/5hTx?cluster=devnet')).toBe('https://solscan.io/tx/5hTx?cluster=devnet');
  });
});
