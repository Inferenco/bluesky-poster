import path from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { buildApp } from '../../src/app.js';
import { createPool } from '../../src/db/client.js';
import { migrate } from '../../src/db/migrate.js';
import { AssetsRepository } from '../../src/repositories/assets.js';
import { PgLockRepository } from '../../src/repositories/locks.js';
import { MessagesRepository } from '../../src/repositories/messages.js';
import { RunsRepository } from '../../src/repositories/runs.js';
import { SettingsRepository } from '../../src/repositories/settings.js';
import { PosterService } from '../../src/services/poster.js';
import { SchedulerService } from '../../src/services/scheduler.js';

const databaseUrl = process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;
const auth = `Basic ${Buffer.from('admin:secret').toString('base64')}`;

describeIfDb('Postgres-backed app flow', () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = createPool(databaseUrl as string);
    await migrate(databaseUrl);
    await pool.query('truncate post_runs, messages, assets restart identity cascade');
    await pool.query("update scheduler_state set enabled = true, min_interval_minutes = 1, max_interval_minutes = 2, next_run_at = '2026-05-29T12:00:00.000Z' where singleton_key = 'poster'");
  });

  afterAll(async () => {
    await pool?.end();
  });

  test('creates dashboard messages and records a dry-run scheduler attempt', async () => {
    const messages = new MessagesRepository(pool, () => 'msg-postgres-1');
    let assetCounter = 0;
    const assets = new AssetsRepository(pool, () => `asset-postgres-${++assetCounter}`);
    const settings = new SettingsRepository(pool);
    const runs = new RunsRepository(pool, () => 'run-postgres-1');

    const app = await buildApp({
      config: { dashboard: { user: 'admin', password: 'secret' } },
      repositories: { messages, assets, settings, runs }
    });

    const assetPath = path.join(process.cwd(), 'assets/images/originals/Nova1.jpg');
    const assetResponse = await app.inject({
      method: 'POST',
      url: '/assets',
      headers: { authorization: auth, 'content-type': 'application/x-www-form-urlencoded' },
      payload: `pathOrObjectKey=${encodeURIComponent(assetPath)}&altTextDefault=Nova%20integration%20asset`
    });
    expect(assetResponse.statusCode).toBe(302);

    const assetPath2 = path.join(process.cwd(), 'assets/images/originals/Nova1.jpg');
    const secondAssetResponse = await app.inject({
      method: 'POST',
      url: '/assets',
      headers: { authorization: auth, 'content-type': 'application/x-www-form-urlencoded' },
      payload: `pathOrObjectKey=${encodeURIComponent(assetPath2)}&altTextDefault=Uploaded%20Postgres%20asset`
    });
    expect(secondAssetResponse.statusCode).toBe(302);

    const createResponse = await app.inject({
      method: 'POST',
      url: '/messages',
      headers: { authorization: auth, 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'body=Postgres%20backed%20message&status=approved&imageAssetId=asset-postgres-2'
    });
    expect(createResponse.statusCode).toBe(302);
    const saved = await messages.get('msg-postgres-1');
    expect(saved).toMatchObject({
      image_asset_id: 'asset-postgres-2',
      image_alt: 'Uploaded Postgres asset',
      image_mime_type: 'image/jpeg'
    });
    expect(saved?.image_content).toBeNull();

    const scheduler = new SchedulerService({
      settings,
      locks: new PgLockRepository(pool),
      messages,
      runs,
      poster: new PosterService({
        dryRun: true,
        runs,
        publisher: {
          async publish() {
            throw new Error('Dry run must not call Bluesky');
          }
        }
      }),
      random: () => 0,
      now: () => new Date('2026-05-29T12:00:00.000Z')
    });

    const result = await scheduler.runOnce();

    expect(result).toEqual({ status: 'posted', messageId: 'msg-postgres-1' });
    const history = await runs.list();
    expect(history).toMatchObject([{ id: 'run-postgres-1', message_id: 'msg-postgres-1', status: 'dry_run' }]);
    const page = await app.inject({ method: 'GET', url: '/runs', headers: { authorization: auth } });
    expect(page.body).toContain('dry_run');

    await app.close();
  });
});
