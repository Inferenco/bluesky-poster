import { describe, expect, test } from 'vitest';
import FormData from 'form-data';
import sharp from 'sharp';
import { buildApp, type AppRepositories } from '../app.js';
import type { AssetRecord } from '../repositories/assets.js';
import type { MessageRecord, MessageStatus } from '../repositories/messages.js';

const auth = `Basic ${Buffer.from('admin:secret').toString('base64')}`;

function makeMessage(overrides: Partial<MessageRecord> = {}): MessageRecord {
  return {
    id: overrides.id ?? 'msg-1',
    body: overrides.body ?? 'Hello Bluesky',
    status: overrides.status ?? 'draft',
    weight: overrides.weight ?? 100,
    cooldown_hours: overrides.cooldown_hours ?? 168,
    tags: overrides.tags ?? [],
    self_labels: overrides.self_labels ?? [],
    image_asset_id: overrides.image_asset_id ?? null,
    image_path: overrides.image_path ?? null,
    image_alt: overrides.image_alt ?? null,
    normalised_hash: overrides.normalised_hash ?? 'sha256:one',
    last_posted_at: overrides.last_posted_at ?? null,
    post_count: overrides.post_count ?? 0,
    created_at: overrides.created_at ?? new Date('2026-05-29T10:00:00.000Z'),
    updated_at: overrides.updated_at ?? new Date('2026-05-29T10:00:00.000Z')
  };
}

function repositories(): AppRepositories {
  const messages = new Map<string, MessageRecord>();
  const assets = new Map<string, AssetRecord>();
  const settings = {
    enabled: true,
    timezone: 'UTC',
    minIntervalMinutes: 60,
    maxIntervalMinutes: 180,
    quietHours: [],
    nextRunAt: null as Date | null
  };

  return {
    messages: {
      list: async () => Array.from(messages.values()),
      get: async (id) => messages.get(id) ?? null,
      create: async (input) => {
        const message = makeMessage({
          id: `msg-${messages.size + 1}`,
          body: input.body,
          status: input.status,
          weight: input.weight,
          cooldown_hours: input.cooldownHours,
          tags: input.tags,
          image_asset_id: input.imageAssetId,
          image_path: input.imagePath,
          image_alt: input.imageAlt
        });
        messages.set(message.id, message);
        return message;
      },
      update: async (id, input) => {
        const current = messages.get(id);
        if (!current) throw new Error('message not found');
        const updated = {
          ...current,
          body: input.body ?? current.body,
          status: input.status ?? current.status,
          weight: input.weight ?? current.weight,
          cooldown_hours: input.cooldownHours ?? current.cooldown_hours,
          tags: input.tags ?? current.tags,
          image_asset_id: input.imageAssetId ?? current.image_asset_id,
          image_path: input.imagePath ?? current.image_path,
          image_alt: input.imageAlt ?? current.image_alt
        };
        messages.set(id, updated);
        return updated;
      },
      setStatus: async (id, status: MessageStatus) => {
        const current = messages.get(id);
        if (!current) throw new Error('message not found');
        messages.set(id, { ...current, status });
      },
      delete: async (id) => {
        messages.delete(id);
      }
    },
    assets: {
      list: async () => Array.from(assets.values()),
      registerLocalImage: async (input) => {
        const asset: AssetRecord = {
          id: `asset-${assets.size + 1}`,
          storage_kind: 'local',
          path_or_object_key: input.pathOrObjectKey,
          public_url: null,
          content: null,
          mime_type: 'image/jpeg',
          width: 10,
          height: 10,
          bytes: 100,
          alt_text_default: input.altTextDefault,
          created_at: new Date('2026-05-29T10:00:00.000Z')
        };
        assets.set(asset.id, asset);
        return asset;
      },
      registerImageBuffer: async (input) => {
        const asset: AssetRecord = {
          id: `asset-${assets.size + 1}`,
          storage_kind: 'database',
          path_or_object_key: null,
          public_url: null,
          content: input.content,
          mime_type: 'image/jpeg',
          width: 10,
          height: 10,
          bytes: input.content.length,
          alt_text_default: input.altTextDefault,
          created_at: new Date('2026-05-29T10:00:00.000Z')
        };
        assets.set(asset.id, asset);
        return asset;
      },
      registerObjectStorageImage: async (input) => {
        const asset: AssetRecord = {
          id: `asset-${assets.size + 1}`,
          storage_kind: 'object_storage',
          path_or_object_key: input.objectKey,
          public_url: input.publicUrl,
          content: null,
          mime_type: input.mimeType,
          width: input.width,
          height: input.height,
          bytes: input.bytes,
          alt_text_default: input.altTextDefault,
          created_at: new Date('2026-05-29T10:00:00.000Z')
        };
        assets.set(asset.id, asset);
        return asset;
      },
      delete: async (id) => {
        assets.delete(id);
      }
    },
    settings: {
      getDashboardSettings: async () => settings,
      updateDashboardSettings: async (input) => {
        settings.enabled = input.enabled;
        settings.minIntervalMinutes = input.minIntervalMinutes;
        settings.maxIntervalMinutes = input.maxIntervalMinutes;
        return settings;
      }
    },
    runs: {
      list: async () => []
    }
  };
}

