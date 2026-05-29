import fs from 'node:fs/promises';
import sharp from 'sharp';
import { nanoid } from 'nanoid';
import type { Queryable } from './messages.js';
import { getImageMimeType } from '../services/poster.js';
import { deleteObject } from '../replit_integrations/object_storage.js';

const MAX_IMAGE_BYTES = 2_000_000;

export interface AssetRecord {
  id: string;
  storage_kind: 'local' | 'database' | 'object_storage';
  path_or_object_key: string | null;
  public_url: string | null;
  content: Buffer | null;
  mime_type: string;
  width: number;
  height: number;
  bytes: number;
  alt_text_default: string;
  created_at: Date | string;
}

export interface RegisterLocalImageInput {
  pathOrObjectKey: string;
  altTextDefault: string;
}

export interface RegisterImageBufferInput {
  fileName: string;
  content: Buffer;
  altTextDefault: string;
}

export interface RegisterObjectStorageImageInput {
  objectKey: string;
  publicUrl: string;
  mimeType: string;
  width: number;
  height: number;
  bytes: number;
  altTextDefault: string;
}

export class AssetsRepository {
  constructor(
    private readonly db: Queryable,
    private readonly createId: () => string = nanoid
  ) {}

  async list(): Promise<AssetRecord[]> {
    const result = await this.db.query<AssetRecord>('select * from assets order by created_at desc');
    return result.rows;
  }

  async get(id: string): Promise<AssetRecord | null> {
    const result = await this.db.query<AssetRecord>('select * from assets where id = $1', [id]);
    return result.rows[0] ?? null;
  }

  async registerLocalImage(input: RegisterLocalImageInput): Promise<AssetRecord> {
    if (!input.altTextDefault.trim()) {
      throw new Error('Asset alt text is required');
    }

    const mimeType = getImageMimeType(input.pathOrObjectKey);
    if (!mimeType.startsWith('image/')) {
      throw new Error('Asset MIME type must start with image/');
    }

    const stats = await fs.stat(input.pathOrObjectKey);
    if (stats.size > MAX_IMAGE_BYTES) {
      throw new Error('Asset image must be 2 MB or smaller');
    }

    const metadata = await sharp(input.pathOrObjectKey).metadata();
    if (!metadata.width || !metadata.height) {
      throw new Error('Asset image dimensions could not be read');
    }

    const result = await this.db.query<AssetRecord>(
      `insert into assets (
        id, storage_kind, path_or_object_key, public_url, content, mime_type, width, height, bytes, alt_text_default
      ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      returning *`,
      [
        this.createId(),
        'local',
        input.pathOrObjectKey,
        null,
        null,
        mimeType,
        metadata.width,
        metadata.height,
        stats.size,
        input.altTextDefault.trim()
      ]
    );

    return result.rows[0];
  }

  async registerImageBuffer(input: RegisterImageBufferInput): Promise<AssetRecord> {
    if (!input.altTextDefault.trim()) {
      throw new Error('Asset alt text is required');
    }

    const mimeType = getImageMimeType(input.fileName);
    if (!mimeType.startsWith('image/')) {
      throw new Error('Asset MIME type must start with image/');
    }
    if (input.content.length > MAX_IMAGE_BYTES) {
      throw new Error('Asset image must be 2 MB or smaller');
    }

    const metadata = await sharp(input.content).metadata();
    if (!metadata.width || !metadata.height) {
      throw new Error('Asset image dimensions could not be read');
    }

    const result = await this.db.query<AssetRecord>(
      `insert into assets (
        id, storage_kind, path_or_object_key, public_url, content, mime_type, width, height, bytes, alt_text_default
      ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      returning *`,
      [
        this.createId(),
        'database',
        null,
        null,
        input.content,
        mimeType,
        metadata.width,
        metadata.height,
        input.content.length,
        input.altTextDefault.trim()
      ]
    );

    return result.rows[0];
  }

  async delete(id: string): Promise<void> {
    const result = await this.db.query<AssetRecord>(
      'delete from assets where id = $1 returning storage_kind, path_or_object_key',
      [id]
    );

    const deleted = result.rows[0];
    if (!deleted) return;

    if (deleted.storage_kind === 'object_storage' && deleted.path_or_object_key) {
      try {
        await deleteObject(deleted.path_or_object_key);
      } catch (err) {
        console.error(`[assets] Failed to delete object from storage for asset ${id}:`, err);
      }
    }
  }

  async registerObjectStorageImage(input: RegisterObjectStorageImageInput): Promise<AssetRecord> {
    if (!input.altTextDefault.trim()) {
      throw new Error('Asset alt text is required');
    }
    if (!input.mimeType.startsWith('image/')) {
      throw new Error('Asset MIME type must start with image/');
    }
    if (input.bytes > MAX_IMAGE_BYTES) {
      throw new Error('Asset image must be 2 MB or smaller');
    }
    if (!input.width || !input.height) {
      throw new Error('Asset image dimensions are required');
    }

    const result = await this.db.query<AssetRecord>(
      `insert into assets (
        id, storage_kind, path_or_object_key, public_url, content, mime_type, width, height, bytes, alt_text_default
      ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      returning *`,
      [
        this.createId(),
        'object_storage',
        input.objectKey,
        input.publicUrl,
        null,
        input.mimeType,
        input.width,
        input.height,
        input.bytes,
        input.altTextDefault.trim()
      ]
    );

    return result.rows[0];
  }
}
