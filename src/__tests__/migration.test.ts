import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

describe('database migration', () => {
  test('creates durable dashboard, history, and scheduler tables', async () => {
    const migration = await fs.readFile(path.join(process.cwd(), 'db', '001_init.sql'), 'utf8');

    expect(migration).toContain('create table if not exists messages');
    expect(migration).toContain('create table if not exists assets');
    expect(migration).toContain('storage_kind text not null default');
    expect(migration).toContain('content bytea');
    expect(migration).toContain('create table if not exists post_runs');
    expect(migration).toContain('platforms jsonb not null');
    expect(migration).toContain('platform text not null');
    expect(migration).toContain('platform_uri text');
    expect(migration).toContain('platform_url text');
    expect(migration).toContain('create table if not exists scheduler_state');
    expect(migration).toContain('image_asset_id text references assets(id)');
    expect(migration).toContain('next_run_at timestamptz');
  });
});
