import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, describe, expect, test } from 'vitest';
import { AssetsRepository, type AssetRecord } from '../repositories/assets.js';
import type { Queryable } from '../repositories/messages.js';

class FakeDb implements Queryable {
  calls: { text: string; values: unknown[] }[] = [];
  rows: unknown[] = [];

  async query<T>(text: string, values: unknown[] = []): Promise<{ rows: T[] }> {
    this.calls.push({ text, values });
    return { rows: this.rows as T[] };
  }
}

const tempFiles: string[] = [];

afterEach(async () => {
  await Promise.all(tempFiles.map(async (file) => fs.unlink(file).catch(() => undefined)));
  tempFiles.length = 0;
});

describe('AssetsRepository', () => {
  test('registers a local image with metadata and default alt text', async () => {
    const imagePath = path.join('/tmp', `asset-${Date.now()}.png`);
    await sharp({
      create: {
        width: 4,
        height: 3,
        channels: 3,
        background: '#1463ff'
      }
    }).png().toFile(imagePath);
    tempFiles.push(imagePath);

    const db = new FakeDb();
    db.rows = [{
      id: 'asset-1',
      storage_kind: 'local',
      path_or_object_key: imagePath,
      content: null,
      mime_type: 'image/png',
      width: 4,
      height: 3,
      bytes: (await fs.stat(imagePath)).size,
      alt_text_default: 'A blue swatch',
      created_at: new Date('2026-05-29T10:00:00.000Z')
    } satisfies AssetRecord];

    const repo = new AssetsRepository(db, () => 'asset-1');
    const asset = await repo.registerLocalImage({
      pathOrObjectKey: imagePath,
      altTextDefault: 'A blue swatch'
    });

    expect(asset.id).toBe('asset-1');
    expect(asset.width).toBe(4);
    expect(asset.height).toBe(3);
    expect(db.calls[0].text).toContain('insert into assets');
    expect(db.calls[0].values).toContain('image/png');
    expect(db.calls[0].values).toContain('A blue swatch');
  });

  test('rejects non-image paths before inserting', async () => {
    const db = new FakeDb();
    const repo = new AssetsRepository(db, () => 'asset-1');

    await expect(repo.registerLocalImage({
      pathOrObjectKey: 'notes.txt',
      altTextDefault: 'Notes'
    })).rejects.toThrow('Asset MIME type must start with image/');

    expect(db.calls).toHaveLength(0);
  });

  test('registers an uploaded image buffer for database-backed storage', async () => {
    const image = await sharp({
      create: {
        width: 5,
        height: 2,
        channels: 3,
        background: '#067647'
      }
    }).jpeg().toBuffer();
    const db = new FakeDb();
    db.rows = [{
      id: 'asset-upload-1',
      storage_kind: 'database',
      path_or_object_key: null,
      content: image,
      mime_type: 'image/jpeg',
      width: 5,
      height: 2,
      bytes: image.length,
      alt_text_default: 'Uploaded green swatch',
      created_at: new Date('2026-05-29T10:00:00.000Z')
    } satisfies AssetRecord];

    const repo = new AssetsRepository(db, () => 'asset-upload-1');
    const asset = await repo.registerImageBuffer({
      fileName: 'swatch.jpg',
      content: image,
      altTextDefault: 'Uploaded green swatch'
    });

    expect(asset.storage_kind).toBe('database');
    expect(asset.path_or_object_key).toBeNull();
    expect(asset.content).toBe(image);
    expect(db.calls[0].text).toContain('insert into assets');
    expect(db.calls[0].values).toContain('database');
    expect(db.calls[0].values).toContain(image);
  });
});
