export interface AppConfig {
  databaseUrl: string;
  port: number;
  dryRun: boolean;
  auth: {
    cedraFullnodeUrl: string;
    adminContractAddress: string;
    adminCacheTtlMs: number;
    adminViewTimeoutMs: number;
    secureCookies: boolean;
  };
  bluesky: {
    identifier: string | null;
    appPassword: string | null;
    serviceUrl: string;
  };
  ai: {
    openaiApiKey: string | null;
    openaiPostModel: string;
  };
  mastodon: {
    instanceUrl: string | null;
    accessToken: string | null;
    visibility: MastodonVisibility;
  };
}

export type MastodonVisibility = 'public' | 'unlisted' | 'private' | 'direct';

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const databaseUrl = required(env, 'DATABASE_URL');

  return {
    databaseUrl,
    port: parsePort(env.PORT),
    dryRun: asBoolean(env.DRY_RUN),
    auth: {
      cedraFullnodeUrl: env.CEDRA_FULLNODE_URL?.trim() || 'https://testnet.cedra.dev/v1',
      adminContractAddress:
        env.ADMIN_CONTRACT_ADDRESS?.trim() ||
        '0xbdf9c94e797716648980ed99a0c6e2b3d6452ce5c1d28dbad3517a9be682b724',
      adminCacheTtlMs: parsePositiveInt(env.ADMIN_CACHE_TTL_MS, 60_000),
      adminViewTimeoutMs: parsePositiveInt(env.ADMIN_VIEW_TIMEOUT_MS, 5_000),
      secureCookies: env.COOKIE_SECURE === undefined ? true : asBoolean(env.COOKIE_SECURE)
    },
    bluesky: {
      identifier: env.BSKY_IDENTIFIER ?? env.BSKY_HANDLE ?? null,
      appPassword: env.BSKY_APP_PASSWORD ?? env.BSKY_PASSWORD ?? null,
      serviceUrl: env.BSKY_SERVICE_URL ?? 'https://bsky.social'
    },
    ai: {
      openaiApiKey: env.OPENAI_API_KEY?.trim() || null,
      openaiPostModel: env.OPENAI_POST_MODEL?.trim() || 'gpt-5.4-mini'
    },
    mastodon: {
      instanceUrl: normalizeOptionalUrl(env.MASTODON_INSTANCE_URL),
      accessToken: env.MASTODON_ACCESS_TOKEN?.trim() || null,
      visibility: parseMastodonVisibility(env.MASTODON_VISIBILITY)
    }
  };
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (!value?.trim()) {
    throw new Error(`${key} is required`);
  }
  return value;
}

function parsePort(raw: string | undefined): number {
  if (!raw) return 3000;
  const port = Number(raw);
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error('PORT must be a positive integer');
  }
  return port;
}

function asBoolean(raw: string | undefined): boolean {
  return ['1', 'true', 'yes', 'on'].includes(String(raw ?? '').toLowerCase());
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw?.trim()) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error('Expected a positive integer');
  }
  return value;
}

function normalizeOptionalUrl(raw: string | undefined): string | null {
  const value = raw?.trim() || 'https://mastodon.social';
  return value.replace(/\/+$/, '');
}

function parseMastodonVisibility(raw: string | undefined): MastodonVisibility {
  const value = raw?.trim().toLowerCase();
  if (value === 'unlisted' || value === 'private' || value === 'direct') return value;
  return 'public';
}
