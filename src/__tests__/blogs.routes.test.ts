import { afterEach, describe, expect, test, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, type AppRepositories } from '../app.js';
import type { BlogRecord, BlogStatus } from '../repositories/blogs.js';
import type { AssetRecord } from '../repositories/assets.js';

vi.mock('../replit_integrations/object_storage.js', () => ({
  downloadObject: vi.fn().mockResolvedValue(Buffer.from('object-image'))
}));

const ADMIN = '0xbdf9c94e797716648980ed99a0c6e2b3d6452ce5c1d28dbad3517a9be682b724';
const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map(app => app.close()));
});

function blog(overrides: Partial<BlogRecord> = {}): BlogRecord {
  return {
    id: 'blog-1', title: 'A blog', content: '# A heading\n\nSome **bold** content.',
    status: 'draft', published_at: null,
    created_at: new Date('2026-06-10T12:00:00Z'),
    updated_at: new Date('2026-06-10T12:00:00Z'),
    ...overrides
  };
}

function asset(id: string): AssetRecord {
  return {
    id, storage_kind: 'database', path_or_object_key: null, public_url: null,
    content: Buffer.from('image-' + id), mime_type: 'image/png',
    width: 1, height: 1, bytes: 12, alt_text_default: 'Image ' + id,
    created_at: new Date('2026-06-10T12:00:00Z')
  };
}

async function fixture() {
  const records = new Map<string, BlogRecord>();
  const assets = new Map<string, AssetRecord>();
  const attachments = new Map<string, string[]>();
  let admins = [ADMIN];
  const unused = async (): Promise<never> => { throw new Error('Unexpected non-blog repository operation'); };
  const repos: AppRepositories = {
    messages: {
      list: unused, get: unused, create: unused, update: unused,
      setStatus: unused, delete: unused, countReferencingAsset: async () => 0
    },
    assets: {
      list: async () => [...assets.values()], get: async id => assets.get(id) ?? null,
      registerLocalImage: unused, registerImageBuffer: unused, registerObjectStorageImage: unused,
      delete: async id => { assets.delete(id); }
    },
    settings: { getDashboardSettings: unused, updateDashboardSettings: unused },
    runs: { list: unused },
    blogs: {
      list: async () => [...records.values()].filter(item => item.status !== 'archived'),
      get: async id => records.get(id) ?? null,
      create: vi.fn(async input => {
        const item = blog({ ...input, id: 'blog-' + (records.size + 1), published_at: input.publishedAt ?? null });
        records.set(item.id, item);
        return item;
      }),
      update: vi.fn(async (id, input) => {
        const current = records.get(id);
        if (!current) throw new Error('blog not found');
        const item = { ...current, ...input };
        records.set(id, item);
        return item;
      }),
      setStatus: vi.fn(async (id, status) => {
        const current = records.get(id);
        if (current) records.set(id, { ...current, status, published_at: status === 'published' ? new Date() : null });
      }),
      delete: vi.fn(async id => { records.delete(id); attachments.delete(id); }),
      addAsset: vi.fn(async (id, assetId, position = 0) => {
        const current = (attachments.get(id) ?? []).filter(value => value !== assetId);
        current.splice(position, 0, assetId);
        attachments.set(id, current);
      }),
      removeAsset: vi.fn(async (id, assetId) => {
        attachments.set(id, (attachments.get(id) ?? []).filter(value => value !== assetId));
      }),
      getBlogAssets: async id => (attachments.get(id) ?? []).map(id => assets.get(id)!),
      countReferencingAsset: async id => [...attachments.values()].filter(ids => ids.includes(id)).length,
      isAssetPublished: async id => [...records.values()].some(item =>
        item.status === 'published' && (attachments.get(item.id) ?? []).includes(id)),
      listPublished: async ({ limit = 10, offset = 0 } = {}) => {
        const published = [...records.values()].filter(item => item.status === 'published');
        return { blogs: published.slice(offset, offset + limit), total: published.length };
      },
      setPublishedAt: async (id, date) => {
        const current = records.get(id);
        if (current) current.published_at = date;
      },
      reorderAssets: async (id, assetId, position) => {
        await repos.blogs.addAsset(id, assetId, position);
      }
    }
  };
  const app = await buildApp({
    config: {
      corsOrigin: '*',
      auth: {
        cedraFullnodeUrl: 'http://unused.example', adminContractAddress: '0x1',
        adminCacheTtlMs: 60_000, adminViewTimeoutMs: 5_000, secureCookies: false
      }
    },
    repositories: repos,
    auth: { fetchAdmins: async () => admins, verifySignature: () => true }
  });
  apps.push(app);

  async function login(): Promise<{ cookie: string }> {
    const nonceResponse = await app.inject({ method: 'GET', url: '/api/auth/nonce' });
    const setCookie = nonceResponse.headers['set-cookie'];
    const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)!.split(';')[0];
    const { nonce, message } = nonceResponse.json();
    const verified = await app.inject({
      method: 'POST', url: '/api/auth/verify', headers: { cookie },
      payload: {
        address: ADMIN, publicKey: '0x' + '00'.repeat(32), signature: '0x' + '00'.repeat(64),
        nonce, message, fullMessage: message
      }
    });
    expect(verified.statusCode).toBe(200);
    const refreshed = verified.headers['set-cookie'];
    return { cookie: refreshed ? (Array.isArray(refreshed) ? refreshed[0] : refreshed).split(';')[0] : cookie };
  }
  return {
    app, repos, records, assets, attachments, login,
    revokeAdmin: () => { admins = []; }
  };
}

