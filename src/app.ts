import Fastify, { type FastifyInstance, type FastifyRequest, type FastifyReply } from 'fastify';
import formbody from '@fastify/formbody';
import multipart from '@fastify/multipart';
import sharp from 'sharp';
import type { AppConfig } from './config.js';
import type { AssetRecord, RegisterLocalImageInput, RegisterObjectStorageImageInput } from './repositories/assets.js';
import type { CreateMessageInput, MessageRecord, MessageStatus } from './repositories/messages.js';
import { countGraphemes } from './validate.js';
import { uploadBuffer } from './replit_integrations/object_storage.js';

export interface AppRepositories {
  messages: {
    list(): Promise<MessageRecord[]>;
    get(id: string): Promise<MessageRecord | null>;
    create(input: CreateMessageInput): Promise<MessageRecord>;
    update(id: string, input: Partial<CreateMessageInput>): Promise<MessageRecord>;
    setStatus(id: string, status: MessageStatus): Promise<void>;
    delete(id: string): Promise<void>;
    countReferencingAsset(assetId: string): Promise<number>;
  };
  assets: {
    list(): Promise<AssetRecord[]>;
    registerLocalImage(input: RegisterLocalImageInput): Promise<AssetRecord>;
    registerObjectStorageImage(input: RegisterObjectStorageImageInput): Promise<AssetRecord>;
    delete(id: string): Promise<void>;
  };
  settings: {
    getDashboardSettings(): Promise<DashboardSettings>;
    updateDashboardSettings(input: Pick<DashboardSettings, 'enabled' | 'minIntervalMinutes' | 'maxIntervalMinutes'>): Promise<DashboardSettings>;
  };
  runs: {
    list(): Promise<DashboardRun[]>;
  };
}

export interface DashboardSettings {
  enabled: boolean;
  timezone: string;
  minIntervalMinutes: number;
  maxIntervalMinutes: number;
  quietHours: unknown[];
  nextRunAt: Date | null;
}

export interface DashboardRun {
  id: string;
  message_id: string;
  attempted_at: Date | string;
  status: string;
  bsky_uri: string | null;
  error: string | null;
}

function makeRequireAuth(config: Pick<AppConfig, 'dashboard'>) {
  const credentialsConfigured = Boolean(config.dashboard.user && config.dashboard.password);

  return async function requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const userId = request.headers['x-replit-user-id'];
    if (userId) return;

    if (credentialsConfigured) {
      const authHeader = request.headers['authorization'] ?? '';
      if (authHeader.startsWith('Basic ')) {
        const decoded = Buffer.from(authHeader.slice(6), 'base64').toString('utf8');
        const colon = decoded.indexOf(':');
        if (colon !== -1) {
          const user = decoded.slice(0, colon);
          const password = decoded.slice(colon + 1);
          if (user === config.dashboard.user && password === config.dashboard.password) return;
        }
        void reply.code(401).header('WWW-Authenticate', 'Basic realm="Dashboard"').send('Unauthorized');
        return;
      }
    }

    const host = (request.headers['x-forwarded-host'] as string | undefined) ?? request.headers['host'] ?? '';
    const loginUrl = `https://replit.com/auth_with_repl_site?domain=${host}`;
    void reply.type('text/html').send(renderLoginPage(loginUrl));
  };
}

