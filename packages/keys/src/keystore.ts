// KeyStore backed by the encrypted key table (key_pool). Rat wallets are plain fresh keypairs made at hire time:
// each one is encrypted, stored and read back BEFORE its public key is handed to the hire step, so the key of a
// wallet that receives SOL always exists in the database, even if the worker crashes right after sending.
import type { KeyPoolStore, KeyStore, Pubkey } from '@rat/core';
import { Keypair } from '@solana/web3.js';
import { type MasterKeyRing, decryptSecret, encryptSecret } from './vault';

export interface DbKeyStoreOptions {
  /** If set, the stored creator key must match this public key. */
  expectedCreator?: string;
}

export class DbKeyStore implements KeyStore {
  private readonly cache = new Map<string, Keypair>();

  constructor(
    private readonly pool: KeyPoolStore,
    private readonly ring: MasterKeyRing,
    private readonly opts: DbKeyStoreOptions = {},
  ) {}

  private async load(pubkey: Pubkey): Promise<Keypair> {
    const cached = this.cache.get(pubkey);
    if (cached) return cached;
    const rec = await this.pool.get(pubkey);
    if (!rec) throw new Error(`no stored key for ${pubkey}`);
    const kp = Keypair.fromSecretKey(decryptSecret(rec.secretEnc, this.ring.get(rec.keyVersion), rec.pubkey));
    if (kp.publicKey.toBase58() !== rec.pubkey) throw new Error(`stored key does not match ${rec.pubkey}`);
    this.cache.set(pubkey, kp);
    return kp;
  }

  private async role(role: 'creator', expected?: string): Promise<Keypair> {
    const rec = await this.pool.getRole(role);
    if (!rec) throw new Error(`no ${role} key imported (run: rat keys import --role ${role})`);
    if (expected && rec.pubkey !== expected) {
      throw new Error(`stored ${role} key ${rec.pubkey} does not match configured ${expected}`);
    }
    return this.load(rec.pubkey);
  }

  creator(): Promise<Keypair> {
    return this.role('creator', this.opts.expectedCreator);
  }

  async newRatKey(): Promise<Pubkey> {
    const kp = Keypair.generate();
    const pubkey = kp.publicKey.toBase58();
    await this.pool.insertRatKey({ pubkey, secretEnc: encryptSecret(kp.secretKey, this.ring.current(), pubkey), keyVersion: this.ring.currentVersion, role: 'rat' });
    // Read it back and decrypt it: the wallet is only used if its key provably survives in the database.
    const stored = await this.load(pubkey);
    if (!stored.publicKey.equals(kp.publicKey)) throw new Error(`stored rat key ${pubkey} did not round trip`);
    return pubkey;
  }

  ratSigner(pubkey: Pubkey): Promise<Keypair> {
    return this.load(pubkey);
  }

  async discardRatKey(pubkey: Pubkey): Promise<void> {
    this.cache.delete(pubkey);
    await this.pool.markUnused(pubkey);
  }
}

/** Encrypts the imported creator key. */
export function encryptRoleKey(kp: Keypair, ring: MasterKeyRing, role: 'creator') {
  const pubkey = kp.publicKey.toBase58();
  return { pubkey, secretEnc: encryptSecret(kp.secretKey, ring.current(), pubkey), keyVersion: ring.currentVersion, role };
}
