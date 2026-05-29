import { getAgent } from '../bluesky.js';

async function main(): Promise<void> {
  const identifier = process.env.BSKY_IDENTIFIER ?? process.env.BSKY_HANDLE;
  const password = process.env.BSKY_APP_PASSWORD ?? process.env.BSKY_PASSWORD;
  const serviceUrl = process.env.BSKY_SERVICE_URL ?? 'https://bsky.social';

  if (!identifier || !password) {
    throw new Error('Missing BSKY_IDENTIFIER/BSKY_HANDLE or BSKY_APP_PASSWORD/BSKY_PASSWORD');
  }

  const agent = await getAgent({ identifier, password, serviceUrl });
  const handle = agent.session?.handle ?? identifier;
  const did = agent.session?.did ?? agent.did ?? 'unknown';
  console.log(`Bluesky session OK for ${handle} (${did})`);
  console.log('No post was created.');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
