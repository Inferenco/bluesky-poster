import { describe, expect, test } from 'vitest';
import { loadConfig } from '../config.js';

describe('loadConfig', () => {
  test('requires DATABASE_URL and applies wallet auth defaults', () => {
    expect(() => loadConfig({})).toThrow('DATABASE_URL is required');
    const config = loadConfig({ DATABASE_URL: 'postgres://local' });
    expect(config.auth.cedraFullnodeUrl).toBe('https://testnet.cedra.dev/v1');
    expect(config.auth.adminContractAddress).toBe(
      '0xbdf9c94e797716648980ed99a0c6e2b3d6452ce5c1d28dbad3517a9be682b724'
    );
    expect(config.auth.adminCacheTtlMs).toBe(60_000);
    expect(config.auth.adminViewTimeoutMs).toBe(5_000);
    expect(config.auth.secureCookies).toBe(true);
  });

  test('loads wallet auth overrides', () => {
    const config = loadConfig({
      DATABASE_URL: 'postgres://local',
      CEDRA_FULLNODE_URL: 'https://example.dev/v1',
      ADMIN_CONTRACT_ADDRESS: '0xabc',
      ADMIN_CACHE_TTL_MS: '5000',
      ADMIN_VIEW_TIMEOUT_MS: '2000',
      COOKIE_SECURE: 'false'
    });

    expect(config.auth.cedraFullnodeUrl).toBe('https://example.dev/v1');
    expect(config.auth.adminContractAddress).toBe('0xabc');
    expect(config.auth.adminCacheTtlMs).toBe(5000);
    expect(config.auth.adminViewTimeoutMs).toBe(2000);
    expect(config.auth.secureCookies).toBe(false);
  });

  test('loads database URL and runtime defaults', () => {
    const config = loadConfig({
      DATABASE_URL: 'postgres://user:pass@host/db',
      BSKY_IDENTIFIER: 'example.bsky.social',
      BSKY_APP_PASSWORD: 'app-password',
      DRY_RUN: 'true'
    });

    expect(config.databaseUrl).toBe('postgres://user:pass@host/db');
    expect(config.port).toBe(3000);
    expect(config.bluesky.identifier).toBe('example.bsky.social');
    expect(config.dryRun).toBe(true);
  });

  test('loads optional OpenAI generation settings', () => {
    const config = loadConfig({
      DATABASE_URL: 'postgres://user:pass@host/db',
      OPENAI_API_KEY: 'sk-test',
      OPENAI_POST_MODEL: 'gpt-5.4-mini'
    });

    expect(config.ai.openaiApiKey).toBe('sk-test');
    expect(config.ai.openaiPostModel).toBe('gpt-5.4-mini');
  });

  test('loads optional Mastodon posting settings', () => {
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
