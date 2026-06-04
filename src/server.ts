import { setTimeout as sleep } from 'node:timers/promises';
import { buildApp } from './app.js';
import { AtprotoBlueskyPublisher, getAgent } from './bluesky.js';
import { loadConfig } from './config.js';
import { createPool } from './db/client.js';
import { MastodonPublisher } from './mastodon.js';
import { AssetsRepository } from './repositories/assets.js';
import { PgLockRepository } from './repositories/locks.js';
import { MessagesRepository } from './repositories/messages.js';
import { RunsRepository } from './repositories/runs.js';
import { SettingsRepository } from './repositories/settings.js';
import { OpenAIInferencoPostGenerator } from './services/postGenerator.js';
import { PosterService, type PlatformPublisher } from './services/poster.js';
import { SchedulerService } from './services/scheduler.js';

const SCHEDULER_POLL_MS = 15_000;

async function main(): Promise<void> {
  const config = loadConfig();
  const pool = createPool(config.databaseUrl);
  const messages = new MessagesRepository(pool);
  const assets = new AssetsRepository(pool);
  const settings = new SettingsRepository(pool);
  const runs = new RunsRepository(pool);
  const locks = new PgLockRepository(pool);

  let blueskyPublisher: PlatformPublisher;
  if (config.bluesky.identifier && config.bluesky.appPassword) {
    try {
      const agent = await getAgent({
        identifier: config.bluesky.identifier,
        password: config.bluesky.appPassword,
        serviceUrl: config.bluesky.serviceUrl
      });
      blueskyPublisher = {
        platform: 'bluesky',
        publish: (message) => new AtprotoBlueskyPublisher(agent).publish(message)
      };
      console.log('Bluesky login successful');
    } catch (err) {
      console.error('Bluesky login failed — server will start but posting is disabled:', err instanceof Error ? err.message : err);
      blueskyPublisher = { platform: 'bluesky', async publish() { throw new Error('Bluesky login failed at startup — check credentials'); } };
    }
  } else {
    console.warn('BSKY_IDENTIFIER / BSKY_APP_PASSWORD not set — posting disabled');
    blueskyPublisher = { platform: 'bluesky', async publish() { throw new Error('Missing BSKY_IDENTIFIER/BSKY_APP_PASSWORD'); } };
  }

  const publishers: PlatformPublisher[] = [blueskyPublisher];
  if (config.mastodon.instanceUrl && config.mastodon.accessToken) {
    publishers.push(new MastodonPublisher({
      instanceUrl: config.mastodon.instanceUrl,
      accessToken: config.mastodon.accessToken,
      visibility: config.mastodon.visibility
    }));
  }

  const poster = new PosterService({ publishers, runs, dryRun: config.dryRun });
  const scheduler = new SchedulerService({
    settings,
    locks,
    messages,
    runs,
    poster,
    random: Math.random,
    now: () => new Date()
  });

  const app = await buildApp({
    config,
    repositories: {
      messages,
      assets,
      settings,
      runs
    },
    postGenerator: config.ai.openaiApiKey
      ? new OpenAIInferencoPostGenerator({
          apiKey: config.ai.openaiApiKey,
          model: config.ai.openaiPostModel
        })
      : undefined
  });

  await app.listen({ host: '0.0.0.0', port: config.port });
  void schedulerLoop(scheduler);
}

async function schedulerLoop(scheduler: SchedulerService): Promise<void> {
  while (true) {
    try {
      const result = await scheduler.runOnce();
      if (result.status === 'posted') {
        console.log(`[scheduler] posted message ${result.messageId}`);
      } else if (result.status === 'skipped' && result.reason !== 'not_due') {
        console.log(`[scheduler] skipped — ${result.reason}`);
      }
    } catch (err) {
      console.error('[scheduler] error:', err instanceof Error ? err.message : err);
    }
    await sleep(SCHEDULER_POLL_MS);
  }
}

main().catch((err) => {
  console.error('Fatal startup error:', err instanceof Error ? err.message : err);
  process.exit(1);
});
