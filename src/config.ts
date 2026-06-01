export interface AppConfig {
  databaseUrl: string;
  port: number;
  dryRun: boolean;
  dashboard: {
    user: string;
    password: string;
    allowedReplitUsers: string[];
  };
  bluesky: {
    identifier: string | null;
    appPassword: string | null;
    serviceUrl: string;
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const databaseUrl = required(env, 'DATABASE_URL');

  return {
    databaseUrl,
    port: parsePort(env.PORT),
    dryRun: asBoolean(env.DRY_RUN),
    dashboard: {
      user: required(env, 'DASHBOARD_ADMIN_USER'),
      password: required(env, 'DASHBOARD_ADMIN_PASSWORD'),
      allowedReplitUsers: parseStringList(env.DASHBOARD_ALLOWED_REPLIT_USERS)
    },
    bluesky: {
      identifier: env.BSKY_IDENTIFIER ?? env.BSKY_HANDLE ?? null,
      appPassword: env.BSKY_APP_PASSWORD ?? env.BSKY_PASSWORD ?? null,
      serviceUrl: env.BSKY_SERVICE_URL ?? 'https://bsky.social'
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

function parseStringList(raw: string | undefined): string[] {
  if (!raw?.trim()) return [];
  return raw.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
}