describe('blog admin access', () => {
  test.each([
    ['GET', '/blogs'],
    ['GET', '/blogs/new'],
    ['GET', '/blogs/blog-1/edit'],
    ['POST', '/blogs'],
    ['POST', '/blogs/blog-1'],
    ['POST', '/blogs/blog-1/status'],
    ['POST', '/blogs/blog-1/delete'],
    ['POST', '/blogs/blog-1/assets'],
    ['POST', '/blogs/blog-1/assets/asset-1/delete']
  ] as const)('requires wallet login for %s %s', async (method, url) => {
    const { app, repos } = await fixture();
    const response = await app.inject({ method, url });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('/public/login.js');
    expect(repos.blogs.create).not.toHaveBeenCalled();
    expect(repos.blogs.update).not.toHaveBeenCalled();
    expect(repos.blogs.setStatus).not.toHaveBeenCalled();
    expect(repos.blogs.delete).not.toHaveBeenCalled();
    expect(repos.blogs.addAsset).not.toHaveBeenCalled();
    expect(repos.blogs.removeAsset).not.toHaveBeenCalled();
  });

  test('rejects a previously authenticated wallet after admin access is revoked', async () => {
    const { app, repos, login, revokeAdmin } = await fixture();
    const headers = await login();
    revokeAdmin();

    const response = await app.inject({
      method: 'POST', url: '/blogs', headers, payload: { title: 'Unauthorized', content: 'No' }
    });

    expect(response.statusCode).toBe(403);
    expect(repos.blogs.create).not.toHaveBeenCalled();
  });
});

