import { describe, expect, test } from 'vitest';
import { MessagesRepository, type Queryable } from '../repositories/messages.js';
import { hashText } from '../validate.js';

class FakeDb implements Queryable {
  calls: { text: string; values: unknown[] }[] = [];
  rows: unknown[] = [];

  async query<T>(text: string, values: unknown[] = []): Promise<{ rows: T[] }> {
    this.calls.push({ text, values });
    return { rows: this.rows as T[] };
  }
}

describe('MessagesRepository', () => {
  test('creates a saved message with validation defaults and a normalised hash', async () => {
    const db = new FakeDb();
    db.rows = [{
      id: 'msg-1',
      body: 'Hello Bluesky',
      status: 'draft',
      weight: 100,
      cooldown_hours: 168,
      tags: [],
      self_labels: [],
      image_asset_id: null,
      image_path: null,
      image_alt: null,
      normalised_hash: hashText('Hello Bluesky'),
      last_posted_at: null,
      post_count: 0,
      created_at: new Date('2026-05-29T10:00:00.000Z'),
      updated_at: new Date('2026-05-29T10:00:00.000Z')
    }];

    const repo = new MessagesRepository(db, () => 'msg-1');
    const message = await repo.create({
      body: 'Hello Bluesky'
    });

    expect(db.calls[0].text).toContain('insert into messages');
    expect(db.calls[0].values).toContain('msg-1');
    expect(db.calls[0].values).toContain(hashText('Hello Bluesky'));
    expect(message.status).toBe('draft');
  });

  test('rejects saved messages over the Bluesky grapheme limit', async () => {
    const db = new FakeDb();
    const repo = new MessagesRepository(db, () => 'msg-1');

    await expect(repo.create({ body: 'x'.repeat(301) })).rejects.toThrow('Message must be 300 graphemes or fewer');
    expect(db.calls).toHaveLength(0);
  });
});
