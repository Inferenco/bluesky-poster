interface LockClient {
  query<T>(text: string, values?: unknown[]): Promise<{ rows: T[] }>;
  release(): void;
}

interface LockPool {
  connect(): Promise<LockClient>;
}

export class PgLockRepository {
  constructor(private readonly pool: LockPool) {}

  async withLock<T>(_key: string, fn: () => Promise<T>): Promise<T> {
    const lockId = 937461;
    const client = await this.pool.connect();
    let lockAcquired = false;

    try {
      const acquired = await client.query<{ pg_try_advisory_lock: boolean }>('select pg_try_advisory_lock($1)', [lockId]);
      if (!acquired.rows[0]?.pg_try_advisory_lock) {
        throw new Error('scheduler lock is already held');
      }
      lockAcquired = true;

      return await fn();
    } finally {
      try {
        if (lockAcquired) {
          await client.query('select pg_advisory_unlock($1)', [lockId]);
        }
      } finally {
        client.release();
      }
    }
  }
}
