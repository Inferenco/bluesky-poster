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
  test('uploads a public image URL as Mastodon media and attaches the returned media id to the status', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const publisher = new MastodonPublisher({
      instanceUrl: 'https://mastodon.social/',
      accessToken: 'mastodon-token',
      visibility: 'unlisted',
      fetcher: async (url, init) => {
        calls.push({ url: String(url), init: init ?? {} });
        if (String(url) === 'https://storage.googleapis.com/bucket/post.png') {
          return new Response(Buffer.from('fake-image'), {
            status: 200,
            headers: { 'content-type': 'image/png' }
          });
        }
        if (String(url) === 'https://mastodon.social/api/v2/media') {
          return new Response(JSON.stringify({ id: 'media-123' }), {
            status: 200,
            headers: { 'content-type': 'application/json' }
          });
        }
        return new Response(JSON.stringify({
          id: '123',
          uri: 'https://mastodon.social/users/inferenco/statuses/123',
          url: 'https://mastodon.social/@inferenco/123'
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
    });

    const result = await publisher.publish({
      ...baseMessage,
      image_alt: 'A generated image',
      image_public_url: 'https://storage.googleapis.com/bucket/post.png'
    });

    expect(calls).toHaveLength(3);
    expect(calls[0].url).toBe('https://storage.googleapis.com/bucket/post.png');

    expect(calls[1].url).toBe('https://mastodon.social/api/v2/media');
    expect(calls[1].init.method).toBe('POST');
    expect(calls[1].init.headers).toMatchObject({
      Authorization: 'Bearer mastodon-token'
    });
    const mediaForm = calls[1].init.body as FormData;
    expect(mediaForm.get('description')).toBe('A generated image');
    const file = mediaForm.get('file') as File;
    expect(file.name).toBe('post.png');
    expect(file.type).toBe('image/png');

    expect(calls[2].url).toBe('https://mastodon.social/api/v1/statuses');
    expect(calls[2].init.method).toBe('POST');
    expect(calls[2].init.headers).toMatchObject({
      Authorization: 'Bearer mastodon-token'
    });
    const statusForm = calls[2].init.body as URLSearchParams;
    expect(statusForm.get('visibility')).toBe('unlisted');
    expect(statusForm.get('status')).toBe('Hello Mastodon\n\n#Inferenco #AI');
    expect(statusForm.get('media_ids[]')).toBe('media-123');
    expect(result).toEqual({
      uri: 'https://mastodon.social/users/inferenco/statuses/123',
      cid: null,
      url: 'https://mastodon.social/@inferenco/123'
    });
  });

  test('posts text only when no public image URL is available', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const publisher = new MastodonPublisher({
      instanceUrl: 'https://mastodon.social',
      accessToken: 'mastodon-token',
      visibility: 'public',
      fetcher: async (url, init) => {
        calls.push({ url: String(url), init: init ?? {} });
        return new Response(JSON.stringify({
          uri: 'https://mastodon.social/users/inferenco/statuses/124',
          url: 'https://mastodon.social/@inferenco/124'
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
    });

    await publisher.publish({
      ...baseMessage,
      image_content: Buffer.from('local-image'),
      image_mime_type: 'image/png',
      image_alt: 'Local image'
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://mastodon.social/api/v1/statuses');
    const statusForm = calls[0].init.body as URLSearchParams;
    expect(statusForm.get('status')).toBe('Hello Mastodon\n\n#Inferenco #AI');
    expect(statusForm.get('media_ids[]')).toBeNull();
  });

  test('fails before posting when the public image URL cannot be fetched', async () => {
    const calls: string[] = [];
    const publisher = new MastodonPublisher({
      instanceUrl: 'https://mastodon.social',
      accessToken: 'mastodon-token',
      visibility: 'public',
      fetcher: async (url) => {
        calls.push(String(url));
        return new Response('not found', { status: 404 });
      }
    });

    await expect(publisher.publish({
      ...baseMessage,
      image_public_url: 'https://storage.googleapis.com/bucket/missing.png'
    })).rejects.toThrow('Failed to fetch Mastodon media: 404');

    expect(calls).toEqual(['https://storage.googleapis.com/bucket/missing.png']);
  });

  test('fails before posting when Mastodon media upload fails', async () => {
    const calls: string[] = [];
    const publisher = new MastodonPublisher({
      instanceUrl: 'https://mastodon.social',
      accessToken: 'mastodon-token',
      visibility: 'public',
      fetcher: async (url) => {
        calls.push(String(url));
        if (String(url) === 'https://storage.googleapis.com/bucket/post.png') {
          return new Response(Buffer.from('fake-image'), {
            status: 200,
            headers: { 'content-type': 'image/png' }
          });
        }
        return new Response(JSON.stringify({ error: 'File type is not supported' }), { status: 422 });
      }
    });

    await expect(publisher.publish({
      ...baseMessage,
      image_public_url: 'https://storage.googleapis.com/bucket/post.png'
    })).rejects.toThrow('Mastodon media upload failed: 422 File type is not supported');

    expect(calls).toEqual([
      'https://storage.googleapis.com/bucket/post.png',
      'https://mastodon.social/api/v2/media'
    ]);
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
