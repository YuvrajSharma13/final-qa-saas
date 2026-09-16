import crypto from 'node:crypto';
import { config } from '../config.js';

// AES-256-GCM for secrets stored at rest (GitHub tokens, test-account passwords).
const key = crypto.createHash('sha256').update(config.encryptionKey).digest();

export function encryptSecret(plain: string): string {
  if (!plain) return '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`;
}

export function decryptSecret(payload: string | undefined | null): string {
  if (!payload) return '';
  const [v, ivB64, tagB64, dataB64] = payload.split(':');
  if (v !== 'v1') throw new Error('Unsupported secret format');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
}

export const sha1 = (s: string) => crypto.createHash('sha1').update(s).digest('hex');
export const randomId = (bytes = 6) => crypto.randomBytes(bytes).toString('hex');
