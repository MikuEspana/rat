// AES-256-GCM encryption for private keys at rest.
// Stored format: base64(iv[12] | tag[16] | ciphertext). The public key is bound as AAD, so a
// ciphertext copied onto another row fails to decrypt.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const IV_BYTES = 12;
const TAG_BYTES = 16;

export function parseMasterKey(base64: string): Buffer {
  const key = Buffer.from(base64, 'base64');
  if (key.length !== 32) throw new Error('master key must be 32 bytes (base64)');
  return key;
}

export function encryptSecret(secret: Uint8Array, masterKey: Buffer, pubkey: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', masterKey, iv);
  cipher.setAAD(Buffer.from(pubkey, 'utf8'));
  const ct = Buffer.concat([cipher.update(secret), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]).toString('base64');
}

export function decryptSecret(encoded: string, masterKey: Buffer, pubkey: string): Uint8Array {
  const buf = Buffer.from(encoded, 'base64');
  if (buf.length <= IV_BYTES + TAG_BYTES) throw new Error('ciphertext too short');
  const iv = buf.subarray(0, IV_BYTES);
  const tag = buf.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ct = buf.subarray(IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', masterKey, iv);
  decipher.setAAD(Buffer.from(pubkey, 'utf8'));
  decipher.setAuthTag(tag);
  const out = Buffer.concat([decipher.update(ct), decipher.final()]);
  return new Uint8Array(out);
}

/** Master keys by version, so old rows stay readable during a rotation. */
export class MasterKeyRing {
  private readonly keys = new Map<number, Buffer>();
  constructor(
    current: { version: number; base64: string },
    previous: { version: number; base64: string }[] = [],
  ) {
    this.currentVersion = current.version;
    this.keys.set(current.version, parseMasterKey(current.base64));
    for (const p of previous) this.keys.set(p.version, parseMasterKey(p.base64));
  }
  readonly currentVersion: number;

  current(): Buffer {
    return this.keys.get(this.currentVersion)!;
  }

  get(version: number): Buffer {
    const k = this.keys.get(version);
    if (!k) throw new Error(`no master key for version ${version}`);
    return k;
  }
}

/**
 * The master key ring from the settings: KEY_ENCRYPTION_KEY / KEY_VERSION, plus the previous key while a rotation
 * is under way (KEY_ENCRYPTION_KEY_PREVIOUS / KEY_VERSION_PREVIOUS). The worker and the CLI both use this, so the
 * running worker keeps reading its keys in the middle of a rotation.
 */
export function masterKeyRing(cfg: { keyVersion: number; keyEncryptionKey?: string; keyVersionPrevious?: number; keyEncryptionKeyPrevious?: string }): MasterKeyRing {
  if (!cfg.keyEncryptionKey) throw new Error('KEY_ENCRYPTION_KEY is not set');
  const previous = cfg.keyEncryptionKeyPrevious && cfg.keyVersionPrevious ? [{ version: cfg.keyVersionPrevious, base64: cfg.keyEncryptionKeyPrevious }] : [];
  return new MasterKeyRing({ version: cfg.keyVersion, base64: cfg.keyEncryptionKey }, previous);
}
