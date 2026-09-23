import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

/** `scrypt$<salt>$<hash>` -- the exact format the demo seed (db/seed.ts) already writes. */
export function hashPassword(pw: string): string {
  const salt = randomBytes(16).toString('hex');
  return `scrypt$${salt}$${scryptSync(pw, salt, 32).toString('hex')}`;
}

const DUMMY = hashPassword('dummy-password-for-constant-time-compare');

/** Constant-time verify. Always does one scrypt so an unknown user costs the same as a wrong password. */
export function verifyPassword(pw: string, stored: string | null | undefined): boolean {
  const [scheme, salt, hash] = stored ? stored.split('$') : [];
  const valid = scheme === 'scrypt' && !!salt && !!hash;
  const [, dSalt, dHash] = DUMMY.split('$');
  const expected = Buffer.from(valid ? hash : dHash, 'hex');
  const actual = scryptSync(pw, valid ? salt : dSalt, 32);
  return expected.length === actual.length && timingSafeEqual(expected, actual) && valid;
}
