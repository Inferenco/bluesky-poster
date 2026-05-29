import { describe, expect, test } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { PosterService, type BlueskyPublisher, type RunRecorder } from '../services/poster.js';
import type { MessageRecord } from '../repositories/messages.js';

const baseMessage: MessageRecord = {
  id: 'msg-1',
  body: 'Hello Bluesky',
  status: 'approved',
  weight: 100,
  cooldown_hours: 168,
  tags: [],
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

class FakeRuns implements RunRecorder {
  records: Parameters<RunRecorder['record']>[0][] = [];

  async record(input: Parameters<RunRecorder['record']>[0]) {
    this.records.push(input);
  }
}

class FakePublisher implements BlueskyPublisher {
  calls: MessageRecord[] = [];

  async publish(message: MessageRecord) {
    this.calls.push(message);
    return { uri: 'at://did/app.bsky.feed.post/1', cid: 'cid-1' };
  }
}

describe('PosterService', () => {
  test('rejects text over the Bluesky grapheme limit and records the failure', async () => {
    const runs = new FakeRuns();
    const publisher = new FakePublisher();
    const poster = new PosterService({ publisher, runs, dryRun: false });

    await expect(poster.publish({ ...baseMessage, body: 'x'.repeat(301) })).rejects.toThrow('Message must be 300 graphemes or fewer');

    expect(publisher.calls).toHaveLength(0);
    expect(runs.records).toMatchObject([{ messageId: 'msg-1', status: 'failed' }]);
  });

  test('rejects images without alt text and records the failure', async () => {
    const runs = new FakeRuns();
    const publisher = new FakePublisher();
    const poster = new PosterService({ publisher, runs, dryRun: false });

    await expect(poster.publish({ ...baseMessage, image_path: 'assets/post.jpg', image_alt: '' })).rejects.toThrow('Image alt text is required');

    expect(publisher.calls).toHaveLength(0);
    expect(runs.records).toMatchObject([{ messageId: 'msg-1', status: 'failed' }]);
  });

  test('records dry-run success without calling Bluesky', async () => {
    const runs = new FakeRuns();
    const publisher = new FakePublisher();
    const poster = new PosterService({ publisher, runs, dryRun: true });

    const result = await poster.publish(baseMessage);

    expect(result.status).toBe('dry_run');
    expect(publisher.calls).toHaveLength(0);
    expect(runs.records).toMatchObject([{ messageId: 'msg-1', status: 'dry_run' }]);
  });

  test('rejects image paths with unsupported MIME extensions', async () => {
    const runs = new FakeRuns();
    const publisher = new FakePublisher();
    const poster = new PosterService({ publisher, runs, dryRun: false });

    await expect(poster.publish({ ...baseMessage, image_path: 'assets/post.txt', image_alt: 'Alt text' })).rejects.toThrow('Image MIME type must start with image/');

    expect(publisher.calls).toHaveLength(0);
    expect(runs.records).toMatchObject([{ messageId: 'msg-1', status: 'failed' }]);
  });

  test('rejects images over the Bluesky size limit', async () => {
    const tempPath = path.join('/tmp', `oversized-${Date.now()}.jpg`);
    await fs.writeFile(tempPath, Buffer.alloc(2_000_001));
    const runs = new FakeRuns();
    const publisher = new FakePublisher();
    const poster = new PosterService({ publisher, runs, dryRun: false });

    await expect(poster.publish({ ...baseMessage, image_path: tempPath, image_alt: 'Alt text' })).rejects.toThrow('Image must be 2 MB or smaller');

    expect(publisher.calls).toHaveLength(0);
    expect(runs.records).toMatchObject([{ messageId: 'msg-1', status: 'failed' }]);
    await fs.unlink(tempPath);
  });
});
