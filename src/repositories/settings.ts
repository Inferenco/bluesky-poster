import type { Queryable } from './messages.js';
import type { DashboardSettings } from '../app.js';
import type { SchedulerSettings } from '../services/scheduler.js';

interface SchedulerStateRow {
  enabled: boolean;
  timezone: string;
  min_interval_minutes: number;
  max_interval_minutes: number;
  quiet_hours_json: unknown[];
  next_run_at: Date | string | null;
  last_success_at: Date | string | null;
  last_error_at: Date | string | null;
}

export class SettingsRepository {
  constructor(private readonly db: Queryable) {}

  async getDashboardSettings(): Promise<DashboardSettings> {
    const row = await this.getRow();
    return {
      enabled: row.enabled,
      timezone: row.timezone,
      minIntervalMinutes: row.min_interval_minutes,
      maxIntervalMinutes: row.max_interval_minutes,
      quietHours: row.quiet_hours_json,
      nextRunAt: toDate(row.next_run_at)
    };
  }

  async updateDashboardSettings(input: { enabled: boolean; minIntervalMinutes: number; maxIntervalMinutes: number }): Promise<DashboardSettings> {
    const result = await this.db.query<SchedulerStateRow>(
      `update scheduler_state
      set enabled = $2, min_interval_minutes = $3, max_interval_minutes = $4
      where singleton_key = $1
      returning *`,
      ['poster', input.enabled, input.minIntervalMinutes, input.maxIntervalMinutes]
    );
    return {
      enabled: result.rows[0].enabled,
      timezone: result.rows[0].timezone,
      minIntervalMinutes: result.rows[0].min_interval_minutes,
      maxIntervalMinutes: result.rows[0].max_interval_minutes,
      quietHours: result.rows[0].quiet_hours_json,
      nextRunAt: toDate(result.rows[0].next_run_at)
    };
  }

  async get(): Promise<SchedulerSettings> {
    const row = await this.getRow();
    return {
      enabled: row.enabled,
      minIntervalMinutes: row.min_interval_minutes,
      maxIntervalMinutes: row.max_interval_minutes,
      nextRunAt: toDate(row.next_run_at)
    };
  }

  async setNextRunAt(value: Date): Promise<void> {
    await this.db.query('update scheduler_state set next_run_at = $2 where singleton_key = $1', ['poster', value]);
  }

  async markSuccess(value: Date): Promise<void> {
    await this.db.query('update scheduler_state set last_success_at = $2 where singleton_key = $1', ['poster', value]);
  }

  async markError(value: Date): Promise<void> {
    await this.db.query('update scheduler_state set last_error_at = $2 where singleton_key = $1', ['poster', value]);
  }

  private async getRow(): Promise<SchedulerStateRow> {
    const result = await this.db.query<SchedulerStateRow>('select * from scheduler_state where singleton_key = $1', ['poster']);
    if (!result.rows[0]) {
      throw new Error('scheduler_state row is missing; run npm run db:migrate');
    }
    return result.rows[0];
  }
}

function toDate(value: Date | string | null): Date | null {
  if (!value) return null;
  return value instanceof Date ? value : new Date(value);
}
