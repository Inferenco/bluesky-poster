import type { Queryable } from './messages.js';

export class PgLockRepository {
  constructor(private readonly db: Queryable) {}

  async withLock<T>(_key: string, fn: () => Promise<T>): Promise<T> {
    const lockId = 937461;
    const acquired = await this.db.query<{ pg_try_advisory_lock: boolean }>('select pg_try_advisory_lock($1)', [lockId]);
    if (!acquired.rows[0]?.pg_try_advisory_lock) {
      throw new Error('scheduler lock is already held');
    }

    try {
      return await fn();
    } finally {
      await this.db.query('select pg_advisory_unlock($1)', [lockId]);
    }
  }
}
