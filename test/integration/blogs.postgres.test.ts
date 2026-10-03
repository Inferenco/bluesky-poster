import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import type pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { createPool } from '../../src/db/client.js';
import { BlogsRepository } from '../../src/repositories/blogs.js';
import { getPostgresTestDatabaseUrl } from './databaseSafety.js';

const databaseUrl = getPostgresTestDatabaseUrl();
const describeIfDb = databaseUrl ? describe : describe.skip;

describeIfDb('Postgres-backed blog lifecycle', () => {
  let pool: pg.Pool;
  let client: pg.PoolClient | undefined;
  let blogs: BlogsRepository;

  beforeAll(() => {
    if (!databaseUrl) throw new Error('POSTGRES_TEST_DATABASE_URL is required');
    pool = createPool(databaseUrl);
  });

  beforeEach(async () => {
    client = await pool.connect();
    await client.query('begin');
    const schema = 'blogs_test_' + randomUUID().replace(/-/g, '');
    await client.query('create schema "' + schema + '"');
    await client.query('set local search_path to "' + schema + '"');

    // Load migrations directly, avoiding application configuration and dotenv.
    // The schema, migrations, and all test rows disappear with the rollback.
    const directory = new URL('../../db/', import.meta.url);
    const files = (await readdir(directory)).filter(file => file.endsWith('.sql')).sort();
    for (const file of files) {
      await client.query(await readFile(new URL(file, directory), 'utf8'));
    }
    blogs = new BlogsRepository(client);
  });

  afterEach(async () => {
    if (client) {
      try {
        await client.query('rollback');
      } finally {
        client.release();
        client = undefined;
      }
    }
  });

  afterAll(async () => {
    await pool?.end();
  });

  async function addAsset(id: string): Promise<void> {
    await client!.query(
      'insert into assets (id, storage_kind, content, mime_type, width, height, bytes, alt_text_default) ' +
      'values ($1, $2, $3, $4, $5, $6, $7, $8)',
      [id, 'database', Buffer.from('test-image'), 'image/png', 1, 1, 10, 'Test image ' + id]
    );
  }

  test('creates drafts without publication dates and dates immediately published blogs', async () => {
    const draft = await blogs.create({ title: 'Draft', content: 'Unpublished content' });
    const published = await blogs.create({ title: 'Published', content: 'Public content', status: 'published' });

    expect(draft.status).toBe('draft');
    expect(draft.published_at).toBeNull();
    expect(published.status).toBe('published');
    expect(published.published_at).toBeInstanceOf(Date);
    expect(Number.isNaN(new Date(published.published_at!).getTime())).toBe(false);

    const page = await blogs.listPublished();
    expect(page.total).toBe(1);
    expect(page.blogs.map(item => item.id)).toEqual([published.id]);
  });

  test('dates publication through editing, preserves the date on edits, and clears it on unpublish', async () => {
    const draft = await blogs.create({ title: 'Draft', content: 'First version' });
    const published = await blogs.update(draft.id, { status: 'published' });
    expect(published.published_at).toBeInstanceOf(Date);
    const publicationTime = new Date(published.published_at!).getTime();

    const edited = await blogs.update(draft.id, { title: 'Updated title', content: 'Second version' });
    expect(edited.title).toBe('Updated title');
    expect(new Date(edited.published_at!).getTime()).toBe(publicationTime);

    await blogs.setStatus(draft.id, 'published');
    expect(new Date((await blogs.get(draft.id))!.published_at!).getTime()).toBe(publicationTime);

    const unpublished = await blogs.update(draft.id, { status: 'draft' });
    expect(unpublished.published_at).toBeNull();
    expect((await blogs.listPublished()).total).toBe(0);

    await blogs.setStatus(draft.id, 'published');
    expect((await blogs.get(draft.id))!.published_at).toBeInstanceOf(Date);
    await blogs.setStatus(draft.id, 'archived');
    expect((await blogs.get(draft.id))!.published_at).toBeNull();
    expect(await blogs.list()).toEqual([]);
  });

  test('reattaches an existing image once and updates its ordering without a schema error', async () => {
    const post = await blogs.create({ title: 'Images', content: 'Ordered attachments' });
    await addAsset('first');
    await addAsset('second');
    await blogs.addAsset(post.id, 'first', 0);
    await blogs.addAsset(post.id, 'second', 1);
    await blogs.addAsset(post.id, 'first', 2);

    expect((await blogs.getBlogAssets(post.id)).map(item => item.id)).toEqual(['second', 'first']);
    const associations = await client!.query(
      'select position from blog_assets where blog_id = $1 and asset_id = $2',
      [post.id, 'first']
    );
    expect(associations.rows).toEqual([{ position: 2 }]);

    await blogs.reorderAssets(post.id, 'first', 0);
    expect((await blogs.getBlogAssets(post.id)).map(item => item.id)).toEqual(['first', 'second']);
  });

  test('exposes an image only while at least one associated blog is published', async () => {
    await addAsset('shared-image');
    await addAsset('unattached-image');
    const first = await blogs.create({ title: 'First', content: 'Draft image' });
    const second = await blogs.create({ title: 'Second', content: 'Another draft' });
    await blogs.addAsset(first.id, 'shared-image');
    await blogs.addAsset(second.id, 'shared-image');

    expect(await blogs.isAssetPublished('shared-image')).toBe(false);
    expect(await blogs.isAssetPublished('unattached-image')).toBe(false);
    expect(await blogs.isAssetPublished('missing-image')).toBe(false);

    await blogs.setStatus(first.id, 'published');
    expect(await blogs.isAssetPublished('shared-image')).toBe(true);
    await blogs.setStatus(second.id, 'published');
    await blogs.setStatus(first.id, 'draft');
    expect(await blogs.isAssetPublished('shared-image')).toBe(true);

    await blogs.setStatus(second.id, 'archived');
    expect(await blogs.isAssetPublished('shared-image')).toBe(false);
    await blogs.update(first.id, { status: 'published' });
    expect(await blogs.isAssetPublished('shared-image')).toBe(true);
    await blogs.removeAsset(first.id, 'shared-image');
    expect(await blogs.isAssetPublished('shared-image')).toBe(false);
  });

  test('deleting a blog removes its associations while preserving the image record', async () => {
    await addAsset('retained-image');
    const post = await blogs.create({ title: 'Delete me', content: 'With an image', status: 'published' });
    await blogs.addAsset(post.id, 'retained-image');

    await blogs.delete(post.id);

    expect(await blogs.get(post.id)).toBeNull();
    expect(await blogs.countReferencingAsset('retained-image')).toBe(0);
    expect(await blogs.isAssetPublished('retained-image')).toBe(false);
    const images = await client!.query('select id from assets where id = $1', ['retained-image']);
    expect(images.rows).toEqual([{ id: 'retained-image' }]);
  });
});
