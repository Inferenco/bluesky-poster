import { describe, expect, test } from 'vitest';
import {
  getPostgresTestDatabaseUrl,
  assertSafePostgresTestDatabaseUrl
} from './databaseSafety.js';

describe('Postgres integration database safety', () => {
  test('does not opt into destructive tests from application DATABASE_URL', () => {
    expect(getPostgresTestDatabaseUrl({
      DATABASE_URL: 'postgres://app:secret@prod.example.com/neondb'
    })).toBeUndefined();
  });

  test('rejects a test database URL that points at the application database', () => {
    const databaseUrl = 'postgres://app:secret@localhost:5432/bluesky_poster_test';

    expect(() => getPostgresTestDatabaseUrl({
      DATABASE_URL: databaseUrl,
      POSTGRES_TEST_DATABASE_URL: databaseUrl
    })).toThrow('must not match DATABASE_URL');
  });

  test('rejects database names that are not clearly test-only', () => {
    expect(() => assertSafePostgresTestDatabaseUrl(
      'postgres://app:secret@ep-dry-truth-asc9yhr0.c-4.eu-central-1.aws.neon.tech/neondb'
    )).toThrow('must include a standalone "test" segment');
  });

  test('rejects database names that only contain test as part of another word', () => {
    expect(() => assertSafePostgresTestDatabaseUrl(
      'postgres://poster:poster@localhost:5432/contest_data'
    )).toThrow('must include a standalone "test" segment');
  });

  test('accepts an explicit test-only database URL', () => {
    expect(getPostgresTestDatabaseUrl({
      POSTGRES_TEST_DATABASE_URL: 'postgres://poster:poster@localhost:5432/bluesky_poster_test'
    })).toBe('postgres://poster:poster@localhost:5432/bluesky_poster_test');
  });
});
