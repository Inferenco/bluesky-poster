import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { getAvailableImages, selectRandomImage } from './images.js';
import { generatePost } from './generator.js';
import { countGraphemes, hashText } from './validate.js';
import { BlueskyAuth, login, postWithImages } from './bluesky.js';
import { BotState, ScheduleConfig, ensureToday, loadState, recordSuccess, saveState, loadSchedule } from './state.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

async function main() {
  const schedule = await loadSchedule(ROOT);
  const now = new Date();
  const dryRun = String(process.env.DRY_RUN || '').toLowerCase() === 'true';

  let state = await loadState(ROOT);
  state = ensureToday(state, now);

  if (isQuietHours(schedule.quiet_hours_utc, now)) {
    console.log('In quiet hours, exiting');
    return;
  }

  if (state.posted_today_count >= schedule.posts_per_day) {
    console.log('Daily quota reached, exiting');
    return;
  }

  // 1. Get available images and select one randomly
  const images = await getAvailableImages(ROOT);
  const image = selectRandomImage(images);

  if (!image) {
    console.log('No eligible images found in originals folder');
    return;
  }

  console.log(`Selected image: ${image.id}`);

  // 2. Generate post using Nova API
  const generation = await generatePost({ image });

  // 3. Build post text with hashtags
  const hashtagText = generation.hashtags.map(h => `#${h}`).join(' ');
  const fullText = hashtagText ? `${generation.text}\n\n${hashtagText}` : generation.text;

  const textHash = hashText(fullText);
  const postId = buildPostId(textHash);

  // Duplicate check
  if (state.recent_text_hashes.includes(textHash)) {
    console.log('Generated text duplicates recent post; exiting to avoid repeat.');
    return;
  }
  if (state.posted_ids.includes(postId)) {
    console.log('Generated text matches previously posted content; exiting to avoid repeat.');
    return;
  }

  // Use Nova-provided alt text or fallback
  const altText = generation.alt_text || image.defaultAlt;

  const auth = envAuth();

  // Random jitter
  if (schedule.random_jitter_minutes > 0) {
    const jitterMs = Math.floor(Math.random() * schedule.random_jitter_minutes * 60 * 1000);
    if (jitterMs > 0) {
      console.log(`Sleeping for jitter ${Math.round(jitterMs / 1000)}s`);
      await sleep(jitterMs);
    }
  }

  const payload = {
    text: fullText,
    images: [{ asset: image, alt: altText }],
    rkey: postId
  };

  console.log('Ready to post:', {
    id: postId,
    text: fullText,
    graphemes: countGraphemes(fullText),
    image: image.id,
    model: generation.model,
    source: generation.source,
    total_tokens: generation.meta?.total_tokens,
    file_search: generation.meta?.file_search,
    dryRun
  });

  if (dryRun) {
    console.log('Dry run complete - no post created');
    return;
  }

  // 4. Publish to Bluesky
  const agent = await login(auth);
  const result = await postWithImages(agent, payload);

  if (result.alreadyExists) {
    console.log(`Record with rkey ${postId} already exists; marking as posted.`);
  } else {
    console.log(`Posted: ${result.uri}`);
  }

  state = recordSuccess(state, schedule, {
    id: postId,
    textHash,
    imageIds: [image.id],
    when: now
  });

  await saveState(ROOT, state);
  console.log('State updated.');
}

function isQuietHours(range: [string, string], now: Date): boolean {
  const [startStr, endStr] = range;
  const [startH, startM] = startStr.split(':').map(Number);
  const [endH, endM] = endStr.split(':').map(Number);
  const start = startH * 60 + startM;
  const end = endH * 60 + endM;
  const minutes = now.getUTCHours() * 60 + now.getUTCMinutes();

  if (start < end) {
    return minutes >= start && minutes < end;
  }
  // wraps midnight
  return minutes >= start || minutes < end;
}

function envAuth(): BlueskyAuth {
  const identifier = process.env.BSKY_HANDLE || process.env.BSKY_IDENTIFIER;
  const password = process.env.BSKY_APP_PASSWORD || process.env.BSKY_PASSWORD;
  if (!identifier || !password) {
    throw new Error('Missing BSKY_HANDLE/BSKY_APP_PASSWORD');
  }
  return { identifier, password };
}

function buildPostId(textHash: string): string {
  const raw = textHash.startsWith('sha256:') ? textHash.slice('sha256:'.length) : textHash;
  const cleaned = raw.replace(/[^a-z0-9]/gi, '');
  return cleaned || Date.now().toString(36);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
