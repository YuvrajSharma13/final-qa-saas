import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';

// Evidence storage. Local disk for development; any S3-compatible bucket
// (AWS S3, Cloudflare R2, MinIO, ...) when S3_BUCKET is configured.
export interface ObjectStorage {
  kind: string;
  put(key: string, body: Buffer, contentType: string): Promise<string>;
  get(key: string): Promise<Buffer>;
  remove(key: string): Promise<void>;
}

const safeKey = (key: string) => {
  const normalized = path.posix.normalize(key).replace(/^\/+/, '');
  if (normalized.startsWith('..')) throw new Error('Invalid storage key');
  return normalized;
};

class LocalStorage implements ObjectStorage {
  kind = 'local';
  constructor(private root: string) {}
  async put(key: string, body: Buffer) {
    const k = safeKey(key);
    const file = path.join(this.root, k);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, body);
    return k;
  }
  async get(key: string) {
    return fs.readFile(path.join(this.root, safeKey(key)));
  }
  async remove(key: string) {
    await fs.rm(path.join(this.root, safeKey(key)), { force: true });
  }
}

class S3Storage implements ObjectStorage {
  kind = 's3';
  private clientPromise = import('@aws-sdk/client-s3').then(
    (m) =>
      ({
        m,
        client: new m.S3Client({
          region: config.s3.region,
          endpoint: config.s3.endpoint,
          forcePathStyle: Boolean(config.s3.endpoint),
          credentials: config.s3.accessKeyId
            ? { accessKeyId: config.s3.accessKeyId, secretAccessKey: config.s3.secretAccessKey }
            : undefined,
        }),
      }) as const,
  );
  async put(key: string, body: Buffer, contentType: string) {
    const { m, client } = await this.clientPromise;
    const k = safeKey(key);
    await client.send(new m.PutObjectCommand({ Bucket: config.s3.bucket, Key: k, Body: body, ContentType: contentType }));
    return k;
  }
  async get(key: string) {
    const { m, client } = await this.clientPromise;
    const out = await client.send(new m.GetObjectCommand({ Bucket: config.s3.bucket, Key: safeKey(key) }));
    const bytes = await out.Body!.transformToByteArray();
    return Buffer.from(bytes);
  }
  async remove(key: string) {
    const { m, client } = await this.clientPromise;
    await client.send(new m.DeleteObjectCommand({ Bucket: config.s3.bucket, Key: safeKey(key) }));
  }
}

export const storage: ObjectStorage = config.s3.bucket ? new S3Storage() : new LocalStorage(config.storageDir);
