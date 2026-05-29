import { nanoid } from 'nanoid';
import type { DashboardRun } from '../app.js';
import type { Queryable } from './messages.js';
import type { RunRecorder } from '../services/poster.js';

export class RunsRepository implements RunRecorder {
  constructor(
    private readonly db: Queryable,
    private readonly createId: () => string = nanoid
  ) {}

  async list(): Promise<DashboardRun[]> {
    const result = await this.db.query<DashboardRun>('select * from post_runs order by attempted_at desc limit 100');
    return result.rows;
  }

  async recentHashes(limit: number): Promise<string[]> {
    const result = await this.db.query<{ normalised_hash: string }>(
      `select m.normalised_hash
      from post_runs pr
      join messages m on m.id = pr.message_id
      where pr.status in ('success', 'dry_run')
      order by pr.attempted_at desc
      limit $1`,
      [limit]
    );
    return result.rows.map((row) => row.normalised_hash);
  }

  async record(input: Parameters<RunRecorder['record']>[0]): Promise<void> {
    await this.db.query(
      `insert into post_runs (
        id, message_id, status, bsky_uri, bsky_cid, http_status, error, retry_count
      ) values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        this.createId(),
        input.messageId,
        input.status,
        input.bskyUri ?? null,
        input.bskyCid ?? null,
        input.httpStatus ?? null,
        input.error ?? null,
        input.retryCount ?? 0
      ]
    );
  }
}
