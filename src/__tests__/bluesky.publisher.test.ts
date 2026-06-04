import { describe, expect, test } from 'vitest';
import { AtprotoBlueskyPublisher } from '../bluesky.js';
import type { MessageRecord } from '../repositories/messages.js';

const baseMessage: MessageRecord = {
  id: 'msg-1',
  body: 'Hello Bluesky',
  status: 'approved',
  weight: 100,
  cooldown_hours: 168,
  tags: [],
  platforms: ['bluesky'],
  self_labels: [],
  image_asset_id: null,
  image_path: null,
  image_alt: null,
  normalised_hash: 'sha256:one',
  last_posted_at: null,
  post_count: 0,
  created_at: new Date('2026-05-29T10:00:00.000Z'),
  updated_at: new Date('2026-05-29T10:00:00.000Z')
};

describe('AtprotoBlueskyPublisher', () => {
  test('includes image aspect ratio when message dimensions are available', async () => {
    const createRecordCalls: any[] = [];
    const agent = {
      session: { did: 'did:plc:test' },
      com: {
        atproto: {
          repo: {
            uploadBlob: async () => ({ data: { blob: { ref: 'blob-ref' } } }),
            createRecord: async (input: any) => {
              createRecordCalls.push(input);
              return { data: { uri: 'at://did/app.bsky.feed.post/1', cid: 'cid-1' } };
            }
          }
        }
      }
    };
    const publisher = new AtprotoBlueskyPublisher(agent as any);

    await publisher.publish({
      ...baseMessage,
      image_content: Buffer.from('fake-image'),
      image_mime_type: 'image/jpeg',
      image_alt: 'A generated test image',
      image_width: 1200,
      image_height: 800
    });

    expect(createRecordCalls[0].record.embed.images[0]).toMatchObject({
      alt: 'A generated test image',
      aspectRatio: { width: 1200, height: 800 }
    });
  });
});
