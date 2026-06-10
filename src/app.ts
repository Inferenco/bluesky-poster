import { readFile } from 'node:fs/promises';
import path from 'node:path';
import Fastify, { type FastifyInstance, type FastifyRequest, type FastifyReply } from 'fastify';
import formbody from '@fastify/formbody';
import multipart from '@fastify/multipart';
import cookie from '@fastify/cookie';
import session from '@fastify/session';
import sharp from 'sharp';
import type { AppConfig } from './config.js';
import type { AssetRecord, RegisterLocalImageInput, RegisterObjectStorageImageInput } from './repositories/assets.js';
import { normalizePlatforms, type CreateMessageInput, type MessageRecord, type MessageStatus, type PostingPlatform } from './repositories/messages.js';
import { countGraphemes } from './validate.js';
import { downloadObject, uploadBuffer } from './replit_integrations/object_storage.js';
import type { PostGenerator } from './services/postGenerator.js';
import fastifyStatic from '@fastify/static';
import {
  LOGIN_MESSAGE,
  NONCE_MAX_AGE_MS,
  generateNonce,
  isAdmin,
  makeAdminFetcher,
  normalizeAddress,
  verifyWalletSignature,
  type AdminFetcher,
  type SignatureVerifier,
  type VerifyInput,
} from './auth/cedraAuth.js';

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
    get(id: string): Promise<AssetRecord | null>;
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
  platform: string;
  platform_uri: string | null;
  platform_url: string | null;
  error: string | null;
}

function makeRequireAuth(fetchAdmins: AdminFetcher) {
  return async function requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const sessionUser = request.session.user;
    if (!sessionUser) {
      void reply.type('text/html').send(renderLoginPage());
      return;
    }

    // Re-validate against the (TTL-cached) on-chain admin list so a removed
    // admin loses access promptly instead of after the session expires.
    const admins = await fetchAdmins().catch(() => null);
    if (admins && !isAdmin(sessionUser.address, admins)) {
      await request.session.destroy();
      void reply.code(403).type('text/html').send(renderForbiddenPage());
    }
  };
}

