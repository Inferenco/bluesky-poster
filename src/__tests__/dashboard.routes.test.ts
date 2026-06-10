import { vi, describe, expect, test } from 'vitest';
import FormData from 'form-data';
import sharp from 'sharp';
import type { FastifyInstance } from 'fastify';
import { buildApp, type AppRepositories } from '../app.js';
import type { SignatureVerifier } from '../auth/cedraAuth.js';
import type { AssetRecord } from '../repositories/assets.js';
import type { MessageRecord, MessageStatus } from '../repositories/messages.js';
import type { PostGenerator } from '../services/postGenerator.js';

vi.mock('../replit_integrations/object_storage.js', () => ({
  uploadBuffer: vi.fn().mockResolvedValue({
    objectKey: 'uploads/test-uuid.png',
    publicUrl: 'https://storage.googleapis.com/test-bucket/uploads/test-uuid.png'
  }),
  downloadObject: vi.fn().mockResolvedValue(Buffer.from('preview-bytes'))
}));

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

function extractSessionCookie(setCookie: string | string[] | undefined): string | null {
  if (!setCookie) return null;
  const raw = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  return raw.split(';')[0];
}

async function loginCookie(app: FastifyInstance, address = ADMIN_ADDRESS): Promise<string> {
  const nonceRes = await app.inject({ method: 'GET', url: '/api/auth/nonce' });
  const cookie = extractSessionCookie(nonceRes.headers['set-cookie']);
  if (!cookie) throw new Error('nonce response did not set a session cookie');
  const { nonce } = nonceRes.json() as { nonce: string };
  const verifyRes = await app.inject({
    method: 'POST',
    url: '/api/auth/verify',
    headers: { cookie, 'content-type': 'application/json' },
    payload: {
      address,
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
  return extractSessionCookie(verifyRes.headers['set-cookie']) ?? cookie;
}

async function makeApp(opts: {
  repositories?: AppRepositories;
  postGenerator?: PostGenerator;
  admins?: string[];
  verifySignature?: SignatureVerifier;
} = {}): Promise<{ app: FastifyInstance; authHeaders: { cookie: string } }> {
  const app = await buildApp({
    config: testConfig,
    repositories: opts.repositories ?? repositories(),
    postGenerator: opts.postGenerator,
    auth: {
      fetchAdmins: async () => opts.admins ?? [ADMIN_ADDRESS],
      verifySignature: opts.verifySignature ?? (() => true)
    }
  });
  const authHeaders = { cookie: await loginCookie(app) };
  return { app, authHeaders };
}

function makeMessage(overrides: Partial<MessageRecord> = {}): MessageRecord {
  return {
    id: overrides.id ?? 'msg-1',
    body: overrides.body ?? 'Hello Bluesky',
    status: overrides.status ?? 'draft',
    weight: overrides.weight ?? 100,
    cooldown_hours: overrides.cooldown_hours ?? 168,
    tags: overrides.tags ?? [],
    platforms: overrides.platforms ?? ['bluesky'],
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
          platforms: input.platforms,
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
          platforms: input.platforms ?? current.platforms,
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
      },
      countReferencingAsset: async (assetId) => {
        return Array.from(messages.values()).filter((m) => m.image_asset_id === assetId).length;
      }
    },
    assets: {
      list: async () => Array.from(assets.values()),
      get: async (id) => assets.get(id) ?? null,
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

describe('wallet authentication', () => {
  test('unauthenticated dashboard requests get the wallet login page', async () => {
    const app = await buildApp({ config: testConfig, repositories: repositories() });

    const response = await app.inject({ method: 'GET', url: '/messages' });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('Connect your Cedra wallet');
    expect(response.body).toContain('/public/login.js');
    expect(response.body).toContain('Inferenco Poster');
    await app.close();
  });

  test('rejects verification when the signature is invalid', async () => {
    const app = await buildApp({
      config: testConfig,
      repositories: repositories(),
      auth: { fetchAdmins: async () => [ADMIN_ADDRESS], verifySignature: () => false }
    });

    await expect(loginCookie(app)).rejects.toThrow('login failed with 401');
    await app.close();
  });

  test('rejects wallets that are not contract admins', async () => {
    const app = await buildApp({
      config: testConfig,
      repositories: repositories(),
      auth: { fetchAdmins: async () => ['0x2'], verifySignature: () => true }
    });

    await expect(loginCookie(app)).rejects.toThrow('login failed with 403');
    await app.close();
  });

  test('reports admin lookup failures during verification', async () => {
    const app = await buildApp({
      config: testConfig,
      repositories: repositories(),
      auth: {
        fetchAdmins: async () => {
          throw new Error('fullnode unavailable');
        },
        verifySignature: () => true
      }
    });

    await expect(loginCookie(app)).rejects.toThrow('login failed with 502');
    await app.close();
  });

  test('rejects verification without a prior nonce', async () => {
    const app = await buildApp({
      config: testConfig,
      repositories: repositories(),
      auth: { fetchAdmins: async () => [ADMIN_ADDRESS], verifySignature: () => true }
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/verify',
      headers: { 'content-type': 'application/json' },
      payload: {
        address: ADMIN_ADDRESS,
        publicKey: '0x00',
        signature: '0x00',
        message: 'test',
        nonce: 'whatever',
        fullMessage: 'test'
      }
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: 'nonce_expired' });
    await app.close();
  });

  test('nonce is single-use', async () => {
    const { app, authHeaders } = await makeApp();

    // The login consumed the nonce; replaying verify on the same session fails.
    const replay = await app.inject({
      method: 'POST',
      url: '/api/auth/verify',
      headers: { ...authHeaders, 'content-type': 'application/json' },
      payload: {
        address: ADMIN_ADDRESS,
        publicKey: '0x00',
        signature: '0x00',
        message: 'test',
        nonce: 'stale',
        fullMessage: 'test'
      }
    });

    expect(replay.statusCode).toBe(401);
    await app.close();
  });

  test('admin address comparison is normalization-aware', async () => {
    // Admin list holds the long form; the wallet reports a short form.
    const app = await buildApp({
      config: testConfig,
      repositories: repositories(),
      auth: { fetchAdmins: async () => ['0x' + '0'.repeat(63) + '1'], verifySignature: () => true }
    });
    const cookie = await loginCookie(app, '0x1');
    expect(cookie).toBeTruthy();
    await app.close();
  });

  test('logout destroys the session', async () => {
    const { app, authHeaders } = await makeApp();

    const logout = await app.inject({ method: 'GET', url: '/api/logout', headers: authHeaders });
    expect(logout.statusCode).toBe(302);

    const after = await app.inject({ method: 'GET', url: '/messages', headers: authHeaders });
    expect(after.body).toContain('Connect your Cedra wallet');
    await app.close();
  });

  test('a session loses access when the wallet is removed from the admin list', async () => {
    let admins = [ADMIN_ADDRESS];
    const app = await buildApp({
      config: testConfig,
      repositories: repositories(),
      auth: { fetchAdmins: async () => admins, verifySignature: () => true }
    });
    const authHeaders = { cookie: await loginCookie(app) };

    const before = await app.inject({ method: 'GET', url: '/messages', headers: authHeaders });
    expect(before.statusCode).toBe(200);
    expect(before.body).not.toContain('Connect your Cedra wallet');

    admins = [];
    const after = await app.inject({ method: 'GET', url: '/messages', headers: authHeaders });
    expect(after.statusCode).toBe(403);
    expect(after.body).toContain('not an admin');
    await app.close();
  });
});

describe('dashboard routes', () => {
  test('readiness reports database repository failures', async () => {
    const repos = repositories();
    repos.settings.getDashboardSettings = async () => {
      throw new Error('database unavailable');
    };
    const app = await buildApp({ config: testConfig, repositories: repos });

    const response = await app.inject({ method: 'GET', url: '/readyz' });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ ok: false });
    await app.close();
  });

  test('creates, edits, pauses, and renders branded messages', async () => {
    const repos = repositories();
    const { app, authHeaders } = await makeApp({ repositories: repos });

    const created = await app.inject({
      method: 'POST',
      url: '/messages',
      headers: { ...authHeaders, 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'body=First%20message&status=approved&weight=250&cooldownHours=12&tags=launch,updates&platforms=bluesky&platforms=mastodon&imageAlt=Launch%20image'
    });
    expect(created.statusCode).toBe(302);

    const edited = await app.inject({
      method: 'POST',
      url: '/messages/msg-1',
      headers: { ...authHeaders, 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'body=Edited%20message&weight=150&cooldownHours=24&tags=edited&platforms=mastodon'
    });
    expect(edited.statusCode).toBe(302);

    const paused = await app.inject({
      method: 'POST',
      url: '/messages/msg-1/status',
      headers: { ...authHeaders, 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'status=paused'
    });
    expect(paused.statusCode).toBe(302);

    const list = await app.inject({ method: 'GET', url: '/messages', headers: authHeaders });
    expect(list.body).toContain('Inferenco Poster');
    expect(list.body).toContain('Edited message');
    expect(list.body).toContain('paused');
    expect(list.body).toContain('150');
    expect(list.body).toContain('24h');
    expect(list.body).toContain('Mastodon');
    await app.close();
  });

  test('renders platform checkboxes and defaults new messages to Bluesky', async () => {
    const repos = repositories();
    const { app, authHeaders } = await makeApp({ repositories: repos });

    const form = await app.inject({ method: 'GET', url: '/messages/new', headers: authHeaders });
    expect(form.body).toContain('name="platforms" value="bluesky" checked');
    expect(form.body).toContain('name="platforms" value="mastodon"');

    await app.inject({
      method: 'POST',
      url: '/messages',
      headers: { ...authHeaders, 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'body=Default%20platform&status=draft&weight=100&cooldownHours=168'
    });

    const list = await app.inject({ method: 'GET', url: '/messages', headers: authHeaders });
    expect(list.body).toContain('Bluesky');
    await app.close();
  });

  test('registers assets and offers them on message forms', async () => {
    const { app, authHeaders } = await makeApp();

    const created = await app.inject({
      method: 'POST',
      url: '/assets',
      headers: { ...authHeaders, 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'pathOrObjectKey=assets%2Fimages%2Foriginals%2FNova1.jpg&altTextDefault=Nova%20portrait'
    });

    expect(created.statusCode).toBe(302);
    const assets = await app.inject({ method: 'GET', url: '/assets', headers: authHeaders });
    expect(assets.body).toContain('Nova portrait');

    const form = await app.inject({ method: 'GET', url: '/messages/new', headers: authHeaders });
    expect(form.body).toContain('asset-1');
    expect(form.body).toContain('Nova portrait');
    expect(form.body).not.toContain('name="imagePath"');
    expect(form.body).toContain('id="generatePostBtn"');
    expect(form.body).toContain('/messages/generate');

    const assetForm = await app.inject({ method: 'GET', url: '/assets/new', headers: authHeaders });
    expect(assetForm.body).toContain('/assets/upload-multipart');
    expect(assetForm.body).not.toContain('Register local file path');

    await app.close();
  });

  test('generates an authenticated AI message suggestion without saving it', async () => {
    const generator: PostGenerator = {
      generate: async () => ({
        body: 'Ship custom software, AI systems, and Web3 platforms with Inferenco. Start at inferenco.com or spielcrypto@inferenco.com',
        tags: ['Inferenco', 'AI', 'Web3']
      })
    };
    const { app, authHeaders } = await makeApp({ postGenerator: generator });

    const response = await app.inject({
      method: 'POST',
      url: '/messages/generate',
      headers: authHeaders
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      body: 'Ship custom software, AI systems, and Web3 platforms with Inferenco. Start at inferenco.com or spielcrypto@inferenco.com',
      tags: ['Inferenco', 'AI', 'Web3']
    });

    const list = await app.inject({ method: 'GET', url: '/messages', headers: authHeaders });
    expect(list.body).toContain('No saved messages yet.');

    await app.close();
  });

  test('requires wallet authentication before generating AI suggestions', async () => {
    const generator: PostGenerator = {
      generate: async () => ({
        body: 'This should not be generated for anonymous users.',
        tags: ['Inferenco']
      })
    };
    const app = await buildApp({
      config: testConfig,
      repositories: repositories(),
      postGenerator: generator
    });

    const response = await app.inject({
      method: 'POST',
      url: '/messages/generate'
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('Connect your Cedra wallet');

    await app.close();
  });

  test('returns a clear AI configuration error when no generator is configured', async () => {
    const { app, authHeaders } = await makeApp();

    const response = await app.inject({
      method: 'POST',
      url: '/messages/generate',
      headers: authHeaders
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: 'OPENAI_API_KEY is not configured.' });

    await app.close();
  });

  test('updates scheduler settings', async () => {
    const { app, authHeaders } = await makeApp();

    const response = await app.inject({
      method: 'POST',
      url: '/settings',
      headers: { ...authHeaders, 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'enabled=on&minIntervalMinutes=30&maxIntervalMinutes=90'
    });

    expect(response.statusCode).toBe(302);
    const settings = await app.inject({ method: 'GET', url: '/settings', headers: authHeaders });
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
    const { app, authHeaders } = await makeApp({ repositories: repos });

    const response = await app.inject({
      method: 'POST',
      url: '/settings',
      headers: { ...authHeaders, 'content-type': 'application/x-www-form-urlencoded' },
      payload
    });

    expect(response.statusCode).toBe(400);
    expect(response.body).toContain('Intervals must be positive whole minutes, and maximum must be greater than or equal to minimum.');
    expect(updateCalls).toBe(0);
    await app.close();
  });

  test('blocks asset deletion when messages still reference it', async () => {
    const repos = repositories();
    const { app, authHeaders } = await makeApp({ repositories: repos });

    const createdAsset = await app.inject({
      method: 'POST',
      url: '/assets',
      headers: { ...authHeaders, 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'pathOrObjectKey=assets%2Fimages%2Ftest.jpg&altTextDefault=Test+image'
    });
    expect(createdAsset.statusCode).toBe(302);

    await app.inject({
      method: 'POST',
      url: '/messages',
      headers: { ...authHeaders, 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'body=Post+with+asset&status=draft&weight=100&cooldownHours=168&imageAssetId=asset-1'
    });

    const deleteResponse = await app.inject({
      method: 'POST',
      url: '/assets/asset-1/delete',
      headers: authHeaders
    });

    expect(deleteResponse.statusCode).toBe(302);
    const location = deleteResponse.headers['location'] as string;
    expect(location).toMatch(/^\/assets\?error=/);
    expect(decodeURIComponent(location)).toContain('Cannot delete');
    expect(decodeURIComponent(location)).toContain('1 message is still using this asset');

    const assetList = await app.inject({ method: 'GET', url: '/assets', headers: authHeaders });
    expect(assetList.body).toContain('Test image');

    await app.close();
  });

  test('deletes an asset when no messages reference it', async () => {
    const repos = repositories();
    const { app, authHeaders } = await makeApp({ repositories: repos });

    const createdAsset = await app.inject({
      method: 'POST',
      url: '/assets',
      headers: { ...authHeaders, 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'pathOrObjectKey=assets%2Fimages%2Funused.jpg&altTextDefault=Unused+image'
    });
    expect(createdAsset.statusCode).toBe(302);

    const assetsBefore = await app.inject({ method: 'GET', url: '/assets', headers: authHeaders });
    expect(assetsBefore.body).toContain('Unused image');

    const deleteResponse = await app.inject({
      method: 'POST',
      url: '/assets/asset-1/delete',
      headers: authHeaders
    });

    expect(deleteResponse.statusCode).toBe(302);
    expect(deleteResponse.headers['location']).toBe('/assets');

    const assetsAfter = await app.inject({ method: 'GET', url: '/assets', headers: authHeaders });
    expect(assetsAfter.body).not.toContain('Unused image');

    await app.close();
  });

  describe('POST /assets/upload-multipart', () => {
    async function makeValidImageBuffer(): Promise<Buffer> {
      return sharp({
        create: { width: 10, height: 10, channels: 3, background: { r: 100, g: 149, b: 237 } }
      })
        .png()
        .toBuffer();
    }

    test('happy path: valid image and alt text returns 200 ok and registers asset', async () => {
      const repos = repositories();
      let registeredInput: Parameters<typeof repos.assets.registerObjectStorageImage>[0] | null = null;
      const original = repos.assets.registerObjectStorageImage;
      repos.assets.registerObjectStorageImage = async (input) => {
        registeredInput = input;
        return original(input);
      };
      const { app, authHeaders } = await makeApp({ repositories: repos });

      const imageBuffer = await makeValidImageBuffer();
      const form = new FormData();
      form.append('altTextDefault', 'A blue square');
      form.append('file', imageBuffer, { filename: 'test.png', contentType: 'image/png' });

      const response = await app.inject({
        method: 'POST',
        url: '/assets/upload-multipart',
        headers: { ...authHeaders, ...form.getHeaders() },
        payload: form.getBuffer()
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ ok: true });
      expect(registeredInput).not.toBeNull();
      expect(registeredInput!.altTextDefault).toBe('A blue square');
      expect(registeredInput!.mimeType).toBe('image/png');
      expect(registeredInput!.width).toBe(10);
      expect(registeredInput!.height).toBe(10);
      expect(registeredInput!.objectKey).toBe('uploads/test-uuid.png');

      const assetList = await app.inject({ method: 'GET', url: '/assets', headers: authHeaders });
      expect(assetList.body).toContain('src="/assets/asset-1/preview"');
      expect(assetList.body).not.toContain('thumb-fallback');

      const preview = await app.inject({ method: 'GET', url: '/assets/asset-1/preview', headers: authHeaders });
      expect(preview.statusCode).toBe(200);
      expect(preview.headers['content-type']).toBe('image/png');
      expect(preview.body).toBe('preview-bytes');

      await app.close();
    });

    test('returns 400 when no file is included', async () => {
      const { app, authHeaders } = await makeApp();

      const form = new FormData();
      form.append('altTextDefault', 'Some alt text');

      const response = await app.inject({
        method: 'POST',
        url: '/assets/upload-multipart',
        headers: { ...authHeaders, ...form.getHeaders() },
        payload: form.getBuffer()
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error: 'No file uploaded' });

      await app.close();
    });

    test('returns 400 when alt text is missing', async () => {
      const { app, authHeaders } = await makeApp();

      const imageBuffer = await makeValidImageBuffer();
      const form = new FormData();
      form.append('file', imageBuffer, { filename: 'test.png', contentType: 'image/png' });

      const response = await app.inject({
        method: 'POST',
        url: '/assets/upload-multipart',
        headers: { ...authHeaders, ...form.getHeaders() },
        payload: form.getBuffer()
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error: 'Alt text is required' });

      await app.close();
    });

    test('returns 400 when file has a non-image MIME type', async () => {
      const { app, authHeaders } = await makeApp();

      const form = new FormData();
      form.append('altTextDefault', 'A document');
      form.append('file', Buffer.from('%PDF-1.4 fake pdf content'), {
        filename: 'document.pdf',
        contentType: 'application/pdf'
      });

      const response = await app.inject({
        method: 'POST',
        url: '/assets/upload-multipart',
        headers: { ...authHeaders, ...form.getHeaders() },
        payload: form.getBuffer()
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error: 'File must be an image' });

      await app.close();
    });

    test('returns 400 when file exceeds the 2 MB size limit', async () => {
      const { app, authHeaders } = await makeApp();

      const oversizedBuffer = Buffer.alloc(2_100_000, 0xff);
      const form = new FormData();
      form.append('altTextDefault', 'Too big');
      form.append('file', oversizedBuffer, { filename: 'big.png', contentType: 'image/png' });

      const response = await app.inject({
        method: 'POST',
        url: '/assets/upload-multipart',
        headers: { ...authHeaders, ...form.getHeaders() },
        payload: form.getBuffer()
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error: 'Image must be 2 MB or smaller' });

      await app.close();
    });
  });
});
