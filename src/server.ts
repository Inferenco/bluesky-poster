import { setTimeout as sleep } from 'node:timers/promises';
import { buildApp } from './app.js';
import { AtprotoBlueskyPublisher, getAgent } from './bluesky.js';
import { loadConfig } from './config.js';
import { createPool } from './db/client.js';
import { AssetsRepository } from './repositories/assets.js';
import { PgLockRepository } from './repositories/locks.js';
import { MessagesRepository } from './repositories/messages.js';
import { RunsRepository } from './repositories/runs.js';
import { SettingsRepository } from './repositories/settings.js';
import { PosterService } from './services/poster.js';
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

  const publisher = config.bluesky.identifier && config.bluesky.appPassword
    ? new AtprotoBlueskyPublisher(await getAgent({
      identifier: config.bluesky.identifier,
      password: config.bluesky.appPassword,
      serviceUrl: config.bluesky.serviceUrl
    }))
    : {
      async publish() {
        throw new Error('Missing BSKY_IDENTIFIER/BSKY_APP_PASSWORD');
      }
    };

  const poster = new PosterService({ publisher, runs, dryRun: config.dryRun });
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
    }
  });

  await app.listen({ host: '0.0.0.0', port: config.port });
  void schedulerLoop(scheduler);
}

async function schedulerLoop(scheduler: SchedulerService): Promise<void> {
  while (true) {
    try {
      await scheduler.runOnce();
    } catch (err) {
      console.error(err);
    }
    await sleep(SCHEDULER_POLL_MS);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
