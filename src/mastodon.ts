import type { MastodonVisibility } from './config.js';
import type { MessageRecord } from './repositories/messages.js';
import { downloadObject } from './replit_integrations/object_storage.js';
import type { PlatformPublisher } from './services/poster.js';

export interface MastodonPublisherOptions {
  instanceUrl: string;
  accessToken: string;
  visibility: MastodonVisibility;
  fetcher?: typeof fetch;
}

interface MastodonStatusResponse {
  uri?: unknown;
  url?: unknown;
}

interface MastodonMediaResponse {
  id?: unknown;
}

export class MastodonPublisher implements PlatformPublisher {
  readonly platform = 'mastodon' as const;
  private readonly instanceUrl: string;
  private readonly fetcher: typeof fetch;

  constructor(private readonly options: MastodonPublisherOptions) {
    this.instanceUrl = options.instanceUrl.replace(/\/+$/, '');
    this.fetcher = options.fetcher ?? fetch;
  }

  async publish(message: MessageRecord): Promise<{ uri: string | null; cid: string | null; url: string | null }> {
    const mediaId = hasUploadableMedia(message)
      ? await this.uploadMedia(message)
      : null;
    const body = new URLSearchParams();
    body.set('status', buildMastodonStatus(message));
    body.set('visibility', this.options.visibility);
    if (mediaId) {
      body.append('media_ids[]', mediaId);
    }

    const response = await this.fetcher(`${this.instanceUrl}/api/v1/statuses`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.options.accessToken}`
      },
      body
    });

    if (!response.ok) {
      throw new Error(`Mastodon post failed: ${response.status} ${await mastodonErrorMessage(response)}`);
    }

    const payload = await response.json() as MastodonStatusResponse;
    const uri = typeof payload.uri === 'string' ? payload.uri : null;
    const url = typeof payload.url === 'string' ? payload.url : uri;
    return { uri, cid: null, url };
  }

  private async uploadMedia(message: MessageRecord): Promise<string> {
    const media = await loadMedia(message, this.fetcher);
    const form = new FormData();
    form.set('file', new File([new Blob([media.data], { type: media.contentType })], media.fileName, { type: media.contentType }));
    if (message.image_alt?.trim()) {
      form.set('description', message.image_alt.trim());
    }

    const uploadResponse = await this.fetcher(`${this.instanceUrl}/api/v2/media`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.options.accessToken}`
      },
      body: form
    });

    if (!uploadResponse.ok) {
      throw new Error(`Mastodon media upload failed: ${uploadResponse.status} ${await mastodonErrorMessage(uploadResponse)}`);
    }

    const payload = await uploadResponse.json() as MastodonMediaResponse;
    if (typeof payload.id !== 'string' || !payload.id) {
      throw new Error('Mastodon media upload response did not include an id');
    }
    return payload.id;
  }
}

function hasUploadableMedia(message: MessageRecord): boolean {
  return Boolean(message.image_object_key || message.image_public_url);
}

async function loadMedia(message: MessageRecord, fetcher: typeof fetch): Promise<{ data: Buffer; contentType: string; fileName: string }> {
  if (message.image_object_key) {
    const data = await downloadObject(message.image_object_key);
    return {
      data,
      contentType: message.image_mime_type ?? 'application/octet-stream',
      fileName: fileNameFromPath(message.image_object_key)
    };
  }

  const mediaUrl = message.image_public_url ?? '';
  const mediaResponse = await fetcher(mediaUrl);
  if (!mediaResponse.ok) {
    throw new Error(`Failed to fetch Mastodon media: ${mediaResponse.status}`);
  }

  return {
    data: Buffer.from(await mediaResponse.arrayBuffer()),
    contentType: mediaResponse.headers.get('content-type') ?? message.image_mime_type ?? 'application/octet-stream',
    fileName: fileNameFromUrl(mediaUrl)
  };
}

function buildMastodonStatus(message: MessageRecord): string {
  const tags = message.tags.slice(0, 8).filter(Boolean);
  const tagSuffix = tags.length > 0 ? '\n\n' + tags.map((tag) => `#${tag}`).join(' ') : '';
  return `${message.body}${tagSuffix}`;
}

function fileNameFromUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    const name = url.pathname.split('/').filter(Boolean).at(-1);
    return name || 'mastodon-media';
  } catch {
    return 'mastodon-media';
  }
}

function fileNameFromPath(rawPath: string): string {
  const name = rawPath.split('/').filter(Boolean).at(-1);
  return name || 'mastodon-media';
}

async function mastodonErrorMessage(response: Response): Promise<string> {
  const raw = await response.text();
  try {
    const parsed = JSON.parse(raw) as { error?: unknown };
    if (typeof parsed.error === 'string') return parsed.error;
  } catch {
    // Keep the raw body below.
  }
  return raw;
}