export async function buildApp(options: {
  config: Pick<AppConfig, 'dashboard'>;
  repositories: AppRepositories;
}): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(formbody);
  await app.register(multipart, {
    limits: {
      fileSize: 2_000_000,
      files: 1
    }
  });

  const requireAuth = makeRequireAuth(options.config);

  app.get('/healthz', async () => ({ ok: true }));
  app.get('/readyz', async (_request, reply) => {
    try {
      await options.repositories.settings.getDashboardSettings();
      return { ok: true };
    } catch {
      return reply.code(503).send({ ok: false });
    }
  });
  app.get('/', { preHandler: requireAuth }, async (_request, reply) => reply.redirect('/messages'));

  app.get('/messages', { preHandler: requireAuth }, async (_request, reply) => {
    const messages = await options.repositories.messages.list();
    return reply.type('text/html').send(renderPage('Messages', renderMessages(messages)));
  });

  app.get('/messages/new', { preHandler: requireAuth }, async (_request, reply) => {
    const assets = await options.repositories.assets.list();
    return reply.type('text/html').send(renderPage('New message', renderMessageForm('/messages', assets)));
  });

  app.post('/messages', { preHandler: requireAuth }, async (request, reply) => {
    const body = form(request.body);
    await options.repositories.messages.create({
      body: String(body.body ?? ''),
      status: statusFrom(body.status, 'draft'),
      weight: positiveInteger(body.weight, 100),
      cooldownHours: positiveInteger(body.cooldownHours, 168),
      tags: listFromCsv(body.tags),
      imageAssetId: optionalString(body.imageAssetId),
      imagePath: optionalString(body.imagePath),
      imageAlt: optionalString(body.imageAlt)
    });
    return reply.redirect('/messages');
  });

  app.get<{ Params: { id: string } }>('/messages/:id/edit', { preHandler: requireAuth }, async (request, reply) => {
    const message = await options.repositories.messages.get(request.params.id);
    if (!message) return reply.code(404).send('Message not found');
    const [assets, assetRefCount] = await Promise.all([
      options.repositories.assets.list(),
      message.image_asset_id
        ? options.repositories.messages.countReferencingAsset(message.image_asset_id)
        : Promise.resolve(0),
    ]);
    const otherRefCount = Math.max(0, assetRefCount - 1);
    return reply.type('text/html').send(renderPage('Edit message', renderMessageForm(`/messages/${message.id}`, assets, message, otherRefCount)));
  });

  app.post<{ Params: { id: string } }>('/messages/:id', { preHandler: requireAuth }, async (request, reply) => {
    const body = form(request.body);
    await options.repositories.messages.update(request.params.id, {
      body: String(body.body ?? ''),
      status: statusFrom(body.status, 'draft'),
      weight: positiveInteger(body.weight, 100),
      cooldownHours: positiveInteger(body.cooldownHours, 168),
      tags: listFromCsv(body.tags),
      imageAssetId: optionalString(body.imageAssetId),
      imagePath: optionalString(body.imagePath),
      imageAlt: optionalString(body.imageAlt)
    });
    return reply.redirect('/messages');
  });

  app.post<{ Params: { id: string } }>('/messages/:id/status', { preHandler: requireAuth }, async (request, reply) => {
    const body = form(request.body);
    await options.repositories.messages.setStatus(request.params.id, statusFrom(body.status, 'paused'));
    return reply.redirect('/messages');
  });

  app.post<{ Params: { id: string } }>('/messages/:id/delete', { preHandler: requireAuth }, async (request, reply) => {
    await options.repositories.messages.delete(request.params.id);
    return reply.redirect('/messages');
  });

  app.get('/settings', { preHandler: requireAuth }, async (_request, reply) => {
    const settings = await options.repositories.settings.getDashboardSettings();
    return reply.type('text/html').send(renderPage('Settings', renderSettings(settings)));
  });

  app.post('/settings', { preHandler: requireAuth }, async (request, reply) => {
    const body = form(request.body);
    const intervals = parseSchedulerIntervals(body.minIntervalMinutes, body.maxIntervalMinutes);
    if (!intervals) {
      return reply.code(400).send('Intervals must be positive whole minutes, and maximum must be greater than or equal to minimum.');
    }

    await options.repositories.settings.updateDashboardSettings({
      enabled: body.enabled === 'on',
      minIntervalMinutes: intervals.minIntervalMinutes,
      maxIntervalMinutes: intervals.maxIntervalMinutes
    });
    return reply.redirect('/settings');
  });

  app.get('/runs', { preHandler: requireAuth }, async (_request, reply) => {
    const runs = await options.repositories.runs.list();
    return reply.type('text/html').send(renderPage('Runs', renderRuns(runs)));
  });

  app.get<{ Querystring: { error?: string } }>('/assets', { preHandler: requireAuth }, async (request, reply) => {
    const assets = await options.repositories.assets.list();
    const errorMsg = request.query.error ? decodeURIComponent(request.query.error) : null;
    return reply.type('text/html').send(renderPage('Assets', renderAssets(assets, errorMsg)));
  });

  app.get('/assets/new', { preHandler: requireAuth }, async (_request, reply) => {
    return reply.type('text/html').send(renderPage('New asset', renderAssetForm()));
  });

  app.post('/assets', { preHandler: requireAuth }, async (request, reply) => {
    const body = form(request.body);
    await options.repositories.assets.registerLocalImage({
      pathOrObjectKey: String(body.pathOrObjectKey ?? ''),
      altTextDefault: String(body.altTextDefault ?? '')
    });
    return reply.redirect('/assets');
  });

  app.post<{ Params: { id: string } }>('/assets/:id/delete', { preHandler: requireAuth }, async (request, reply) => {
    const assetId = request.params.id;
    const refCount = await options.repositories.messages.countReferencingAsset(assetId);
    if (refCount > 0) {
      const msg = encodeURIComponent(
        `Cannot delete: ${refCount} message${refCount === 1 ? ' is' : 's are'} still using this asset.`
      );
      return reply.redirect(`/assets?error=${msg}`);
    }
    await options.repositories.assets.delete(assetId);
    return reply.redirect('/assets');
  });

  app.post('/assets/upload-multipart', { preHandler: requireAuth }, async (request, reply) => {
    let fileBuffer: Buffer | null = null;
    let fileName = '';
    let mimeType = '';
    let altTextDefault = '';

    const parts = request.parts();
    for await (const part of parts) {
      if (part.type === 'file') {
        fileName = part.filename;
        mimeType = part.mimetype;
        const chunks: Buffer[] = [];
        for await (const chunk of part.file) {
          chunks.push(chunk);
        }
        if (part.file.truncated) {
          return reply.code(400).send({ error: 'Image must be 2 MB or smaller' });
        }
        fileBuffer = Buffer.concat(chunks);
      } else {
        if (part.fieldname === 'altTextDefault') {
          altTextDefault = (part.value as string ?? '').trim();
        }
      }
    }

    if (!fileBuffer || !fileName) {
      return reply.code(400).send({ error: 'No file uploaded' });
    }
    if (!altTextDefault) {
      return reply.code(400).send({ error: 'Alt text is required' });
    }
    if (!mimeType.startsWith('image/')) {
      return reply.code(400).send({ error: 'File must be an image' });
    }

    let metadata: Awaited<ReturnType<typeof sharp.prototype.metadata>>;
    try {
      metadata = await sharp(fileBuffer).metadata();
    } catch {
      return reply.code(400).send({ error: 'Could not read image metadata' });
    }
    if (!metadata.width || !metadata.height) {
      return reply.code(400).send({ error: 'Could not read image dimensions' });
    }

    try {
      const { objectKey, publicUrl } = await uploadBuffer(fileName, fileBuffer, mimeType);
      await options.repositories.assets.registerObjectStorageImage({
        objectKey,
        publicUrl,
        mimeType,
        altTextDefault,
        width: metadata.width,
        height: metadata.height,
        bytes: fileBuffer.length,
      });
    } catch (err) {
      return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }

    return reply.send({ ok: true });
  });

  return app;
}