describe('dashboard routes', () => {
  test('readiness reports database repository failures', async () => {
    const repos = repositories();
    repos.settings.getDashboardSettings = async () => {
      throw new Error('database unavailable');
    };
    const app = await buildApp({
      config: { dashboard: { user: 'admin', password: 'secret' } },
      repositories: repos
    });

    const response = await app.inject({ method: 'GET', url: '/readyz' });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ ok: false });
    await app.close();
  });

  test('requires authentication for dashboard pages', async () => {
    const app = await buildApp({
      config: { dashboard: { user: 'admin', password: 'secret' } },
      repositories: repositories()
    });

    const response = await app.inject({ method: 'GET', url: '/messages' });

    expect(response.statusCode).toBe(401);
    await app.close();
  });

  test('creates, edits, and pauses a message', async () => {
    const repos = repositories();
    const app = await buildApp({
      config: { dashboard: { user: 'admin', password: 'secret' } },
      repositories: repos
    });

    const created = await app.inject({
      method: 'POST',
      url: '/messages',
      headers: { authorization: auth, 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'body=First%20message&status=approved&weight=250&cooldownHours=12&tags=launch,updates&imagePath=assets/post.jpg&imageAlt=Launch%20image'
    });
    expect(created.statusCode).toBe(302);

    const edited = await app.inject({
      method: 'POST',
      url: '/messages/msg-1',
      headers: { authorization: auth, 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'body=Edited%20message&weight=150&cooldownHours=24&tags=edited'
    });
    expect(edited.statusCode).toBe(302);

    const paused = await app.inject({
      method: 'POST',
      url: '/messages/msg-1/status',
      headers: { authorization: auth, 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'status=paused'
    });
    expect(paused.statusCode).toBe(302);

    const list = await app.inject({ method: 'GET', url: '/messages', headers: { authorization: auth } });
    expect(list.body).toContain('Edited message');
    expect(list.body).toContain('paused');
    expect(list.body).toContain('150');
    expect(list.body).toContain('24h');
    await app.close();
  });

  test('registers assets and offers them on message forms', async () => {
    const app = await buildApp({
      config: { dashboard: { user: 'admin', password: 'secret' } },
      repositories: repositories()
    });

    const created = await app.inject({
      method: 'POST',
      url: '/assets',
      headers: { authorization: auth, 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'pathOrObjectKey=assets%2Fimages%2Foriginals%2FNova1.jpg&altTextDefault=Nova%20portrait'
    });

    expect(created.statusCode).toBe(302);
    const assets = await app.inject({ method: 'GET', url: '/assets', headers: { authorization: auth } });
    expect(assets.body).toContain('Nova portrait');

    const form = await app.inject({ method: 'GET', url: '/messages/new', headers: { authorization: auth } });
    expect(form.body).toContain('asset-1');
    expect(form.body).toContain('Nova portrait');

    await app.close();
  });

  test('saves object storage asset record via JSON upload endpoint', async () => {
    const app = await buildApp({
      config: { dashboard: { user: 'admin', password: 'secret' } },
      repositories: repositories()
    });

    const response = await app.inject({
      method: 'POST',
      url: '/assets/upload',
      headers: { authorization: auth, 'content-type': 'application/json', 'x-replit-user-id': '123' },
      payload: JSON.stringify({
        objectKey: 'public/uploads/test-uuid.jpg',
        mimeType: 'image/jpeg',
        altTextDefault: 'Uploaded dashboard asset',
        width: 3,
        height: 3,
        bytes: 1234
      })
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
    const assets = await app.inject({ method: 'GET', url: '/assets', headers: { authorization: auth, 'x-replit-user-id': '123' } });
    expect(assets.body).toContain('Uploaded dashboard asset');
    expect(assets.body).toContain('object_storage');

    await app.close();
  });

  test('updates scheduler settings', async () => {
    const app = await buildApp({
      config: { dashboard: { user: 'admin', password: 'secret' } },
      repositories: repositories()
    });

    const response = await app.inject({
      method: 'POST',
      url: '/settings',
      headers: { authorization: auth, 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'enabled=on&minIntervalMinutes=30&maxIntervalMinutes=90'
    });

    expect(response.statusCode).toBe(302);
    const settings = await app.inject({ method: 'GET', url: '/settings', headers: { authorization: auth } });
    expect(settings.body).toContain('value="30"');
    expect(settings.body).toContain('value="90"');
    await app.close();
  });

  test.each([
    ['empty minimum', 'enabled=on&minIntervalMinutes=&maxIntervalMinutes=90'],
    ['non-integer minimum', 'enabled=on&minIntervalMinutes=1.5&maxIntervalMinutes=90'],
    ['zero minimum', 'enabled=on&minIntervalMinutes=0&maxIntervalMinutes=90'],
    ['negative maximum', 'enabled=on&minIntervalMinutes=30&maxIntervalMinutes=-1'],
    ['maximum below minimum', 'enabled=on&minIntervalMinutes=90&maxIntervalMinutes=30']
  ])('rejects invalid scheduler settings: %s', async (_name, payload) => {
    const repos = repositories();
    let updateCalls = 0;
    const originalUpdate = repos.settings.updateDashboardSettings;
    repos.settings.updateDashboardSettings = async (input) => {
      updateCalls += 1;
      return originalUpdate(input);
    };
    const app = await buildApp({
      config: { dashboard: { user: 'admin', password: 'secret' } },
      repositories: repos
    });

    const response = await app.inject({
      method: 'POST',
      url: '/settings',
      headers: { authorization: auth, 'content-type': 'application/x-www-form-urlencoded' },
      payload
    });

    expect(response.statusCode).toBe(400);
    expect(response.body).toContain('Intervals must be positive whole minutes, and maximum must be greater than or equal to minimum.');
    expect(updateCalls).toBe(0);
    await app.close();
  });
});
