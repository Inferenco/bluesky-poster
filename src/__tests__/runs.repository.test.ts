import { describe, expect, test } from 'vitest';
import { RunsRepository } from '../repositories/runs.js';
import type { Queryable } from '../repositories/messages.js';

class FakeDb implements Queryable {
  calls: { text: string; values: unknown[] }[] = [];

  async query<T>(text: string, values: unknown[] = []): Promise<{ rows: T[] }> {
    this.calls.push({ text, values });
    return { rows: [] };
  }
}

describe('RunsRepository', () => {
  test('records platform-specific run metadata while preserving Bluesky fields', async () => {
    const db = new FakeDb();
    const repo = new RunsRepository(db, () => 'run-1');

    await repo.record({
      messageId: 'msg-1',
      platform: 'mastodon',
      status: 'success',
      platformUri: 'https://mastodon.social/users/inferenco/statuses/123',
      platformUrl: 'https://mastodon.social/@inferenco/123',
      bskyUri: null,
      bskyCid: null
    });

    expect(db.calls[0].text).toContain('platform');
    expect(db.calls[0].text).toContain('platform_uri');
    expect(db.calls[0].text).toContain('platform_url');
    expect(db.calls[0].values).toEqual([
      'run-1',
      'msg-1',
      'mastodon',
      'success',
      null,
      null,
      'https://mastodon.social/users/inferenco/statuses/123',
      'https://mastodon.social/@inferenco/123',
      null,
      null,
      0
    ]);
  });
});
