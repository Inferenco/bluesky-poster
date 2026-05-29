import { describe, expect, test } from 'vitest';
import { loadConfig } from '../config.js';

describe('loadConfig', () => {
  test('requires DATABASE_URL and dashboard credentials', () => {
    expect(() => loadConfig({})).toThrow('DATABASE_URL is required');
    expect(() => loadConfig({ DATABASE_URL: 'postgres://local' })).toThrow('DASHBOARD_ADMIN_USER is required');
    expect(() => loadConfig({ DATABASE_URL: 'postgres://local', DASHBOARD_ADMIN_USER: 'admin' })).toThrow('DASHBOARD_ADMIN_PASSWORD is required');
  });

  test('loads Replit-compatible database URL and runtime defaults', () => {
    const config = loadConfig({
      DATABASE_URL: 'postgres://user:pass@host/db',
      DASHBOARD_ADMIN_USER: 'admin',
      DASHBOARD_ADMIN_PASSWORD: 'secret',
      BSKY_IDENTIFIER: 'example.bsky.social',
      BSKY_APP_PASSWORD: 'app-password',
      DRY_RUN: 'true'
    });

    expect(config.databaseUrl).toBe('postgres://user:pass@host/db');
    expect(config.port).toBe(3000);
    expect(config.bluesky.identifier).toBe('example.bsky.social');
    expect(config.dryRun).toBe(true);
  });
});
