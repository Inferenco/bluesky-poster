import { AtprotoBlueskyPublisher, getAgent } from '../bluesky.js';
import type { MessageRecord } from '../repositories/messages.js';
import { validateOutboundMessage } from '../services/poster.js';
import { hashText } from '../validate.js';

const CONFIRMATION = 'I_UNDERSTAND_THIS_WILL_POST_TO_BLUESKY';

async function main(): Promise<void> {
  if (process.env.CONFIRM_LIVE_POST !== CONFIRMATION) {
    throw new Error(`Refusing to post. Set CONFIRM_LIVE_POST=${CONFIRMATION} to create a real Bluesky post.`);
  }

  const identifier = process.env.BSKY_IDENTIFIER ?? process.env.BSKY_HANDLE;
  const password = process.env.BSKY_APP_PASSWORD ?? process.env.BSKY_PASSWORD;
  const serviceUrl = process.env.BSKY_SERVICE_URL ?? 'https://bsky.social';

  if (!identifier || !password) {
    throw new Error('Missing BSKY_IDENTIFIER/BSKY_HANDLE or BSKY_APP_PASSWORD/BSKY_PASSWORD');
  }

  const body = process.env.LIVE_TEST_TEXT?.trim() || `Live test from bluesky-poster at ${new Date().toISOString()}`;
  const message = makeMessage(body);
  await validateOutboundMessage(message);

  const agent = await getAgent({ identifier, password, serviceUrl });
  const result = await new AtprotoBlueskyPublisher(agent).publish(message);

  console.log(`Created Bluesky post: ${result.uri}`);
  console.log(`CID: ${result.cid}`);
}

function makeMessage(body: string): MessageRecord {
  const now = new Date().toISOString();
  return {
    id: `live-test-${Date.now()}`,
    body,
    status: 'approved',
    weight: 100,
    cooldown_hours: 0,
    tags: [],
    self_labels: [],
    image_asset_id: null,
    image_path: null,
    image_alt: null,
    image_content: null,
    image_mime_type: null,
    normalised_hash: hashText(body),
    last_posted_at: null,
    post_count: 0,
    created_at: now,
    updated_at: now
  };
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
