import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

const KEY = Buffer.from(
  process.env.ENCRYPTION_KEY || '',
  'hex',
);

export function encrypt(plaintext: string): string {
  if (KEY.length !== 32) {
    throw new Error('ENCRYPTION_KEY must be 32 bytes (64 hex characters)');
  }
  const iv = randomBytes(16);
  const cipher = createCipheriv('aes-256-gcm', KEY, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString('base64');
}

export function decrypt(ciphertext: string): string {
  if (KEY.length !== 32) {
    throw new Error('ENCRYPTION_KEY must be 32 bytes (64 hex characters)');
  }
  const buf = Buffer.from(ciphertext, 'base64');
  const iv = buf.slice(0, 16);
  const tag = buf.slice(16, 32);
  const data = buf.slice(32);
  const decipher = createDecipheriv('aes-256-gcm', KEY, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}
