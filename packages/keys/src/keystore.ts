// KeyStore backed by the encrypted key_pool table.
import type { KeyPoolStore, KeyStore, Pubkey } from '@rat/core';
import { Keypair } from '@solana/web3.js';
import { type MasterKeyRing, decryptSecret, encryptSecret } from './vault';

export interface DbKeyStoreOptions {
  /** If set, the stored creator key must match this public key. */
  expectedCreator?: string;
  expectedFund?: string;
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

  private async role(role: 'creator' | 'fund', expected?: string): Promise<Keypair> {
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

  fund(): Promise<Keypair> {
    return this.role('fund', this.opts.expectedFund);
  }

  takeRatKey(): Promise<Pubkey | null> {
    return this.pool.takeAvailableRat();
  }

  ratSigner(pubkey: Pubkey): Promise<Keypair> {
    return this.load(pubkey);
  }

  async releaseRatKey(pubkey: Pubkey): Promise<void> {
    this.cache.delete(pubkey);
    await this.pool.release(pubkey);
  }

  availableRatKeys(): Promise<number> {
    return this.pool.countAvailableRats();
  }
}

/** Encrypts and stores keypairs as rat keys. Returns how many were inserted. */
export async function storeRatKeys(pool: KeyPoolStore, ring: MasterKeyRing, keys: Keypair[]): Promise<number> {
  const records = keys.map((kp) => {
    const pubkey = kp.publicKey.toBase58();
    return { pubkey, secretEnc: encryptSecret(kp.secretKey, ring.current(), pubkey), keyVersion: ring.currentVersion, role: 'rat' as const };
  });
  return pool.insertMany(records);
}

/** Encrypts an imported creator or fund key. */
export function encryptRoleKey(kp: Keypair, ring: MasterKeyRing, role: 'creator' | 'fund') {
  const pubkey = kp.publicKey.toBase58();
  return { pubkey, secretEnc: encryptSecret(kp.secretKey, ring.current(), pubkey), keyVersion: ring.currentVersion, role };
}
