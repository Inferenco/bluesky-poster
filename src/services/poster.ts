import fs from 'node:fs/promises';
import path from 'node:path';
import type { MessageRecord } from '../repositories/messages.js';
import { countGraphemes, MAX_GRAPHEMES } from '../validate.js';

const MAX_IMAGE_BYTES = 2_000_000;

export type PostRunStatus = 'success' | 'failed' | 'dry_run';

export interface PosterResult {
  status: PostRunStatus;
  uri: string | null;
  cid: string | null;
}

export interface BlueskyPublisher {
  publish(message: MessageRecord): Promise<{ uri: string | null; cid: string | null }>;
}

export interface RunRecorder {
  record(input: {
    messageId: string;
    status: PostRunStatus;
    bskyUri?: string | null;
    bskyCid?: string | null;
    error?: string | null;
    httpStatus?: number | null;
    retryCount?: number;
  }): Promise<void>;
}

export class PosterService {
  constructor(
    private readonly deps: {
      publisher: BlueskyPublisher;
      runs: RunRecorder;
      dryRun: boolean;
    }
  ) {}

  async publish(message: MessageRecord): Promise<PosterResult> {
    try {
      await validateOutboundMessage(message);

      if (this.deps.dryRun) {
        await this.deps.runs.record({ messageId: message.id, status: 'dry_run' });
        return { status: 'dry_run', uri: null, cid: null };
      }

      const result = await this.deps.publisher.publish(message);
      await this.deps.runs.record({
        messageId: message.id,
        status: 'success',
        bskyUri: result.uri,
        bskyCid: result.cid
      });

      return { status: 'success', uri: result.uri, cid: result.cid };
    } catch (err) {
      await this.deps.runs.record({
        messageId: message.id,
        status: 'failed',
        error: err instanceof Error ? err.message : String(err)
      });
      throw err;
    }
  }
}

export async function validateOutboundMessage(message: MessageRecord): Promise<void> {
  if (countGraphemes(message.body) > MAX_GRAPHEMES) {
    throw new Error('Message must be 300 graphemes or fewer');
  }

  const hasImage = Boolean(message.image_path || message.image_content || message.image_public_url);
  if (hasImage && !message.image_alt?.trim()) {
    throw new Error('Image alt text is required');
  }

  if (hasImage) {
    const mime = message.image_mime_type ?? (message.image_path ? getImageMimeType(message.image_path) : 'application/octet-stream');
    if (!mime.startsWith('image/')) {
      throw new Error('Image MIME type must start with image/');
    }

    if (!message.image_public_url) {
      const bytes = message.image_content?.length ?? (message.image_path ? (await fs.stat(path.resolve(process.cwd(), message.image_path))).size : 0);
      if (bytes > MAX_IMAGE_BYTES) {
        throw new Error('Image must be 2 MB or smaller');
      }
    }
  }
}

export function getImageMimeType(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  switch (extension) {
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.png':
      return 'image/png';
    case '.gif':
      return 'image/gif';
    case '.webp':
      return 'image/webp';
    default:
      return 'application/octet-stream';
  }
}
