const TEST_DATABASE_URL_ENV = 'POSTGRES_TEST_DATABASE_URL';

type EnvLike = Record<string, string | undefined>;

export function getPostgresTestDatabaseUrl(env: EnvLike = process.env): string | undefined {
  const databaseUrl = env[TEST_DATABASE_URL_ENV]?.trim();
  if (!databaseUrl) return undefined;

  const appDatabaseUrl = env.DATABASE_URL?.trim();
  if (appDatabaseUrl && normalizeDatabaseUrl(databaseUrl) === normalizeDatabaseUrl(appDatabaseUrl)) {
    throw new Error(`${TEST_DATABASE_URL_ENV} must not match DATABASE_URL`);
  }

  assertSafePostgresTestDatabaseUrl(databaseUrl);
  return databaseUrl;
}

export function assertSafePostgresTestDatabaseUrl(databaseUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error(`${TEST_DATABASE_URL_ENV} must be a valid Postgres URL`);
  }

  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new Error(`${TEST_DATABASE_URL_ENV} must use the postgres:// or postgresql:// protocol`);
  }

  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\/+/, '')).toLowerCase();
  if (!hasStandaloneTestSegment(databaseName)) {
    throw new Error(`${TEST_DATABASE_URL_ENV} database name must include a standalone "test" segment`);
  }
}

function normalizeDatabaseUrl(databaseUrl: string): string {
  try {
    return new URL(databaseUrl.trim()).href;
  } catch {
    return databaseUrl.trim();
  }
}

function hasStandaloneTestSegment(databaseName: string): boolean {
  return databaseName.split(/[^a-z0-9]+|_+/).includes('test');
}
