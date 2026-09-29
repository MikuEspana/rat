// Parses a private key as exported by wallets: base58 (Phantom/Solflare) or a JSON array (solana-keygen).
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';

export function parseSecretKey(input: string): Keypair {
  const text = input.trim();
  let bytes: Uint8Array;
  if (text.startsWith('[')) {
    let arr: unknown;
    try {
      arr = JSON.parse(text);
    } catch {
      // never the parser's message: it quotes the text around the bad character, which is part of the key
      throw new Error('secret key JSON is not valid');
    }
    if (!Array.isArray(arr) || arr.some((n) => typeof n !== 'number' || n < 0 || n > 255)) {
      throw new Error('secret key JSON must be an array of bytes');
    }
    bytes = Uint8Array.from(arr as number[]);
  } else {
    bytes = bs58.decode(text);
  }
  if (bytes.length !== 64) throw new Error(`secret key must be 64 bytes, got ${bytes.length}`);
  return Keypair.fromSecretKey(bytes);
}
