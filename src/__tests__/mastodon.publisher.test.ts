import { describe, expect, test } from 'vitest';
import { MastodonPublisher } from '../mastodon.js';
import type { MessageRecord } from '../repositories/messages.js';

const baseMessage: MessageRecord = {
  id: 'msg-1',
  body: 'Hello Mastodon',
  status: 'approved',
  weight: 100,
  cooldown_hours: 168,
  tags: ['Inferenco', 'AI'],
  platforms: ['mastodon'],
  self_labels: [],
  image_asset_id: null,
  image_path: null,
  image_alt: null,
  image_public_url: null,
  normalised_hash: 'sha256:one',
  last_posted_at: null,
  post_count: 0,
  created_at: new Date('2026-05-29T10:00:00.000Z'),
  updated_at: new Date('2026-05-29T10:00:00.000Z')
};

describe('MastodonPublisher', () => {
  test('posts a status with bearer auth, normalized instance URL, tags, visibility, and public media URL text', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const publisher = new MastodonPublisher({
      instanceUrl: 'https://mastodon.social/',
      accessToken: 'mastodon-token',
      visibility: 'unlisted',
      fetcher: async (url, init) => {
        calls.push({ url: String(url), init: init ?? {} });
        return new Response(JSON.stringify({
          id: '123',
          uri: 'https://mastodon.social/users/inferenco/statuses/123',
          url: 'https://mastodon.social/@inferenco/123'
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
    });

    const result = await publisher.publish({
      ...baseMessage,
      image_public_url: 'https://storage.googleapis.com/bucket/post.png'
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://mastodon.social/api/v1/statuses');
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].init.headers).toMatchObject({
      Authorization: 'Bearer mastodon-token'
    });
    const form = calls[0].init.body as URLSearchParams;
    expect(form.get('visibility')).toBe('unlisted');
    expect(form.get('status')).toBe('Hello Mastodon\n\n#Inferenco #AI\n\nhttps://storage.googleapis.com/bucket/post.png');
    expect(result).toEqual({
      uri: 'https://mastodon.social/users/inferenco/statuses/123',
      cid: null,
      url: 'https://mastodon.social/@inferenco/123'
    });
  });

  test('throws a clear error when Mastodon rejects the status', async () => {
    const publisher = new MastodonPublisher({
      instanceUrl: 'https://mastodon.social',
      accessToken: 'mastodon-token',
      visibility: 'public',
      fetcher: async () => new Response(JSON.stringify({ error: "Validation failed: Text can't be blank" }), { status: 422 })
    });

    await expect(publisher.publish(baseMessage)).rejects.toThrow("Mastodon post failed: 422 Validation failed: Text can't be blank");
  });
});
