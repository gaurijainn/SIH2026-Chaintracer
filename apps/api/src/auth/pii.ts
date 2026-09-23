import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { PiiDecryptionError } from './errors';

/** AAD context binding an encrypted value to the Case.firNumber column (the one person-linked field the schema stores). */
export const FIR_PII_CONTEXT = 'Case.firNumber';

/** Context for the FIR reference inside a stored evidence report payload (distinct from the Case column). */
export const REPORT_FIR_PII_CONTEXT = 'Report.payload.case.firNumber';

const PREFIX = 'enc:v1:';
const b64 = (b: Buffer) => b.toString('base64url');

/**
 * AES-256-GCM application-layer encryption for person-linked fields. Envelope format (a plain string so
 * it fits the existing text columns, no schema change):
 *
 *     enc:v1:<iv>:<authTag>:<ciphertext>      (each part base64url)
 *
 * A fresh random 96-bit IV is used per value. `context` (e.g. "Case.firNumber") is bound in as GCM
 * additional authenticated data, so a ciphertext copied into a different field fails authentication.
 * A wrong key, a tampered envelope or a wrong context all raise PiiDecryptionError -- never garbage.
 */
export class PiiCipher {
  constructor(private readonly key: Buffer) {
    if (key.length !== 32) throw new Error('PiiCipher requires a 32-byte key');
  }

  static isEncrypted(value: string | null | undefined): value is string {
    return typeof value === 'string' && value.startsWith(PREFIX);
  }

  encrypt(plaintext: string, context: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(context, 'utf8'));
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return `${PREFIX}${b64(iv)}:${b64(cipher.getAuthTag())}:${b64(ct)}`;
  }

  decrypt(envelope: string, context: string): string {
    if (!PiiCipher.isEncrypted(envelope)) throw new PiiDecryptionError('value is not an encrypted PII envelope');
    const parts = envelope.slice(PREFIX.length).split(':');
    if (parts.length !== 3) throw new PiiDecryptionError('malformed PII envelope');
    try {
      const [iv, tag, ct] = parts.map((p) => Buffer.from(p, 'base64url')) as [Buffer, Buffer, Buffer];
      const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
      decipher.setAAD(Buffer.from(context, 'utf8'));
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
    } catch {
      throw new PiiDecryptionError('PII decryption failed (wrong key, wrong field, or tampered data)');
    }
  }

  /** Null-safe encrypt for optional columns. */
  encryptNullable(value: string | null | undefined, context: string): string | null {
    return value == null || value === '' ? (value ?? null) : this.encrypt(value, context);
  }

  /** Null-safe decrypt that passes through legacy plaintext rows (written before B10) unchanged. */
  decryptNullable(value: string | null | undefined, context: string): string | null {
    if (value == null) return null;
    return PiiCipher.isEncrypted(value) ? this.decrypt(value, context) : value;
  }
}