export async function buildApp(options: {
  config: Pick<AppConfig, 'auth'>;
  repositories: AppRepositories;
  postGenerator?: PostGenerator;
  auth?: {
    fetchAdmins?: AdminFetcher;
    verifySignature?: SignatureVerifier;
  };
}): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(formbody);
  await app.register(multipart, {
    limits: {
      fileSize: 2_000_000,
      files: 1
    }
  });
  await app.register(cookie);
  await app.register(session, {
    secret: process.env.SESSION_SECRET ?? 'fallback-secret-change-me-in-production!!',
    cookie: {
      secure: options.config.auth.secureCookies,
      httpOnly: true,
      maxAge: 7 * 24 * 60 * 60 * 1000,
    },
    saveUninitialized: false,
  });
  await app.register(fastifyStatic, {
    root: path.join(process.cwd(), 'public'),
    prefix: '/public/'
  });

  const fetchAdmins = options.auth?.fetchAdmins ?? makeAdminFetcher({
    fullnodeUrl: options.config.auth.cedraFullnodeUrl,
    contractAddress: options.config.auth.adminContractAddress,
    ttlMs: options.config.auth.adminCacheTtlMs,
    viewTimeoutMs: options.config.auth.adminViewTimeoutMs
  });
  const verifySignature = options.auth?.verifySignature ?? verifyWalletSignature;
  const requireAuth = makeRequireAuth(fetchAdmins);

  // Wallet auth routes
  app.get('/api/auth/nonce', async (request) => {
    const nonce = generateNonce();
    request.session.authNonce = nonce;
    request.session.authNonceIssuedAt = Date.now();
    await request.session.save();
    return { nonce, message: LOGIN_MESSAGE };
  });

  app.post<{ Body: VerifyInput }>('/api/auth/verify', async (request, reply) => {
    const { authNonce, authNonceIssuedAt } = request.session;
    if (!authNonce || !authNonceIssuedAt || Date.now() - authNonceIssuedAt > NONCE_MAX_AGE_MS) {
      return reply.code(401).send({ error: 'nonce_expired' });
    }
    request.session.authNonce = undefined;
    request.session.authNonceIssuedAt = undefined;

    const body = request.body ?? ({} as VerifyInput);
    if (!verifySignature(body, { nonce: authNonce, message: LOGIN_MESSAGE })) {
      await request.session.save();
      return reply.code(401).send({ error: 'invalid_signature' });
    }

    const address = normalizeAddress(body.address);
    if (!address) {
      await request.session.save();
      return reply.code(400).send({ error: 'invalid_address' });
    }
    let admins: string[];
    try {
      admins = await fetchAdmins();
    } catch (error) {
      request.log.warn({ err: error }, 'Admin lookup failed during wallet login');
      await request.session.save();
      return reply.code(502).send({ error: 'admin_lookup_failed' });
    }
    if (!isAdmin(address, admins)) {
      await request.session.save();
      return reply.code(403).send({ error: 'not_admin' });
    }

    request.session.user = { address };
    await request.session.save();
    return { ok: true };
  });

  app.get('/api/logout', async (request, reply) => {
    await request.session.destroy();
    return reply.redirect('/');
  });

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
    return reply.type('text/html').send(renderPage('Messages', 'messages', renderMessages(messages)));
  });

  app.get('/messages/new', { preHandler: requireAuth }, async (_request, reply) => {
    const assets = await options.repositories.assets.list();
    return reply.type('text/html').send(renderPage('New message', 'messages', renderMessageForm('/messages', assets)));
  });

  app.post('/messages/generate', { preHandler: requireAuth }, async (_request, reply) => {
    if (!options.postGenerator) {
      return reply.code(503).send({ error: 'OPENAI_API_KEY is not configured.' });
    }

    try {
      return reply.send(await options.postGenerator.generate());
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const statusCode = message.includes('OPENAI_API_KEY') ? 503 : 502;
      return reply.code(statusCode).send({ error: message });
    }
  });

  app.post('/messages', { preHandler: requireAuth }, async (request, reply) => {
    const body = form(request.body);
    await options.repositories.messages.create({
      body: String(body.body ?? ''),
      status: statusFrom(body.status, 'draft'),
      weight: positiveInteger(body.weight, 100),
      cooldownHours: positiveInteger(body.cooldownHours, 168),
      tags: normalizeTags(body.tags),
      platforms: platformsFrom(body.platforms),
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
    return reply.type('text/html').send(renderPage('Edit message', 'messages', renderMessageForm(`/messages/${message.id}`, assets, message, otherRefCount)));
  });

  app.post<{ Params: { id: string } }>('/messages/:id', { preHandler: requireAuth }, async (request, reply) => {
    const body = form(request.body);
    const input: Partial<CreateMessageInput> = {
      body: String(body.body ?? ''),
      status: statusFrom(body.status, 'draft'),
      weight: positiveInteger(body.weight, 100),
      cooldownHours: positiveInteger(body.cooldownHours, 168),
      tags: normalizeTags(body.tags),
      platforms: platformsFrom(body.platforms),
      imageAssetId: optionalString(body.imageAssetId),
      imageAlt: optionalString(body.imageAlt)
    };
    if (hasFormField(body, 'imagePath')) {
      input.imagePath = optionalString(body.imagePath);
    }
    await options.repositories.messages.update(request.params.id, input);
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
    return reply.type('text/html').send(renderPage('Settings', 'settings', renderSettings(settings)));
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
    return reply.type('text/html').send(renderPage('Runs', 'runs', renderRuns(runs)));
  });

  app.get<{ Querystring: { error?: string } }>('/assets', { preHandler: requireAuth }, async (request, reply) => {
    const assets = await options.repositories.assets.list();
    const errorMsg = request.query.error ? decodeURIComponent(request.query.error) : null;
    return reply.type('text/html').send(renderPage('Assets', 'assets', renderAssets(assets, errorMsg)));
  });

  app.get('/assets/new', { preHandler: requireAuth }, async (_request, reply) => {
    return reply.type('text/html').send(renderPage('New asset', 'assets', renderAssetForm()));
  });

  app.get<{ Params: { id: string } }>('/assets/:id/preview', { preHandler: requireAuth }, async (request, reply) => {
    const asset = await options.repositories.assets.get(request.params.id);
    if (!asset) return reply.code(404).send('Asset not found');

    try {
      const buffer = await readAssetPreview(asset);
      if (!buffer) return reply.code(404).send('Asset preview not available');
      return reply
        .header('cache-control', 'private, max-age=300')
        .type(asset.mime_type)
        .send(buffer);
    } catch (err) {
      request.log.warn({ err, assetId: asset.id }, 'Asset preview failed');
      return reply.code(404).send('Asset preview not available');
    }
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

function hasFormField(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function listFromCsv(value: unknown): string[] {
  return String(value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeTags(value: unknown): string[] {
  return listFromCsv(value).map((t) => t.replace(/^#+/, ''));
}

function platformsFrom(value: unknown): PostingPlatform[] {
  return normalizePlatforms(Array.isArray(value) ? value : value ? [value] : []);
}

function parseSchedulerIntervals(minValue: unknown, maxValue: unknown): { minIntervalMinutes: number; maxIntervalMinutes: number } | null {
  const minIntervalMinutes = Number(minValue);
  const maxIntervalMinutes = Number(maxValue);

  if (!Number.isInteger(minIntervalMinutes) || !Number.isInteger(maxIntervalMinutes)) return null;
  if (minIntervalMinutes < 1 || maxIntervalMinutes < 1) return null;
  if (maxIntervalMinutes < minIntervalMinutes) return null;

  return { minIntervalMinutes, maxIntervalMinutes };
}

async function readAssetPreview(asset: AssetRecord): Promise<Buffer | null> {
  if (asset.storage_kind === 'object_storage') {
    const objectKey = objectKeyFromAsset(asset);
    if (objectKey) {
      try {
        return await downloadObject(objectKey);
      } catch (err) {
        if (!asset.public_url) throw err;
      }
    }
    if (asset.public_url) {
      return downloadPublicStorageUrl(asset.public_url);
    }
    return null;
  }

  if (asset.content) {
    return asset.content;
  }

  if (asset.path_or_object_key) {
    return readFile(path.resolve(process.cwd(), asset.path_or_object_key));
  }

  return null;
}

function objectKeyFromAsset(asset: AssetRecord): string | null {
  const storedKey = asset.path_or_object_key?.trim();
  if (storedKey) {
    return storedKey.startsWith('https://') ? objectKeyFromPublicUrl(storedKey) : storedKey;
  }
  return objectKeyFromPublicUrl(asset.public_url);
}

function objectKeyFromPublicUrl(publicUrl: string | null): string | null {
  if (!publicUrl) return null;
  try {
    const url = new URL(publicUrl);
    if (url.protocol !== 'https:' || url.hostname !== 'storage.googleapis.com') return null;
    const [, ...keyParts] = url.pathname.replace(/^\/+/, '').split('/');
    const objectKey = keyParts.join('/');
    return objectKey ? decodeURIComponent(objectKey) : null;
  } catch {
    return null;
  }
}

async function downloadPublicStorageUrl(publicUrl: string): Promise<Buffer | null> {
  const url = new URL(publicUrl);
  if (url.protocol !== 'https:' || url.hostname !== 'storage.googleapis.com') return null;
  const response = await fetch(url);
  if (!response.ok) return null;
  return Buffer.from(await response.arrayBuffer());
}

type NavSection = 'messages' | 'assets' | 'settings' | 'runs';

type IconName =
  | 'messages'
  | 'assets'
  | 'settings'
  | 'runs'
  | 'logout'
  | 'plus'
  | 'edit'
  | 'pause'
  | 'check'
  | 'archive'
  | 'trash'
  | 'upload'
  | 'save'
  | 'sparkles';

function renderForbiddenPage(): string {
  return renderAuthPage({
    title: 'Access denied',
    message: 'This wallet is not an admin of the treasury contract.'
  });
}

function renderLoginPage(): string {
  return renderAuthPage({
    title: 'Inferenco Poster',
    message: 'Connect your Cedra wallet and sign a message to access the dashboard.',
    action: `<div id="wallet-login" class="wallet-login">
      <div id="wallet-buttons" class="auth-actions"></div>
      <p id="wallet-status" class="wallet-status" role="status"></p>
    </div>
    <script src="/public/login.js"></script>`
  });
}

function renderAuthPage(input: { title: string; message: string; action?: string }): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(input.title)} - Inferenco Poster</title>
  <style>
    ${brandStyles()}
    body { min-height: 100vh; display: grid; place-items: center; padding: 24px; }
    .auth-card { width: min(100%, 390px); border: 1px solid var(--border); border-radius: 8px; background: var(--panel); padding: 34px; box-shadow: var(--shadow); backdrop-filter: blur(18px); }
    .auth-brand { display: flex; align-items: center; justify-content: center; gap: 12px; margin-bottom: 20px; color: var(--text); }
    .auth-brand strong { font-size: 18px; line-height: 1.1; }
    h1 { margin: 0 0 10px; color: var(--text); font-size: 24px; line-height: 1.15; text-align: center; }
    p { margin: 0 0 26px; color: var(--muted); font-size: 14px; line-height: 1.55; text-align: center; }
    .auth-actions { display: flex; flex-direction: column; align-items: stretch; gap: 10px; }
    .wallet-status { min-height: 20px; margin: 14px 0 0; color: var(--muted); font-size: 13px; text-align: center; }
    .wallet-status.error { color: var(--danger); }
  </style>
</head>
<body>
  <section class="auth-card">
    <div class="auth-brand">${brandMark()}<strong>Inferenco<br><span>Poster</span></strong></div>
    <h1>${escapeHtml(input.title)}</h1>
    <p>${escapeHtml(input.message)}</p>
    ${input.action ? `<div class="auth-actions">${input.action}</div>` : ''}
  </section>
</body>
</html>`;
}

function renderPage(title: string, active: NavSection, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)} - Inferenco Poster</title>
  <style>
    ${brandStyles()}
    body { min-height: 100vh; }
    .shell { position: relative; z-index: 1; display: grid; grid-template-columns: 216px minmax(0, 1fr); min-height: 100vh; }
    .sidebar { display: flex; flex-direction: column; gap: 22px; min-height: 100vh; padding: 22px 14px; border-right: 1px solid var(--border); background: linear-gradient(180deg, rgba(10, 16, 31, .92), rgba(8, 10, 20, .86)); box-shadow: inset -1px 0 0 rgba(18, 215, 255, .08); backdrop-filter: blur(22px); }
    .brand { display: flex; align-items: center; gap: 11px; min-height: 54px; padding: 0 10px; color: var(--text); text-decoration: none; }
    .brand strong { font-size: 17px; line-height: 1.05; }
    .brand span { color: var(--cyan); }
    .nav-list { display: grid; gap: 8px; }
    .nav-link { display: flex; align-items: center; gap: 11px; min-height: 44px; border: 1px solid transparent; border-radius: 8px; padding: 0 12px; color: var(--muted); font-size: 15px; font-weight: 650; text-decoration: none; }
    .nav-link:hover { color: var(--text); border-color: rgba(68, 103, 154, .42); background: rgba(14, 17, 29, .72); text-decoration: none; }
    .nav-link.active { color: var(--text); border-color: rgba(20, 120, 255, .72); background: linear-gradient(135deg, rgba(18, 215, 255, .12), rgba(20, 120, 255, .24)); box-shadow: 0 0 0 1px rgba(18, 215, 255, .08), 0 12px 36px rgba(20, 120, 255, .18); }
    .nav-link .icon { color: currentColor; }
    .sidebar-footer { margin-top: auto; padding-top: 18px; border-top: 1px solid rgba(68, 103, 154, .24); }
    main { min-width: 0; padding: 30px clamp(18px, 3vw, 38px); }
    .topline { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 24px; }
    .app-title { margin: 0; color: var(--text); font-size: 22px; line-height: 1.1; }
    .env-chip { display: inline-flex; align-items: center; min-height: 34px; border: 1px solid rgba(68, 103, 154, .42); border-radius: 8px; padding: 0 12px; color: var(--muted); background: rgba(7, 8, 18, .56); font-size: 13px; }
    .content-panel { border: 1px solid var(--border); border-radius: 8px; background: var(--panel); box-shadow: var(--shadow); backdrop-filter: blur(20px); overflow: hidden; }
    .page-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; padding: 26px 26px 18px; border-bottom: 1px solid rgba(68, 103, 154, .24); }
    .page-head h2 { margin: 0; color: var(--text); font-size: 30px; line-height: 1.1; }
    .page-head p { margin: 8px 0 0; color: var(--muted); font-size: 14px; line-height: 1.55; }
    .section-body { padding: 0 24px 24px; }
    .button, button, .action-button { appearance: none; display: inline-flex; align-items: center; justify-content: center; gap: 8px; min-height: 36px; border: 1px solid var(--border); border-radius: 8px; padding: 0 13px; background: rgba(8, 12, 24, .72); color: var(--text); font: inherit; font-size: 13px; font-weight: 700; line-height: 1; text-decoration: none; cursor: pointer; transition: border-color .15s ease, background .15s ease, color .15s ease, transform .15s ease; }
    .button:hover, button:hover, .action-button:hover { border-color: rgba(18, 215, 255, .58); background: rgba(18, 215, 255, .10); text-decoration: none; }
    .button.primary, button.primary { border-color: rgba(20, 120, 255, .9); background: linear-gradient(135deg, var(--cyan), var(--blue)); color: #ffffff; box-shadow: 0 12px 32px rgba(20, 120, 255, .30); }
    .button.primary:hover, button.primary:hover { transform: translateY(-1px); }
    .action-button.danger, button.danger { border-color: rgba(255, 77, 94, .46); color: var(--danger); }
    .action-button.danger:hover, button.danger:hover { background: rgba(255, 77, 94, .10); border-color: rgba(255, 77, 94, .70); }
    table { width: 100%; min-width: 960px; border-collapse: collapse; }
    th, td { border-bottom: 1px solid rgba(68, 103, 154, .24); padding: 14px 16px; text-align: left; vertical-align: top; font-size: 13px; }
    th { color: var(--muted); background: rgba(8, 12, 24, .68); font-size: 12px; font-weight: 800; text-transform: uppercase; letter-spacing: 0; }
    tr:last-child td { border-bottom: 0; }
    tbody tr { background: rgba(7, 8, 18, .18); }
    tbody tr:hover { background: rgba(18, 215, 255, .045); }
    .table-wrap { overflow-x: auto; border: 1px solid rgba(68, 103, 154, .22); border-radius: 8px; }
    .message-cell { max-width: 560px; color: var(--text); white-space: pre-wrap; line-height: 1.55; }
    .numeric { color: var(--text); white-space: nowrap; }
    .actions { display: flex; flex-wrap: wrap; gap: 8px; min-width: 216px; }
    .actions form { display: inline-flex; }
    .badge { display: inline-flex; align-items: center; gap: 7px; min-height: 26px; border: 1px solid rgba(168, 180, 200, .28); border-radius: 999px; padding: 0 10px; color: var(--muted); background: rgba(168, 180, 200, .07); font-size: 12px; font-weight: 800; }
    .badge::before { content: ""; width: 7px; height: 7px; border-radius: 50%; background: currentColor; box-shadow: 0 0 14px currentColor; }
    .badge.approved, .badge.posted, .badge.success { border-color: rgba(38, 224, 143, .42); color: var(--success); background: rgba(38, 224, 143, .09); }
    .badge.paused, .badge.skipped, .badge.dry_run { border-color: rgba(255, 194, 71, .44); color: var(--warning); background: rgba(255, 194, 71, .09); }
    .badge.draft { border-color: rgba(20, 120, 255, .52); color: #4f9dff; background: rgba(20, 120, 255, .11); }
    .badge.archived, .badge.failed, .badge.error { border-color: rgba(255, 77, 94, .44); color: var(--danger); background: rgba(255, 77, 94, .09); }
    .tag-list { display: flex; flex-wrap: wrap; gap: 6px; min-width: 120px; }
    .tag { display: inline-flex; align-items: center; min-height: 24px; border: 1px solid rgba(20, 120, 255, .46); border-radius: 7px; padding: 0 8px; color: #61a8ff; background: rgba(20, 120, 255, .10); font-size: 12px; font-weight: 650; }
    .form-panel { max-width: 860px; border: 1px solid rgba(68, 103, 154, .24); border-radius: 8px; background: rgba(7, 8, 18, .34); padding: 22px; }
    .form-tools { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; margin-bottom: 16px; }
    .form-tools .upload-status { margin-right: 0; }
    .form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
    label { display: grid; gap: 8px; color: var(--muted); font-size: 13px; font-weight: 700; }
    small { color: var(--muted-2); font-size: 12px; line-height: 1.45; }
    input, select, textarea { width: 100%; border: 1px solid rgba(68, 103, 154, .42); border-radius: 8px; background: rgba(7, 8, 18, .76); color: var(--text); padding: 10px 11px; font: inherit; font-size: 14px; outline: none; }
    input:focus, select:focus, textarea:focus { border-color: rgba(18, 215, 255, .74); box-shadow: 0 0 0 3px rgba(18, 215, 255, .12); }
    input:disabled { color: var(--muted); background: rgba(168, 180, 200, .08); }
    input[type="checkbox"] { width: 18px; height: 18px; accent-color: var(--cyan); }
    textarea { min-height: 168px; resize: vertical; grid-column: 1 / -1; line-height: 1.55; }
    .full { grid-column: 1 / -1; }
    .checkbox-label span { display: inline-flex; align-items: center; gap: 10px; color: var(--text); }
    .checkbox-group { display: flex; flex-wrap: wrap; gap: 14px; }
    .checkbox-group .checkbox-label { display: inline-grid; }
    .form-actions { display: flex; align-items: center; justify-content: flex-end; gap: 10px; margin-top: 18px; }
    .upload-status { color: var(--muted); font-size: 13px; margin-right: auto; }
    .empty { border: 1px dashed rgba(68, 103, 154, .48); border-radius: 8px; padding: 30px; color: var(--muted); background: rgba(7, 8, 18, .28); }
    .banner { border-radius: 8px; padding: 12px 14px; margin-bottom: 16px; font-size: 14px; font-weight: 650; }
    .banner.error { border: 1px solid rgba(255, 77, 94, .42); color: var(--danger); background: rgba(255, 77, 94, .10); }
    .asset-preview-cell { width: 72px; }
    .thumb-frame { position: relative; display: grid; place-items: center; width: 50px; height: 50px; overflow: hidden; border: 1px solid rgba(68, 103, 154, .46); border-radius: 8px; background: linear-gradient(135deg, rgba(18, 215, 255, .16), rgba(20, 120, 255, .08)); }
      .thumb { width: 100%; height: 100%; object-fit: cover; display: block; }
      .thumb[hidden] { display: none; }
      .thumb-placeholder { display: none; place-items: center; width: 100%; height: 100%; color: var(--cyan); opacity: .72; }
      .thumb-frame.preview-error .thumb-placeholder { display: grid; }
      .thumb-placeholder svg { width: 18px; height: 18px; }
    .location-cell { max-width: 560px; }
    .location-link { display: block; max-width: min(58vw, 700px); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .muted { color: var(--muted); }
    @media (max-width: 900px) {
      .shell { grid-template-columns: 1fr; }
      .sidebar { position: sticky; top: 0; z-index: 3; min-height: auto; flex-direction: row; align-items: center; gap: 10px; padding: 12px; overflow-x: auto; border-right: 0; border-bottom: 1px solid var(--border); }
      .brand { min-height: 42px; flex: 0 0 auto; }
      .brand strong { font-size: 14px; }
      .nav-list { display: flex; gap: 8px; }
      .nav-link { min-height: 38px; white-space: nowrap; }
      .sidebar-footer { margin-top: 0; padding-top: 0; border-top: 0; margin-left: auto; }
      main { padding: 18px; }
      .topline { display: none; }
      .page-head { flex-direction: column; padding: 22px 18px 16px; }
      .section-body { padding: 0 16px 16px; }
      .form-grid { grid-template-columns: 1fr; }
      .actions { min-width: 190px; }
    }
    @media (max-width: 560px) {
      .brand strong { display: none; }
      .nav-link span { display: none; }
      .page-head h2 { font-size: 25px; }
      .button, button, .action-button { min-height: 34px; padding: 0 10px; }
    }
  </style>
</head>
<body>
  <div class="shell">
    <aside class="sidebar">
      <a class="brand" href="/messages" aria-label="Inferenco Poster home">${brandMark()}<strong>Inferenco<br><span>Poster</span></strong></a>
      <nav class="nav-list" aria-label="Dashboard">
        ${renderNavLink('messages', '/messages', 'Messages', 'messages', active)}
        ${renderNavLink('assets', '/assets', 'Assets', 'assets', active)}
        ${renderNavLink('settings', '/settings', 'Settings', 'settings', active)}
        ${renderNavLink('runs', '/runs', 'Runs', 'runs', active)}
      </nav>
      <div class="sidebar-footer">
        <a class="nav-link" href="/api/logout">${icon('logout')}<span>Sign out</span></a>
      </div>
    </aside>
    <main>
      <div class="topline">
        <h1 class="app-title">Inferenco Poster</h1>
        <span class="env-chip">Private publishing dashboard</span>
      </div>
      ${body}
    </main>
  </div>
</body>
</html>`;
}

function renderMessages(messages: MessageRecord[]): string {
  const rows = messages.map((message) => `<tr>
    <td class="message-cell">${escapeHtml(message.body)}</td>
    <td>${renderBadge(message.status)}</td>
    <td class="numeric">${message.weight}</td>
    <td class="numeric">${message.cooldown_hours}h</td>
    <td class="numeric">${message.post_count}</td>
    <td class="numeric">${countGraphemes(message.body)}/300</td>
    <td>${renderPlatforms(message.platforms)}</td>
    <td>${renderTags(message.tags)}</td>
    <td class="actions">
      <a class="action-button" href="/messages/${escapeHtml(message.id)}/edit">${icon('edit')}<span>Edit</span></a>
      <form method="post" action="/messages/${escapeHtml(message.id)}/status"><input type="hidden" name="status" value="paused"><button class="action-button" onclick="return confirm('Pause this message? It will stop being selected for posting.')">${icon('pause')}<span>Pause</span></button></form>
      <form method="post" action="/messages/${escapeHtml(message.id)}/status"><input type="hidden" name="status" value="approved"><button class="action-button">${icon('check')}<span>Approve</span></button></form>
      <form method="post" action="/messages/${escapeHtml(message.id)}/status"><input type="hidden" name="status" value="archived"><button class="action-button" onclick="return confirm('Archive this message? It will be removed from the posting rotation.')">${icon('archive')}<span>Archive</span></button></form>
      <form method="post" action="/messages/${escapeHtml(message.id)}/delete"><button class="action-button danger" onclick="return confirm('Permanently delete this message? This cannot be undone.')">${icon('trash')}<span>Delete</span></button></form>
    </td>
  </tr>`).join('');

  return `<section class="content-panel">
    <div class="page-head"><div><h2>Messages</h2><p>Create, manage, and publish saved Bluesky posts.</p></div><a class="button primary" href="/messages/new">${icon('plus')}<span>New message</span></a></div>
    <div class="section-body">${rows ? `<div class="table-wrap"><table><thead><tr><th>Message</th><th>Status</th><th>Weight</th><th>Cooldown</th><th>Posts</th><th>Length</th><th>Platforms</th><th>Tags</th><th>Actions</th></tr></thead><tbody>${rows}</tbody></table></div>` : '<div class="empty">No saved messages yet.</div>'}</div>
  </section>`;
}

function renderMessageForm(action: string, assets: AssetRecord[], message?: MessageRecord, assetOtherRefCount?: number): string {
  const assetOptions = [
    `<option value="">No image asset</option>`,
    ...assets.map((asset) => `<option value="${escapeHtml(asset.id)}"${message?.image_asset_id === asset.id ? ' selected' : ''}>${escapeHtml(asset.alt_text_default)} (${escapeHtml(asset.path_or_object_key ?? storageKindLabel(asset.storage_kind))})</option>`)
  ].join('');

  const assetRefNote = message?.image_asset_id && assetOtherRefCount != null && assetOtherRefCount > 0
    ? ` <span class="muted" title="Swapping or removing this asset will not affect other messages, but the asset may still be in use.">Used by ${assetOtherRefCount} other ${assetOtherRefCount === 1 ? 'message' : 'messages'}</span>`
    : '';

  const selectedPlatforms = normalizePlatforms(message?.platforms);

  return `<section class="content-panel">
    <div class="page-head"><div><h2>${message ? 'Edit' : 'New'} message</h2><p>Approved messages enter the scheduler pool. Drafts and paused messages stay out of rotation.</p></div></div>
    <div class="section-body">
      <form class="form-panel" method="post" action="${escapeHtml(action)}">
        <div class="form-tools">
          <button type="button" class="button" id="generatePostBtn" onclick="generatePostSuggestion(event)">${icon('sparkles')}<span>Generate post</span></button>
          <span id="generatePostStatus" class="upload-status" aria-live="polite"></span>
        </div>
        <div class="form-grid">
          <label class="full">Body <textarea name="body" id="messageBody">${escapeHtml(message?.body ?? '')}</textarea></label>
          <label>Status <select name="status">
            ${['draft', 'approved', 'paused', 'archived'].map((status) => `<option value="${status}"${message?.status === status ? ' selected' : ''}>${status}</option>`).join('')}
          </select></label>
          <label>Weight <input name="weight" type="number" min="1" value="${message?.weight ?? 100}"></label>
          <label>Cooldown hours <input name="cooldownHours" type="number" min="1" value="${message?.cooldown_hours ?? 168}"></label>
          <label>Tags <input name="tags" id="messageTags" value="${escapeHtml(message?.tags.join(', ') ?? '')}" placeholder="travel, photography"><small>Comma-separated words (no # needed). Appended as hashtags at the end of the post.</small></label>
          <label class="full">Platforms
            <span class="checkbox-group">
              <label class="checkbox-label"><span><input type="checkbox" name="platforms" value="bluesky"${selectedPlatforms.includes('bluesky') ? ' checked' : ''}> Bluesky</span></label>
              <label class="checkbox-label"><span><input type="checkbox" name="platforms" value="mastodon"${selectedPlatforms.includes('mastodon') ? ' checked' : ''}> Mastodon</span></label>
            </span>
          </label>
          <label class="full">Registered asset <select name="imageAssetId">${assetOptions}</select>${assetRefNote}</label>
          <label class="full">Image alt text <input name="imageAlt" value="${escapeHtml(message?.image_alt ?? '')}"></label>
        </div>
        <div class="form-actions"><a class="button" href="/messages">Cancel</a><button class="button primary">${icon('save')}<span>Save</span></button></div>
      </form>
    </div>
  </section>
  <script>
async function generatePostSuggestion(e) {
  e.preventDefault();
  const btn = document.getElementById('generatePostBtn');
  const status = document.getElementById('generatePostStatus');
  const body = document.getElementById('messageBody');
  const tags = document.getElementById('messageTags');
  btn.disabled = true;
  status.style.color = 'var(--muted)';
  status.textContent = 'Generating...';
  try {
    const resp = await fetch('/messages/generate', { method: 'POST' });
    const payload = await resp.json().catch(function () { return {}; });
    if (!resp.ok) throw new Error(payload.error || 'Generation failed');
    body.value = payload.body || '';
    tags.value = Array.isArray(payload.tags) ? payload.tags.join(', ') : '';
    status.style.color = 'var(--success)';
    status.textContent = 'Draft ready.';
  } catch (err) {
    status.style.color = 'var(--danger)';
    status.textContent = err.message;
  } finally {
    btn.disabled = false;
  }
}
  </script>`;
}

function renderAssets(assets: AssetRecord[], errorMsg?: string | null): string {
  const errorBanner = errorMsg
    ? `<div class="banner error">${escapeHtml(errorMsg)}</div>`
    : '';
  const rows = assets.map((asset) => {
    const locationCell = asset.storage_kind === 'object_storage' && asset.public_url
      ? `<a class="location-link" href="${escapeHtml(asset.public_url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(asset.public_url)}</a>`
      : escapeHtml(asset.path_or_object_key ?? 'Postgres bytea');
    return `<tr>
      <td class="asset-preview-cell">${renderAssetThumbnail(asset)}</td>
      <td>${escapeHtml(asset.alt_text_default)}</td>
      <td>${renderBadge(storageKindLabel(asset.storage_kind), asset.storage_kind)}</td>
      <td class="location-cell">${locationCell}</td>
      <td>${escapeHtml(asset.mime_type)}</td>
      <td class="numeric">${asset.width}x${asset.height}</td>
      <td class="numeric">${asset.bytes}</td>
      <td class="actions"><form method="post" action="/assets/${escapeHtml(asset.id)}/delete"><button class="action-button danger" onclick="return confirm('Permanently delete this asset from storage? This cannot be undone.')">${icon('trash')}<span>Delete</span></button></form></td>
    </tr>`;
  }).join('');

  return `<section class="content-panel">
    <div class="page-head"><div><h2>Assets</h2><p>Manage reusable images with default alt text before attaching them to saved messages.</p></div><a class="button primary" href="/assets/new">${icon('plus')}<span>New asset</span></a></div>
    <div class="section-body">${errorBanner}${rows ? `<div class="table-wrap"><table><thead><tr><th></th><th>Alt text</th><th>Storage</th><th>Location</th><th>MIME</th><th>Size</th><th>Bytes</th><th>Actions</th></tr></thead><tbody>${rows}</tbody></table></div>` : '<div class="empty">No image assets registered yet.</div>'}</div>
  </section>`;
}

function renderAssetThumbnail(asset: AssetRecord): string {
  const hasPreview = Boolean(asset.path_or_object_key || asset.public_url || asset.content);
  const placeholder = `<span class="thumb-placeholder" aria-hidden="true">${icon('assets')}</span>`;
  const image = hasPreview
    ? `<img class="thumb" src="/assets/${escapeHtml(asset.id)}/preview" alt="" loading="lazy" onerror="this.hidden=true;this.parentElement.classList.add('preview-error')">`
    : '';
  return `<div class="thumb-frame" title="${escapeHtml(asset.alt_text_default)}">${image}${placeholder}</div>`;
}

function renderAssetForm(): string {
  return `<section class="content-panel">
    <div class="page-head"><div><h2>New asset</h2><p>Upload an image to Replit App Storage for durable use in scheduled posts.</p></div></div>
    <div class="section-body">
      <div class="form-panel" id="objectUploadPanel">
        <div class="form-grid">
          <label class="full">Image file <input id="uploadFile" type="file" accept="image/*" required></label>
          <label class="full">Default alt text <input id="uploadAlt" placeholder="Describe the image for Bluesky alt text" required></label>
        </div>
        <div class="form-actions">
          <span id="uploadStatus" class="upload-status"></span>
          <a class="button" href="/assets">Cancel</a>
          <button class="button primary" id="uploadBtn" onclick="startUpload(event)">${icon('upload')}<span>Upload to App Storage</span></button>
        </div>
      </div>
    </div>
  </section>
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
    status.textContent = 'Uploading to App Storage...';
    const formData = new FormData();
    formData.append('file', file);
    formData.append('altTextDefault', alt);
    const resp = await fetch('/assets/upload-multipart', { method: 'POST', body: formData });
    if (!resp.ok) { const e = await resp.json().catch(function () { return {}; }); throw new Error(e.error || 'Upload failed'); }
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
  return `<section class="content-panel">
    <div class="page-head"><div><h2>Settings</h2><p>The worker persists the next run time in Postgres so restarts do not cause catch-up bursts.</p></div></div>
    <div class="section-body">
      <form class="form-panel" method="post" action="/settings">
        <div class="form-grid">
          <label class="full checkbox-label"><span><input type="checkbox" name="enabled"${settings.enabled ? ' checked' : ''}> Enabled</span></label>
          <label>Minimum interval <input name="minIntervalMinutes" type="number" value="${settings.minIntervalMinutes}"></label>
          <label>Maximum interval <input name="maxIntervalMinutes" type="number" value="${settings.maxIntervalMinutes}"></label>
          <label>Timezone <input value="${escapeHtml(settings.timezone)}" disabled></label>
          <label>Next run <input value="${escapeHtml(settings.nextRunAt?.toISOString() ?? 'Not scheduled')}" disabled></label>
        </div>
        <div class="form-actions"><button class="button primary">${icon('save')}<span>Save</span></button></div>
      </form>
    </div>
  </section>`;
}

function renderRuns(runs: DashboardRun[]): string {
  const rows = runs.map((run) => `<tr><td>${renderBadge(run.status)}</td><td>${renderBadge(platformLabel(run.platform), run.platform)}</td><td>${escapeHtml(run.message_id)}</td><td>${escapeHtml(formatDate(run.attempted_at))}</td><td>${escapeHtml(run.platform_url ?? run.platform_uri ?? run.bsky_uri ?? '')}</td><td>${escapeHtml(run.error ?? '')}</td></tr>`).join('');
  return `<section class="content-panel">
    <div class="page-head"><div><h2>Runs</h2><p>Every live attempt, dry run, and failure is recorded here for auditability.</p></div></div>
    <div class="section-body">${rows ? `<div class="table-wrap"><table><thead><tr><th>Status</th><th>Platform</th><th>Message</th><th>Attempted</th><th>Platform URL</th><th>Error</th></tr></thead><tbody>${rows}</tbody></table></div>` : '<div class="empty">No scheduler attempts recorded yet.</div>'}</div>
  </section>`;
}

function brandStyles(): string {
  return `
    :root {
      color-scheme: dark;
      --bg: #070812;
      --panel: rgba(14, 17, 29, 0.84);
      --panel-strong: rgba(14, 17, 29, 0.96);
      --text: #f7fbff;
      --muted: #a8b4c8;
      --muted-2: #77849a;
      --border: rgba(68, 103, 154, 0.34);
      --cyan: #12d7ff;
      --blue: #1478ff;
      --danger: #ff4d5e;
      --warning: #ffc247;
      --success: #26e08f;
      --shadow: 0 24px 70px rgba(0, 0, 0, .34), 0 0 0 1px rgba(18, 215, 255, .03);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    * { box-sizing: border-box; }
    html { min-height: 100%; background: var(--bg); }
    body { margin: 0; background: var(--bg); color: var(--text); }
    body::before {
      content: "";
      position: fixed;
      inset: -10%;
      z-index: 0;
      pointer-events: none;
      background:
        radial-gradient(circle at 12% 42%, rgba(18, 215, 255, .14) 0 12%, transparent 24%),
        radial-gradient(circle at 31% 64%, rgba(18, 215, 255, .12) 0 10%, transparent 22%),
        radial-gradient(circle at 52% 12%, rgba(20, 120, 255, .14) 0 10%, transparent 20%),
        radial-gradient(circle at 78% 26%, rgba(18, 215, 255, .12) 0 11%, transparent 24%),
        radial-gradient(circle at 88% 76%, rgba(18, 215, 255, .11) 0 10%, transparent 22%),
        linear-gradient(180deg, rgba(7, 8, 18, .30), rgba(7, 8, 18, .94));
      opacity: .9;
      transform: translate3d(0, 0, 0) scale(1);
      animation: ambient-drift 24s ease-in-out infinite alternate;
    }
    @keyframes ambient-drift {
      from { transform: translate3d(-1.5%, -1%, 0) scale(1); }
      to { transform: translate3d(1.5%, 1%, 0) scale(1.05); }
    }
    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after { animation-duration: .01ms !important; animation-iteration-count: 1 !important; scroll-behavior: auto !important; transition-duration: .01ms !important; }
      body::before { animation: none !important; }
    }
    a { color: var(--cyan); text-decoration: none; }
    a:hover { text-decoration: underline; }
    .brand-mark { display: inline-grid; place-items: center; width: 36px; height: 36px; flex: 0 0 auto; border-radius: 8px; color: #00121a; background: linear-gradient(135deg, var(--cyan), var(--blue)); box-shadow: 0 0 26px rgba(18, 215, 255, .34); }
    .brand-mark svg { width: 25px; height: 25px; display: block; color: #04111b; }
    .icon { width: 17px; height: 17px; flex: 0 0 auto; display: inline-block; stroke-width: 2; }
  `;
}

function brandMark(): string {
  return `<span class="brand-mark" aria-hidden="true"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M12.7 2.2c.6 3.6-1.6 5.7-3.8 7.8-1.8 1.8-3.6 3.5-3.6 6.2 0 3.3 2.7 5.8 6.4 5.8 4.6 0 7.4-3.1 7.4-7.2 0-3.4-1.9-5.9-4.4-8.4-.3 2.3-1.6 3.8-3.5 5.4 1.2-2.7 1.2-5.3 1.5-9.6Z"/><path d="M12 18.4c-1.7 0-3-.9-3-2.4 0-1.3 1-2.3 2.4-3.4.3 1.5 1.1 2.3 2.1 3.1.9.8.4 2.7-1.5 2.7Z" opacity=".55"/></svg></span>`;
}

function renderNavLink(section: NavSection, href: string, label: string, iconName: IconName, active: NavSection): string {
  const isActive = section === active;
  return `<a class="nav-link${isActive ? ' active' : ''}" href="${href}"${isActive ? ' aria-current="page"' : ''}>${icon(iconName)}<span>${label}</span></a>`;
}

function renderBadge(label: string, className = label): string {
  return `<span class="badge ${escapeHtml(className.toLowerCase())}">${escapeHtml(label)}</span>`;
}

function renderTags(tags: string[]): string {
  if (tags.length === 0) return '<span class="muted">-</span>';
  return `<div class="tag-list">${tags.map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join('')}</div>`;
}

function renderPlatforms(platforms: PostingPlatform[]): string {
  return `<div class="tag-list">${normalizePlatforms(platforms).map((platform) => `<span class="tag">${escapeHtml(platformLabel(platform))}</span>`).join('')}</div>`;
}

function platformLabel(platform: string): string {
  if (platform === 'mastodon') return 'Mastodon';
  return 'Bluesky';
}

function storageKindLabel(kind: AssetRecord['storage_kind']): string {
  if (kind === 'object_storage') return 'App Storage';
  if (kind === 'database') return 'Database blob';
  return 'Legacy path';
}

function icon(name: IconName): string {
  const paths: Record<IconName, string> = {
    messages: '<path d="M4 5.5h16v10H8.5L4 19.5v-14Z"/><path d="M8 9h8M8 12h5"/>',
    assets: '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="m7 16 3.4-3.5 2.3 2.4 2.1-2.1L18 16"/><circle cx="8.5" cy="8.5" r="1.1"/>',
    settings: '<path d="M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Z"/><path d="M19 13.4v-2.8l-2-.6a5.7 5.7 0 0 0-.7-1.6l1-1.8-2-2-1.8 1a5.7 5.7 0 0 0-1.6-.7L11.4 3H8.6L8 5a5.7 5.7 0 0 0-1.6.7l-1.8-1-2 2 1 1.8a5.7 5.7 0 0 0-.7 1.6l-2 .6v2.8l2 .6c.2.6.4 1.1.7 1.6l-1 1.8 2 2 1.8-1c.5.3 1 .5 1.6.7l.6 2h2.8l.6-2c.6-.2 1.1-.4 1.6-.7l1.8 1 2-2-1-1.8c.3-.5.5-1 .7-1.6l1.9-.7Z"/>',
    runs: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
    logout: '<path d="M9 6H5.5A1.5 1.5 0 0 0 4 7.5v9A1.5 1.5 0 0 0 5.5 18H9"/><path d="M13 8l4 4-4 4M17 12H8"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    edit: '<path d="M4 20h4l10.5-10.5a2.1 2.1 0 0 0-3-3L5 17v3Z"/><path d="m14 8 2 2"/>',
    pause: '<circle cx="12" cy="12" r="8.5"/><path d="M9.5 8.5v7M14.5 8.5v7"/>',
    check: '<circle cx="12" cy="12" r="8.5"/><path d="m8 12.4 2.6 2.6L16 9.5"/>',
    archive: '<path d="M4 7h16v4H4z"/><path d="M6 11v7h12v-7M10 14h4"/>',
    trash: '<path d="M4.5 7h15M10 11v6M14 11v6M6.5 7l1 13h9l1-13M9 7l1-3h4l1 3"/>',
    upload: '<path d="M12 16V5M8 9l4-4 4 4"/><path d="M5 18.5h14"/>',
    save: '<path d="M5 4h12l2 2v14H5V4Z"/><path d="M8 4v6h8M8 17h8"/>',
    sparkles: '<path d="M12 3.5 13.8 9l5.7 2-5.7 2L12 18.5 10.2 13l-5.7-2 5.7-2L12 3.5Z"/><path d="m18 4 .6 1.8L20.5 6l-1.9.7L18 9l-.6-2.3L15.5 6l1.9-.2L18 4ZM5.5 15l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8.8-2.2Z"/>'
  };
  return `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name]}</svg>`;
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
