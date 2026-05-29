import { describe, expect, test } from 'vitest';
import { PgLockRepository } from '../repositories/locks.js';

class FakeClient {
  calls: string[] = [];
  released = false;

  constructor(
    private readonly acquired: boolean = true,
    private readonly unlockFails: boolean = false
  ) {}

  async query<T>(text: string): Promise<{ rows: T[] }> {
    this.calls.push(text);
    if (text.includes('pg_try_advisory_lock')) {
      return { rows: [{ pg_try_advisory_lock: this.acquired }] as T[] };
    }
    if (text.includes('pg_advisory_unlock') && this.unlockFails) {
      throw new Error('unlock failed');
    }
    return { rows: [] };
  }

  release(): void {
    this.released = true;
  }
}

class FakePool {
  connectCalls = 0;

  constructor(readonly client: FakeClient) {}

  async connect(): Promise<FakeClient> {
    this.connectCalls += 1;
    return this.client;
  }
}

describe('PgLockRepository', () => {
  test('uses one checked-out client for acquire, callback, unlock, and release', async () => {
    const client = new FakeClient();
    const pool = new FakePool(client);
    const repo = new PgLockRepository(pool as any);

    await repo.withLock('poster', async () => {
      client.calls.push('callback');
      return 'ok';
    });

    expect(pool.connectCalls).toBe(1);
    expect(client.calls).toEqual([
      'select pg_try_advisory_lock($1)',
      'callback',
      'select pg_advisory_unlock($1)'
    ]);
    expect(client.released).toBe(true);
  });

  test('unlocks and releases the checked-out client when the callback throws', async () => {
    const client = new FakeClient();
    const pool = new FakePool(client);
    const repo = new PgLockRepository(pool as any);

    await expect(repo.withLock('poster', async () => {
      client.calls.push('callback');
      throw new Error('publish failed');
    })).rejects.toThrow('publish failed');

    expect(client.calls).toEqual([
      'select pg_try_advisory_lock($1)',
      'callback',
      'select pg_advisory_unlock($1)'
    ]);
    expect(client.released).toBe(true);
  });

  test('does not run the callback or unlock when the advisory lock is unavailable', async () => {
    const client = new FakeClient(false);
    const pool = new FakePool(client);
    const repo = new PgLockRepository(pool as any);
    let ranCallback = false;

    await expect(repo.withLock('poster', async () => {
      ranCallback = true;
    })).rejects.toThrow('scheduler lock is already held');

    expect(ranCallback).toBe(false);
    expect(client.calls).toEqual(['select pg_try_advisory_lock($1)']);
    expect(client.released).toBe(true);
  });

  test('releases the checked-out client when unlock fails', async () => {
    const client = new FakeClient(true, true);
    const pool = new FakePool(client);
    const repo = new PgLockRepository(pool as any);

    await expect(repo.withLock('poster', async () => undefined)).rejects.toThrow('unlock failed');

    expect(client.calls).toEqual([
      'select pg_try_advisory_lock($1)',
      'select pg_advisory_unlock($1)'
    ]);
    expect(client.released).toBe(true);
  });
});
