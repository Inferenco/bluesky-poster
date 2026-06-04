import { describe, expect, test } from 'vitest';
import { loadConfig } from '../config.js';

describe('loadConfig', () => {
  test('requires DATABASE_URL and allows Replit auth without dashboard credentials', () => {
    expect(() => loadConfig({})).toThrow('DATABASE_URL is required');
    const config = loadConfig({ DATABASE_URL: 'postgres://local' });
    expect(config.dashboard.user).toBeNull();
    expect(config.dashboard.password).toBeNull();
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

  test('loads optional OpenAI generation settings from Replit secrets', () => {
    const config = loadConfig({
      DATABASE_URL: 'postgres://user:pass@host/db',
      OPENAI_API_KEY: 'sk-test',
      OPENAI_POST_MODEL: 'gpt-5.4-mini'
    });

    expect(config.ai.openaiApiKey).toBe('sk-test');
    expect(config.ai.openaiPostModel).toBe('gpt-5.4-mini');
  });
});
