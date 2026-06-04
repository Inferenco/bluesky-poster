import type { MastodonVisibility } from './config.js';
import type { MessageRecord } from './repositories/messages.js';
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

export class MastodonPublisher implements PlatformPublisher {
  readonly platform = 'mastodon' as const;
  private readonly instanceUrl: string;
  private readonly fetcher: typeof fetch;

  constructor(private readonly options: MastodonPublisherOptions) {
    this.instanceUrl = options.instanceUrl.replace(/\/+$/, '');
    this.fetcher = options.fetcher ?? fetch;
  }

  async publish(message: MessageRecord): Promise<{ uri: string | null; cid: string | null; url: string | null }> {
    const body = new URLSearchParams();
    body.set('status', buildMastodonStatus(message));
    body.set('visibility', this.options.visibility);

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
}

function buildMastodonStatus(message: MessageRecord): string {
  const tags = message.tags.slice(0, 8).filter(Boolean);
  const tagSuffix = tags.length > 0 ? '\n\n' + tags.map((tag) => `#${tag}`).join(' ') : '';
  const publicUrlSuffix = message.image_public_url ? `\n\n${message.image_public_url}` : '';
  return `${message.body}${tagSuffix}${publicUrlSuffix}`;
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