describe('blog lifecycle and public API', () => {
  test('creates, edits, publishes, archives, and deletes a blog with attached images', async () => {
    const { app, records, assets, attachments, login } = await fixture();
    assets.set('asset-1', asset('asset-1'));
    assets.set('asset-2', asset('asset-2'));
    const headers = { ...await login(), 'content-type': 'application/x-www-form-urlencoded' };
    const created = await app.inject({
      method: 'POST', url: '/blogs', headers,
      payload: new URLSearchParams({
        title: 'First draft', content: '# Draft', status: 'draft',
        selectedAssets: JSON.stringify(['asset-1', 'missing'])
      }).toString()
    });
    expect(created.statusCode).toBe(302);
    expect(created.headers.location).toBe('/blogs');
    expect(attachments.get('blog-1')).toEqual(['asset-1']);
    expect((await app.inject({ method: 'GET', url: '/api/blogs/blog-1' })).statusCode).toBe(404);

    const edited = await app.inject({
      method: 'POST', url: '/blogs/blog-1', headers,
      payload: new URLSearchParams({
        title: 'Updated title', content: '# Updated content', status: 'draft',
        selectedAssets: JSON.stringify(['asset-2'])
      }).toString()
    });
    expect(edited.statusCode).toBe(302);
    expect(attachments.get('blog-1')).toEqual(['asset-2']);

    const published = await app.inject({
      method: 'POST', url: '/blogs/blog-1/status', headers, payload: 'status=published'
    });
    expect(published.statusCode).toBe(302);
    const visible = await app.inject({ method: 'GET', url: '/api/blogs/blog-1' });
    expect(visible.statusCode).toBe(200);
    expect(visible.json()).toMatchObject({
      title: 'Updated title', content: '# Updated content', excerpt: 'Updated content',
      assets: [{ id: 'asset-2', public_url: '/public/assets/asset-2' }]
    });
    expect(visible.json().assets[0]).not.toHaveProperty('content');

    const archived = await app.inject({
      method: 'POST', url: '/blogs/blog-1/status', headers, payload: 'status=archived'
    });
    expect(archived.statusCode).toBe(302);
    expect((await app.inject({ method: 'GET', url: '/api/blogs/blog-1' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/blogs' })).json().blogs).toEqual([]);

    const deleted = await app.inject({ method: 'POST', url: '/blogs/blog-1/delete', headers });
    expect(deleted.statusCode).toBe(302);
    expect(records.has('blog-1')).toBe(false);
    expect(assets.has('asset-2')).toBe(true);
  });

  test('paginates published posts without exposing drafts or archived posts', async () => {
    const { app, records } = await fixture();
    records.set('draft', blog({ id: 'draft' }));
    records.set('archived', blog({ id: 'archived', status: 'archived' }));
    for (const id of ['published-1', 'published-2', 'published-3']) {
      records.set(id, blog({ id, status: 'published' }));
    }

    const response = await app.inject({ method: 'GET', url: '/api/blogs?page=2&limit=2' });

    expect(response.statusCode).toBe(200);
    expect(response.json().blogs.map((item: BlogRecord) => item.id)).toEqual(['published-3']);
    expect(response.json().pagination).toEqual({ page: 2, limit: 2, total: 3, pages: 2 });
  });

  test.each(['draft', 'archived'] as BlogStatus[])('does not expose a %s blog by ID', async (status) => {
    const { app, records } = await fixture();
    records.set('blog-1', blog({ status }));

    const response = await app.inject({ method: 'GET', url: '/api/blogs/blog-1' });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'Blog not found or not published' });
  });

  test('renders saved markdown in the authenticated edit preview', async () => {
    const { app, records, login } = await fixture();
    records.set('blog-1', blog());
    const response = await app.inject({
      method: 'GET', url: '/blogs/blog-1/edit', headers: await login()
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('&lt;h1&gt;A heading&lt;/h1&gt;');
    expect(response.body).toContain('&lt;strong&gt;bold&lt;/strong&gt;');
    expect(response.body).toContain('id="markdownPreview"');
    expect(response.body).toContain('sandbox=""');
  });

  test('preserves an image that is still referenced by a blog', async () => {
    const { app, records, assets, attachments, login } = await fixture();
    records.set('blog-1', blog());
    assets.set('asset-1', asset('asset-1'));
    attachments.set('blog-1', ['asset-1']);

    const response = await app.inject({
      method: 'POST', url: '/assets/asset-1/delete', headers: await login()
    });

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toMatch(/^\/assets\?error=/);
    expect(decodeURIComponent(response.headers.location!)).toContain('blog');
    expect(assets.has('asset-1')).toBe(true);
  });

  test('escapes asset metadata before embedding it in the blog editor script', async () => {
    const { app, assets, login } = await fixture();
    const attack = '</script><script>globalThis.assetInjected=true</script>';
    assets.set('asset-1', { ...asset('asset-1'), alt_text_default: attack });

    const response = await app.inject({
      method: 'GET', url: '/blogs/new', headers: await login()
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain(attack);
    expect(response.body).toContain('&lt;/script&gt;');
  });

  test('serves image bytes for published blogs but conceals draft and unattached images', async () => {
    const { app, records, assets, attachments } = await fixture();
    records.set('blog-1', blog({ status: 'published' }));
    records.set('blog-2', blog({ id: 'blog-2', status: 'draft' }));
    for (const id of ['public-image', 'draft-image', 'unattached-image']) assets.set(id, asset(id));
    attachments.set('blog-1', ['public-image']);
    attachments.set('blog-2', ['draft-image']);

    const publicImage = await app.inject({ method: 'GET', url: '/public/assets/public-image' });
    expect(publicImage.statusCode).toBe(200);
    expect(publicImage.headers['content-type']).toBe('image/png');
    expect(publicImage.rawPayload.equals(assets.get('public-image')!.content!)).toBe(true);

    for (const id of ['draft-image', 'unattached-image', 'missing-image']) {
      const hiddenImage = await app.inject({ method: 'GET', url: '/public/assets/' + id });
      expect(hiddenImage.statusCode).toBe(404);
    }

    records.set('blog-1', blog({ status: 'draft' }));
    const unpublishedImage = await app.inject({ method: 'GET', url: '/public/assets/public-image' });
    expect(unpublishedImage.statusCode).toBe(404);
  });
});