function form(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function statusFrom(value: unknown, fallback: MessageStatus): MessageStatus {
  const raw = String(value ?? fallback);
  if (['draft', 'approved', 'paused', 'archived'].includes(raw)) {
    return raw as MessageStatus;
  }
  return fallback;
}

function positiveInteger(value: unknown, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function optionalString(value: unknown): string | null {
  const raw = String(value ?? '').trim();
  return raw ? raw : null;
}

function listFromCsv(value: unknown): string[] {
  return String(value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseSchedulerIntervals(minValue: unknown, maxValue: unknown): { minIntervalMinutes: number; maxIntervalMinutes: number } | null {
  const minIntervalMinutes = Number(minValue);
  const maxIntervalMinutes = Number(maxValue);

  if (!Number.isInteger(minIntervalMinutes) || !Number.isInteger(maxIntervalMinutes)) return null;
  if (minIntervalMinutes < 1 || maxIntervalMinutes < 1) return null;
  if (maxIntervalMinutes < minIntervalMinutes) return null;

  return { minIntervalMinutes, maxIntervalMinutes };
}

function renderLoginPage(loginUrl: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Sign in - Bluesky Poster</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { min-height: 100vh; display: flex; align-items: center; justify-content: center; background: #eef2f8; font-family: Inter, ui-sans-serif, system-ui, -apple-system, sans-serif; }
    .card { background: #fff; border: none; border-radius: 14px; padding: 48px 40px; width: 100%; max-width: 380px; text-align: center; box-shadow: 0 1px 4px rgba(0,0,0,.07), 0 8px 32px rgba(0,0,0,.08); }
    h1 { font-size: 22px; font-weight: 700; color: #151922; margin-bottom: 8px; letter-spacing: -.01em; }
    p { color: #626b7a; font-size: 14px; margin-bottom: 32px; line-height: 1.5; }
    .btn { display: inline-block; background: linear-gradient(135deg, #00b4ff, #1463ff); color: #fff; border: none; border-radius: 999px; padding: 12px 28px; font-size: 15px; font-weight: 600; text-decoration: none; cursor: pointer; transition: opacity .15s; font-family: inherit; }
    .btn:hover { opacity: .88; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Bluesky Poster</h1>
    <p>Sign in with your Replit account to access the dashboard.</p>
    <button class="btn" onclick="try{window.top.location.href='${loginUrl}'}catch(e){window.open('${loginUrl}')}">Sign in with Replit</button>
  </div>
</body>
</html>`;
}

function renderPage(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)} - Bluesky Poster</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #eef2f8;
      --surface: #ffffff;
      --surface-soft: #f0f4fa;
      --text: #151922;
      --muted: #626b7a;
      --border: #dce3ef;
      --accent: #1463ff;
      --accent-strong: #0a47c7;
      --gradient-accent: linear-gradient(135deg, #00b4ff, #1463ff);
      --danger: #b42318;
      --warning: #b54708;
      --success: #067647;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    * { box-sizing: border-box; }
    body { margin: 0; background: var(--bg); color: var(--text); }
    a { color: var(--accent); text-decoration: none; }
    a:hover { text-decoration: underline; }
    .shell { display: grid; grid-template-columns: 220px minmax(0, 1fr); min-height: 100vh; }
    nav { background: #0d1117; color: #c9d1de; padding: 24px 18px; }
    nav h1 { color: #ffffff; font-size: 18px; font-weight: 700; line-height: 1.2; margin: 0 0 28px; letter-spacing: -.01em; }
    nav a { display: block; color: #c9d1de; border-radius: 6px; padding: 10px 12px; font-size: 14px; }
    nav a:hover { background: rgba(255,255,255,.10); text-decoration: none; }
    nav a.active { background: linear-gradient(135deg, rgba(0,180,255,.18), rgba(20,99,255,.18)); color: #ffffff; }
    main { padding: 28px clamp(18px, 4vw, 44px); }
    .page-head { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 20px; }
    h2 { font-size: 28px; line-height: 1.15; margin: 0; letter-spacing: 0; }
    .muted { color: var(--muted); font-size: 14px; }
    .button, button { appearance: none; border: 1px solid var(--border); background: var(--surface); color: var(--text); border-radius: 999px; padding: 8px 16px; font: inherit; font-size: 14px; cursor: pointer; }
    .button.primary { background: var(--gradient-accent); border-color: transparent; color: #fff; font-weight: 600; }
    .button.primary:hover { opacity: .88; text-decoration: none; }
    button.danger { color: var(--danger); }
    table { width: 100%; border-collapse: collapse; background: var(--surface); border: none; border-radius: 10px; overflow: hidden; box-shadow: 0 1px 4px rgba(0,0,0,.07), 0 4px 16px rgba(0,0,0,.05); }
    th, td { padding: 12px 14px; border-bottom: 1px solid var(--border); text-align: left; vertical-align: top; font-size: 14px; }
    th { background: var(--surface-soft); color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: .04em; }
    tr:last-child td { border-bottom: 0; }
    .message-cell { max-width: 520px; white-space: pre-wrap; line-height: 1.45; }
    .actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
    .actions form { display: inline; }
    .badge { display: inline-flex; align-items: center; min-height: 24px; border-radius: 999px; padding: 2px 9px; font-size: 12px; font-weight: 650; background: var(--surface-soft); color: var(--muted); }
    .badge.approved { background: #dcfae6; color: var(--success); }
    .badge.paused { background: #fff3cd; color: var(--warning); }
    .badge.archived { background: #e8ecf4; color: #475467; }
    .form-panel { max-width: 820px; background: var(--surface); border: none; border-radius: 10px; padding: 20px; box-shadow: 0 1px 4px rgba(0,0,0,.07), 0 4px 16px rgba(0,0,0,.05); }
    .form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
    label { display: grid; gap: 7px; color: var(--muted); font-size: 13px; }
    input, select, textarea { width: 100%; border: 1px solid var(--border); border-radius: 8px; background: #fff; color: var(--text); padding: 9px 10px; font: inherit; font-size: 14px; }
    textarea { min-height: 150px; resize: vertical; grid-column: 1 / -1; }
    .full { grid-column: 1 / -1; }
    .form-actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 18px; }
    .empty { background: var(--surface); border: 1px dashed var(--border); border-radius: 10px; padding: 28px; color: var(--muted); box-shadow: 0 1px 4px rgba(0,0,0,.05); }
    .banner { border-radius: 10px; padding: 12px 16px; margin-bottom: 16px; font-size: 14px; }
    .banner.error { background: #fef3f2; border: 1px solid #fecdca; color: #b42318; }
    @media (max-width: 760px) {
      .shell { grid-template-columns: 1fr; }
      nav { display: flex; gap: 8px; align-items: center; overflow-x: auto; padding: 14px; }
      nav h1 { margin: 0 12px 0 0; white-space: nowrap; }
      nav a { white-space: nowrap; }
      .page-head { align-items: flex-start; flex-direction: column; }
      .form-grid { grid-template-columns: 1fr; }
      table { display: block; overflow-x: auto; }
    }
  </style>
</head>
<body>
  <div class="shell">
    <nav>
      <h1>Bluesky Poster</h1>
      <a href="/messages">Messages</a>
      <a href="/assets">Assets</a>
      <a href="/settings">Settings</a>
      <a href="/runs">Runs</a>
    </nav>
    <main>${body}</main>
  </div>
</body>
</html>`;
}

function renderMessages(messages: MessageRecord[]): string {
  const rows = messages.map((message) => `<tr>
    <td class="message-cell">${escapeHtml(message.body)}</td>
    <td><span class="badge ${escapeHtml(message.status)}">${escapeHtml(message.status)}</span></td>
    <td>${message.weight}</td>
    <td>${message.cooldown_hours}h</td>
    <td>${message.post_count}</td>
    <td>${countGraphemes(message.body)}/300</td>
    <td>${escapeHtml(message.tags.join(', '))}</td>
    <td class="actions">
      <a href="/messages/${message.id}/edit">Edit</a>
      <form method="post" action="/messages/${message.id}/status"><input type="hidden" name="status" value="paused"><button onclick="return confirm('Pause this message? It will stop being selected for posting.')">Pause</button></form>
      <form method="post" action="/messages/${message.id}/status"><input type="hidden" name="status" value="approved"><button>Approve</button></form>
      <form method="post" action="/messages/${message.id}/status"><input type="hidden" name="status" value="archived"><button onclick="return confirm('Archive this message? It will be removed from the posting rotation.')">Archive</button></form>
      <form method="post" action="/messages/${message.id}/delete"><button class="danger" onclick="return confirm('Permanently delete this message? This cannot be undone.')">Delete</button></form>
    </td>
  </tr>`).join('');

  return `<div class="page-head"><div><h2>Messages</h2><p class="muted">Saved posts are selected by approval state, cooldown, recent duplicate history, and weight.</p></div><a class="button primary" href="/messages/new">New message</a></div>${rows ? `<table><thead><tr><th>Message</th><th>Status</th><th>Weight</th><th>Cooldown</th><th>Posts</th><th>Length</th><th>Tags</th><th>Actions</th></tr></thead><tbody>${rows}</tbody></table>` : '<div class="empty">No saved messages yet.</div>'}`;
}

function renderMessageForm(action: string, assets: AssetRecord[], message?: MessageRecord, assetOtherRefCount?: number): string {
  const assetOptions = [
    `<option value="">No image asset</option>`,
    ...assets.map((asset) => `<option value="${escapeHtml(asset.id)}"${message?.image_asset_id === asset.id ? ' selected' : ''}>${escapeHtml(asset.alt_text_default)} (${escapeHtml(asset.path_or_object_key ?? asset.storage_kind)})</option>`)
  ].join('');

  const assetRefNote = message?.image_asset_id && assetOtherRefCount != null && assetOtherRefCount > 0
    ? ` <span class="muted" title="Swapping or removing this asset will not affect other messages, but the asset may still be in use.">Used by ${assetOtherRefCount} other ${assetOtherRefCount === 1 ? 'message' : 'messages'}</span>`
    : '';

  return `<div class="page-head"><div><h2>${message ? 'Edit' : 'New'} message</h2><p class="muted">Approved messages enter the scheduler pool. Drafts and paused messages stay out of rotation.</p></div></div>
  <form class="form-panel" method="post" action="${escapeHtml(action)}">
    <div class="form-grid">
    <label class="full">Body <textarea name="body">${escapeHtml(message?.body ?? '')}</textarea></label>
    <label>Status <select name="status">
      ${['draft', 'approved', 'paused', 'archived'].map((status) => `<option value="${status}"${message?.status === status ? ' selected' : ''}>${status}</option>`).join('')}
    </select></label>
    <label>Weight <input name="weight" type="number" min="1" value="${message?.weight ?? 100}"></label>
    <label>Cooldown hours <input name="cooldownHours" type="number" min="1" value="${message?.cooldown_hours ?? 168}"></label>
    <label>Tags <input name="tags" value="${escapeHtml(message?.tags.join(', ') ?? '')}"></label>
    <label class="full">Registered asset <select name="imageAssetId">${assetOptions}</select>${assetRefNote}</label>
    <label class="full">Image path <input name="imagePath" value="${escapeHtml(message?.image_path ?? '')}"></label>
    <label class="full">Image alt text <input name="imageAlt" value="${escapeHtml(message?.image_alt ?? '')}"></label>
    </div>
    <div class="form-actions"><a class="button" href="/messages">Cancel</a><button class="button primary">Save</button></div>
  </form>`;
}

function renderAssets(assets: AssetRecord[], errorMsg?: string | null): string {
  const errorBanner = errorMsg
    ? `<div class="banner error">${escapeHtml(errorMsg)}</div>`
    : '';
  const rows = assets.map((asset) => {
    const thumbnail = asset.storage_kind === 'object_storage' && asset.public_url
      ? `<img src="${escapeHtml(asset.public_url)}" alt="${escapeHtml(asset.alt_text_default)}" style="width:48px;height:48px;object-fit:cover;border-radius:4px;display:block;">`
      : '';
    const locationCell = asset.storage_kind === 'object_storage' && asset.public_url
      ? `<a href="${escapeHtml(asset.public_url)}" target="_blank" rel="noopener noreferrer" style="word-break:break-all;">${escapeHtml(asset.public_url)}</a>`
      : escapeHtml(asset.path_or_object_key ?? 'Postgres bytea');
    return `<tr>
      <td>${thumbnail}</td>
      <td>${escapeHtml(asset.alt_text_default)}</td>
      <td>${escapeHtml(asset.storage_kind)}</td>
      <td>${locationCell}</td>
      <td>${escapeHtml(asset.mime_type)}</td>
      <td>${asset.width}x${asset.height}</td>
      <td>${asset.bytes}</td>
      <td class="actions"><form method="post" action="/assets/${escapeHtml(asset.id)}/delete"><button class="danger" onclick="return confirm('Permanently delete this asset from storage? This cannot be undone.')">Delete</button></form></td>
    </tr>`;
  }).join('');

  return `${errorBanner}<div class="page-head"><div><h2>Assets</h2><p class="muted">Register reusable images with default alt text before attaching them to saved messages.</p></div><a class="button primary" href="/assets/new">New asset</a></div>${rows ? `<table><thead><tr><th></th><th>Alt text</th><th>Storage</th><th>Location</th><th>MIME</th><th>Size</th><th>Bytes</th><th>Actions</th></tr></thead><tbody>${rows}</tbody></table>` : '<div class="empty">No image assets registered yet.</div>'}`;
}

function renderAssetForm(): string {
  return `<div class="page-head"><div><h2>New asset</h2><p class="muted">Upload an image to App Storage, or register a local file path.</p></div></div>
  <div class="form-panel" id="objectUploadPanel">
    <p style="margin:0 0 14px;font-size:13px;color:var(--muted);font-weight:600;text-transform:uppercase;letter-spacing:.05em;">Upload to App Storage</p>
    <div class="form-grid">
      <label class="full">Image file <input id="uploadFile" type="file" accept="image/*" required></label>
      <label class="full">Default alt text <input id="uploadAlt" placeholder="Describe the image for Bluesky alt text" required></label>
    </div>
    <div class="form-actions" style="align-items:center;">
      <span id="uploadStatus" style="font-size:13px;color:var(--muted);margin-right:auto;"></span>
      <a class="button" href="/assets">Cancel</a>
      <button class="button primary" id="uploadBtn" onclick="startUpload(event)">Upload to App Storage</button>
    </div>
  </div>
  <br>
  <form class="form-panel" method="post" action="/assets">
    <p style="margin:0 0 14px;font-size:13px;color:var(--muted);font-weight:600;text-transform:uppercase;letter-spacing:.05em;">Register local file path</p>
    <div class="form-grid">
      <label class="full">Path or object key <input name="pathOrObjectKey" placeholder="assets/images/originals/Nova1.jpg"></label>
      <label class="full">Default alt text <input name="altTextDefault" placeholder="Describe the image for Bluesky alt text"></label>
    </div>
    <div class="form-actions"><a class="button" href="/assets">Cancel</a><button class="button primary">Register path</button></div>
  </form>
  <script>
async function startUpload(e) {
  e.preventDefault();
  const file = document.getElementById('uploadFile').files[0];
  const alt = document.getElementById('uploadAlt').value.trim();
  const status = document.getElementById('uploadStatus');
  const btn = document.getElementById('uploadBtn');
  if (!file) { status.textContent = 'Please select an image file.'; status.style.color = 'var(--danger)'; return; }
  if (!alt) { status.textContent = 'Alt text is required.'; status.style.color = 'var(--danger)'; return; }
  btn.disabled = true;
  status.style.color = 'var(--muted)';
  try {
    status.textContent = 'Uploading to App Storage\u2026';
    const formData = new FormData();
    formData.append('file', file);
    formData.append('altTextDefault', alt);
    const resp = await fetch('/assets/upload-multipart', { method: 'POST', body: formData });
    if (!resp.ok) { const e = await resp.json().catch(()=>({})); throw new Error(e.error || 'Upload failed'); }
    window.location.href = '/assets';
  } catch (err) {
    status.textContent = 'Error: ' + err.message;
    status.style.color = 'var(--danger)';
    btn.disabled = false;
  }
}
  </script>`;
}

function renderSettings(settings: DashboardSettings): string {
  return `<div class="page-head"><div><h2>Settings</h2><p class="muted">The worker persists the next run time in Postgres so restarts do not cause catch-up bursts.</p></div></div>
  <form class="form-panel" method="post" action="/settings">
    <div class="form-grid">
    <label class="full"><span><input type="checkbox" name="enabled"${settings.enabled ? ' checked' : ''}> Enabled</span></label>
    <label>Minimum interval <input name="minIntervalMinutes" type="number" value="${settings.minIntervalMinutes}"></label>
    <label>Maximum interval <input name="maxIntervalMinutes" type="number" value="${settings.maxIntervalMinutes}"></label>
    <label>Timezone <input value="${escapeHtml(settings.timezone)}" disabled></label>
    <label>Next run <input value="${escapeHtml(settings.nextRunAt?.toISOString() ?? 'Not scheduled')}" disabled></label>
    </div>
    <div class="form-actions"><button class="button primary">Save</button></div>
  </form>`;
}

function renderRuns(runs: DashboardRun[]): string {
  const rows = runs.map((run) => `<tr><td><span class="badge ${escapeHtml(run.status)}">${escapeHtml(run.status)}</span></td><td>${escapeHtml(run.message_id)}</td><td>${escapeHtml(formatDate(run.attempted_at))}</td><td>${escapeHtml(run.bsky_uri ?? '')}</td><td>${escapeHtml(run.error ?? '')}</td></tr>`).join('');
  return `<div class="page-head"><div><h2>Runs</h2><p class="muted">Every live attempt, dry run, and failure is recorded here for auditability.</p></div></div>${rows ? `<table><thead><tr><th>Status</th><th>Message</th><th>Attempted</th><th>Bluesky URI</th><th>Error</th></tr></thead><tbody>${rows}</tbody></table>` : '<div class="empty">No scheduler attempts recorded yet.</div>'}`;
}

function formatDate(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}
