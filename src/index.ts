import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { loadQueue, selectNext } from './queue.js';
import { loadManifest, selectImages } from './images.js';
import { generatePost } from './generator.js';
import { MAX_GRAPHEMES, countGraphemes, hashText } from './validate.js';
import { BlueskyAuth, login, postWithImages } from './bluesky.js';
import { BotState, ScheduleConfig, ensureToday, loadState, recordSuccess, saveState } from './state.js';
import { checkSafety } from './safety.js';
import { sendTelegramNotification } from './notify.js';

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

  const queue = await loadQueue(ROOT);
  const selection = selectNext(queue, state.posted_ids);
  if (!selection) {
    console.log('No active queue items to post');
    return;
  }

  const { item: next, isRecycled } = selection;
  if (isRecycled) {
    console.log(`Recycling topic "${next.id}" for fresh content generation`);
  }

  const manifest = await loadManifest(ROOT);
  const images = selectImages(manifest, {
    requestedIds: next.imageIds,
    tags: next.tags,
    defaultImagesPerPost: schedule.default_images_per_post,
    maxImagesPerPost: schedule.max_images_per_post,
    recentImageIds: state.recent_image_ids
  });

  if (images.length === 0) {
    console.log('No eligible images found (<1MB)');
    return;
  }
  await verifyImageSizes(images);

  const voice = await fs.readFile(path.join(ROOT, 'config', 'voice.md'), 'utf8');
  const generation = await generatePost({ voice, item: next, images });

  // Safety check
  const safetyResult = await checkSafety(ROOT, generation.text);
  if (!safetyResult.safe) {
    const errorMsg = `Generated text contains blocked phrase: "${safetyResult.blockedPhrase}"`;
    console.error(errorMsg);
    await sendTelegramNotification({
      success: false,
      postId: next.id,
      error: errorMsg,
      dryRun
    });
    return;
  }

  const textHash = hashText(generation.text);
  if (state.recent_text_hashes.includes(textHash)) {
    console.log('Generated text duplicates recent post; exiting to avoid repeat.');
    return;
  }

  const finalAlt = generation.alt_overrides && generation.alt_overrides.length === images.length
    ? generation.alt_overrides
    : images.map((img) => img.defaultAlt);

  const auth = envAuth();

  if (schedule.random_jitter_minutes > 0) {
    const jitterMs = Math.floor(Math.random() * schedule.random_jitter_minutes * 60 * 1000);
    if (jitterMs > 0) {
      console.log(`Sleeping for jitter ${Math.round(jitterMs / 1000)}s`);
      await sleep(jitterMs);
    }
  }

  const payload = {
    text: generation.text,
    images: images.map((img, idx) => ({ asset: img, alt: finalAlt[idx] })),
    rkey: next.id
  };

  console.log('Ready to post:', {
    id: next.id,
    text: generation.text,
    graphemes: countGraphemes(generation.text),
    images: images.map((i) => i.id),
    model: generation.model,
    total_tokens: generation.meta?.total_tokens,
    file_search: generation.meta?.file_search,
    dryRun
  });

  if (dryRun) {
    await sendTelegramNotification({
      success: true,
      postId: next.id,
      postText: generation.text,
      dryRun: true
    });
    return;
  }

  const agent = await login(auth);
  const result = await postWithImages(agent, payload);

  if (result.alreadyExists) {
    console.log(`Record with rkey ${next.id} already exists; marking as posted.`);
  } else {
    console.log(`Posted: ${result.uri}`);
  }

  state = recordSuccess(state, schedule, {
    id: next.id,
    textHash,
    imageIds: images.map((i) => i.id),
    when: now
  });

  await saveState(ROOT, state);
  console.log('State updated.');

  // Send success notification
  await sendTelegramNotification({
    success: true,
    postId: next.id,
    postText: generation.text,
    dryRun: false
  });
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

async function loadSchedule(root: string): Promise<ScheduleConfig> {
  const raw = await fs.readFile(path.join(root, 'config', 'schedule.json'), 'utf8');
  const parsed = JSON.parse(raw) as ScheduleConfig;
  return parsed;
}

function envAuth(): BlueskyAuth {
  const identifier = process.env.BSKY_HANDLE || process.env.BSKY_IDENTIFIER;
  const password = process.env.BSKY_APP_PASSWORD || process.env.BSKY_PASSWORD;
  if (!identifier || !password) {
    throw new Error('Missing BSKY_HANDLE/BSKY_APP_PASSWORD');
  }
  return { identifier, password };
}

async function verifyImageSizes(images: { path: string }[]): Promise<void> {
  const maxBytes = 1_000_000;
  for (const img of images) {
    const filePath = path.join(process.cwd(), img.path);
    const stat = await fs.stat(filePath);
    if (stat.size > maxBytes) {
      throw new Error(`Image ${img.path} is ${stat.size} bytes (>1,000,000)`);
    }
  }
}

main().catch(async (err) => {
  console.error(err);
  await sendTelegramNotification({
    success: false,
    error: String(err)
  });
  process.exitCode = 1;
});
