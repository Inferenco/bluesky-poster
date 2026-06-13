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
import { getPostgresTestDatabaseUrl } from './databaseSafety.js';

const databaseUrl = getPostgresTestDatabaseUrl();
const describeIfDb = databaseUrl ? describe : describe.skip;

const ADMIN_ADDRESS = '0xbdf9c94e797716648980ed99a0c6e2b3d6452ce5c1d28dbad3517a9be682b724';

const testConfig = {
  auth: {
    cedraFullnodeUrl: 'http://unused.example',
    adminContractAddress: '0x1',
    adminCacheTtlMs: 60_000,
    adminViewTimeoutMs: 5_000,
    secureCookies: false
  }
};

async function loginCookie(app: Awaited<ReturnType<typeof buildApp>>): Promise<string> {
  const nonceRes = await app.inject({ method: 'GET', url: '/api/auth/nonce' });
  const setCookie = nonceRes.headers['set-cookie'];
  const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)?.split(';')[0];
  if (!cookie) throw new Error('nonce response did not set a session cookie');
  const { nonce } = nonceRes.json() as { nonce: string };
  const verifyRes = await app.inject({
    method: 'POST',
    url: '/api/auth/verify',
    headers: { cookie, 'content-type': 'application/json' },
    payload: {
      address: ADMIN_ADDRESS,
      publicKey: '0x' + '00'.repeat(32),
      signature: '0x' + '00'.repeat(64),
      message: 'test',
      nonce,
      fullMessage: 'test'
    }
  });
  if (verifyRes.statusCode !== 200) {
    throw new Error(`login failed with ${verifyRes.statusCode}: ${verifyRes.body}`);
  }
  const verifyCookie = verifyRes.headers['set-cookie'];
  return (Array.isArray(verifyCookie) ? verifyCookie[0] : verifyCookie)?.split(';')[0] ?? cookie;
}

describeIfDb('Postgres-backed app flow', () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    if (!databaseUrl) throw new Error('POSTGRES_TEST_DATABASE_URL is required for Postgres integration tests');
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
      config: testConfig,
      repositories: { messages, assets, settings, runs },
      auth: {
        fetchAdmins: async () => [ADMIN_ADDRESS],
        verifySignature: () => true
      }
    });
    const cookie = await loginCookie(app);

    const assetPath = path.join(process.cwd(), 'assets/images/originals/Nova1.jpg');
    const assetResponse = await app.inject({
      method: 'POST',
      url: '/assets',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: `pathOrObjectKey=${encodeURIComponent(assetPath)}&altTextDefault=Nova%20integration%20asset`
    });
    expect(assetResponse.statusCode).toBe(302);

    const assetPath2 = path.join(process.cwd(), 'assets/images/originals/Nova1.jpg');
    const secondAssetResponse = await app.inject({
      method: 'POST',
      url: '/assets',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: `pathOrObjectKey=${encodeURIComponent(assetPath2)}&altTextDefault=Uploaded%20Postgres%20asset`
    });
    expect(secondAssetResponse.statusCode).toBe(302);

    const createResponse = await app.inject({
      method: 'POST',
      url: '/messages',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
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
    const page = await app.inject({ method: 'GET', url: '/runs', headers: { cookie } });
    expect(page.body).toContain('dry_run');

    await app.close();
  });
});
