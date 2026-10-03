import { describe, expect, test } from 'vitest';
import { BlogsRepository, type BlogRecord, type Queryable } from '../repositories/blogs.js';

class FakeDb implements Queryable {
  calls: { text: string; values: unknown[] }[] = [];
  responses: unknown[][] = [];

  async query<T>(text: string, values: unknown[] = []): Promise<{ rows: T[] }> {
    this.calls.push({ text, values });
    return { rows: (this.responses.shift() ?? []) as T[] };
  }
}

function blog(overrides: Partial<BlogRecord> = {}): BlogRecord {
  return {
    id: 'blog-1',
    title: 'A draft',
    content: '# Draft content',
    status: 'draft',
    published_at: null,
    created_at: new Date('2026-06-10T12:00:00Z'),
    updated_at: new Date('2026-06-10T12:00:00Z'),
    ...overrides
  };
}

describe('BlogsRepository publication lifecycle', () => {
  test('saves drafts without a publication date', async () => {
    const db = new FakeDb();
    db.responses = [[blog()]];
    const repo = new BlogsRepository(db, () => 'blog-1');

    await repo.create({ title: 'A draft', content: '# Draft content' });

    expect(db.calls[0].values).toEqual(['blog-1', 'A draft', '# Draft content', 'draft', null]);
  });

  test('assigns a publication date when a blog is created as published', async () => {
    const db = new FakeDb();
    db.responses = [[blog({ status: 'published' })]];
    const repo = new BlogsRepository(db, () => 'blog-1');
    const before = Date.now();

    await repo.create({ title: 'Published', content: 'Ready', status: 'published' });

    const publishedAt = db.calls[0].values[4];
    expect(publishedAt).toBeInstanceOf(Date);
    expect((publishedAt as Date).getTime()).toBeGreaterThanOrEqual(before);
    expect((publishedAt as Date).getTime()).toBeLessThanOrEqual(Date.now());
  });

  test('assigns a publication date when a draft is published through the edit form', async () => {
    const db = new FakeDb();
    db.responses = [[blog()], [blog({ status: 'published' })]];
    const repo = new BlogsRepository(db);

    await repo.update('blog-1', { status: 'published' });

    expect(db.calls[1].values[3]).toBe('published');
    expect(db.calls[1].values[4]).toBeInstanceOf(Date);
  });

  test('preserves an existing publication date when published content is edited', async () => {
    const db = new FakeDb();
    const publishedAt = new Date('2026-06-10T13:00:00Z');
    db.responses = [[blog({ status: 'published', published_at: publishedAt })], [blog()]];
    const repo = new BlogsRepository(db);

    await repo.update('blog-1', { title: 'Corrected title', content: 'Corrected content' });

    expect(db.calls[1].values).toEqual([
      'blog-1', 'Corrected title', 'Corrected content', 'published', publishedAt
    ]);
  });

  test.each(['draft', 'archived'] as const)('clears the publication date when moving to %s', async (status) => {
    const db = new FakeDb();
    db.responses = [[blog({ status: 'published', published_at: new Date() })], [blog()]];
    const repo = new BlogsRepository(db);

    await repo.update('blog-1', { status });

    expect(db.calls[1].values[3]).toBe(status);
    expect(db.calls[1].values[4]).toBeNull();
  });

  test('does not write when the requested blog is missing', async () => {
    const db = new FakeDb();
    const repo = new BlogsRepository(db);

    await expect(repo.update('missing', { title: 'Changed' })).rejects.toThrow('blog not found');
    expect(db.calls).toHaveLength(1);
  });
});

describe('BlogsRepository assets and public visibility', () => {
  test('repositions an existing attachment without referencing a nonexistent timestamp column', async () => {
    const db = new FakeDb();
    db.responses = [[{ blog_id: 'blog-1', asset_id: 'asset-1', position: 0 }], []];
    const repo = new BlogsRepository(db);

    await repo.addAsset('blog-1', 'asset-1', 2);

    expect(db.calls[1].text).toContain('update blog_assets set position = $3');
    expect(db.calls[1].text).not.toContain('updated_at');
    expect(db.calls[1].values).toEqual(['blog-1', 'asset-1', 2]);
  });

  test.each([true, false])('checks published associations before exposing an asset: %s', async (published) => {
    const db = new FakeDb();
    db.responses = [[{ published }]];
    const repo = new BlogsRepository(db);

    await expect(repo.isAssetPublished('asset-1')).resolves.toBe(published);

    expect(db.calls[0].text).toContain('join blogs b on b.id = ba.blog_id');
    expect(db.calls[0].text).toContain('ba.asset_id = $1 and b.status = $2');
    expect(db.calls[0].values).toEqual(['asset-1', 'published']);
  });

  test('lists only published blogs with the requested pagination', async () => {
    const db = new FakeDb();
    const published = blog({ status: 'published', published_at: new Date() });
    db.responses = [[{ count: '12' }], [published]];
    const repo = new BlogsRepository(db);

    await expect(repo.listPublished({ limit: 5, offset: 10 })).resolves.toEqual({
      blogs: [published], total: 12
    });
    expect(db.calls[0].values).toEqual(['published']);
    expect(db.calls[1].values).toEqual(['published', 5, 10]);
  });
});
