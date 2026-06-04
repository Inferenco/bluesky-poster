import fs from 'node:fs/promises';
import path from 'node:path';
import { normalizePlatforms, type MessageRecord, type PostingPlatform } from '../repositories/messages.js';
import { countGraphemes, MAX_GRAPHEMES } from '../validate.js';

const MAX_IMAGE_BYTES = 2_000_000;

export type PostRunStatus = 'success' | 'failed' | 'dry_run';
export type PosterStatus = PostRunStatus | 'partial';

export interface PosterResult {
  status: PosterStatus;
  uri: string | null;
  cid: string | null;
}

export interface BlueskyPublisher {
  publish(message: MessageRecord): Promise<{ uri: string | null; cid: string | null }>;
}

export interface PlatformPublisher {
  platform: PostingPlatform;
  publish(message: MessageRecord): Promise<{ uri: string | null; cid: string | null; url?: string | null }>;
}

export interface RunRecorder {
  record(input: {
    messageId: string;
    platform?: PostingPlatform;
    status: PostRunStatus;
    bskyUri?: string | null;
    bskyCid?: string | null;
    platformUri?: string | null;
    platformUrl?: string | null;
    error?: string | null;
    httpStatus?: number | null;
    retryCount?: number;
  }): Promise<void>;
}

export class PosterService {
  private readonly publishers: PlatformPublisher[];

  constructor(
    private readonly deps: {
      publisher?: BlueskyPublisher;
      publishers?: PlatformPublisher[];
      runs: RunRecorder;
      dryRun: boolean;
    }
  ) {
    this.publishers = deps.publishers ?? (deps.publisher ? [asBlueskyPlatformPublisher(deps.publisher)] : []);
  }

  async publish(message: MessageRecord): Promise<PosterResult> {
    const platforms = normalizePlatforms(message.platforms);
    const selectedPublishers = platforms.map((platform) => ({
      platform,
      publisher: this.publishers.find((candidate) => candidate.platform === platform) ?? null
    }));

    try {
      await validateOutboundMessage(message, platforms.includes('bluesky'));

      if (this.deps.dryRun) {
        for (const { platform, publisher } of selectedPublishers) {
          if (!publisher) continue;
          await this.deps.runs.record({ messageId: message.id, platform, status: 'dry_run' });
        }
        return { status: 'dry_run', uri: null, cid: null };
      }

      let successCount = 0;
      let failureCount = 0;
      let firstSuccess: { uri: string | null; cid: string | null } = { uri: null, cid: null };

      for (const { platform, publisher } of selectedPublishers) {
        if (!publisher) {
          failureCount += 1;
          await this.deps.runs.record({
            messageId: message.id,
            platform,
            status: 'failed',
            error: `${platform} publisher is not configured`
          });
          continue;
        }

        try {
          const result = await publisher.publish(message);
          successCount += 1;
          if (successCount === 1) {
            firstSuccess = { uri: result.uri, cid: result.cid };
          }
          await this.deps.runs.record({
            messageId: message.id,
            platform,
            status: 'success',
            bskyUri: platform === 'bluesky' ? result.uri : null,
            bskyCid: platform === 'bluesky' ? result.cid : null,
            platformUri: result.uri,
            platformUrl: result.url ?? result.uri
          });
        } catch (err) {
          failureCount += 1;
          await this.deps.runs.record({
            messageId: message.id,
            platform,
            status: 'failed',
            error: err instanceof Error ? err.message : String(err)
          });
        }
      }

      if (successCount > 0) {
        return {
          status: failureCount > 0 ? 'partial' : 'success',
          uri: firstSuccess.uri,
          cid: firstSuccess.cid
        };
      }

      throw new Error('No selected platforms published successfully');
    } catch (err) {
      if (err instanceof Error && err.message !== 'No selected platforms published successfully') {
        for (const platform of platforms) {
          await this.deps.runs.record({
            messageId: message.id,
            platform,
            status: 'failed',
            error: err.message
          });
        }
      }
      throw err;
    }
  }
}

function asBlueskyPlatformPublisher(publisher: BlueskyPublisher): PlatformPublisher {
  return {
    platform: 'bluesky',
    publish: (message) => publisher.publish(message)
  };
}

export async function validateOutboundMessage(message: MessageRecord, validateImage = true): Promise<void> {
  if (countGraphemes(message.body) > MAX_GRAPHEMES) {
    throw new Error('Message must be 300 graphemes or fewer');
  }

  const hasImage = validateImage && Boolean(message.image_path || message.image_content || message.image_public_url);
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
