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

  test('loads optional Mastodon posting settings from Replit secrets', () => {
    const config = loadConfig({
      DATABASE_URL: 'postgres://user:pass@host/db',
      MASTODON_INSTANCE_URL: 'https://mastodon.social/',
      MASTODON_ACCESS_TOKEN: 'mastodon-token',
      MASTODON_VISIBILITY: 'unlisted'
    });

    expect(config.mastodon.instanceUrl).toBe('https://mastodon.social');
    expect(config.mastodon.accessToken).toBe('mastodon-token');
    expect(config.mastodon.visibility).toBe('unlisted');
  });

  test('defaults Mastodon instance and visibility when credentials are absent', () => {
    const config = loadConfig({ DATABASE_URL: 'postgres://user:pass@host/db' });

    expect(config.mastodon.instanceUrl).toBe('https://mastodon.social');
    expect(config.mastodon.accessToken).toBeNull();
    expect(config.mastodon.visibility).toBe('public');
  });
});
