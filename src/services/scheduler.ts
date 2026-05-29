import type { MessageRecord } from '../repositories/messages.js';
import { pickWeightedMessage, selectEligibleMessages } from './selector.js';
import type { PosterResult } from './poster.js';

export interface SchedulerSettings {
  enabled: boolean;
  minIntervalMinutes: number;
  maxIntervalMinutes: number;
  nextRunAt: Date | null;
}

export interface SchedulerDeps {
  settings: {
    get(): Promise<SchedulerSettings>;
    setNextRunAt(value: Date): Promise<void>;
    markSuccess(value: Date): Promise<void>;
    markError(value: Date): Promise<void>;
  };
  locks: {
    withLock<T>(key: string, fn: () => Promise<T>): Promise<T>;
  };
  messages: {
    list(): Promise<MessageRecord[]>;
    markPosted(id: string, when: Date): Promise<void>;
  };
  runs: {
    recentHashes(limit: number): Promise<string[]>;
  };
  poster: {
    publish(message: MessageRecord): Promise<PosterResult>;
  };
  random: () => number;
  now: () => Date;
}

export type SchedulerRunResult =
  | { status: 'skipped'; reason: 'disabled' | 'not_due' | 'no_eligible_messages' | 'lock_held' }
  | { status: 'posted'; messageId: string };

const RECENT_HASH_WINDOW = 25;

export class SchedulerService {
  constructor(private readonly deps: SchedulerDeps) {}

  async runOnce(): Promise<SchedulerRunResult> {
    try {
      return await this.deps.locks.withLock('poster', async () => {
        const now = this.deps.now();
        const settings = await this.deps.settings.get();

        if (!settings.enabled) {
          return { status: 'skipped', reason: 'disabled' };
        }
        if (settings.nextRunAt && now < settings.nextRunAt) {
          return { status: 'skipped', reason: 'not_due' };
        }

        const [messages, recentHashes] = await Promise.all([
          this.deps.messages.list(),
          this.deps.runs.recentHashes(RECENT_HASH_WINDOW)
        ]);
        const eligible = selectEligibleMessages(messages, { now, recentHashes });
        const candidate = pickWeightedMessage(eligible, this.deps.random);

        if (!candidate) {
          await this.deps.settings.setNextRunAt(addMinutes(now, 15));
          return { status: 'skipped', reason: 'no_eligible_messages' };
        }

        try {
          await this.deps.poster.publish(candidate);
          await this.deps.messages.markPosted(candidate.id, now);
          await this.deps.settings.markSuccess(now);
          await this.deps.settings.setNextRunAt(nextRandomRun(now, settings, this.deps.random));
          return { status: 'posted', messageId: candidate.id };
        } catch (err) {
          await this.deps.settings.markError(now);
          await this.deps.settings.setNextRunAt(addMinutes(now, 15));
          throw err;
        }
      });
    } catch (err) {
      if (err instanceof Error && err.message === 'scheduler lock is already held') {
        return { status: 'skipped', reason: 'lock_held' };
      }
      throw err;
    }
  }
}

function nextRandomRun(now: Date, settings: SchedulerSettings, random: () => number): Date {
  const min = settings.minIntervalMinutes;
  const max = Math.max(settings.maxIntervalMinutes, min);
  const minutes = min + Math.round((max - min) * random());
  return addMinutes(now, minutes);
}

function addMinutes(value: Date, minutes: number): Date {
  return new Date(value.getTime() + minutes * 60 * 1000);
}
