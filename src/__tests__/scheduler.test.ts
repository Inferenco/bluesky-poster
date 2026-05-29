import { describe, expect, test } from 'vitest';
import { SchedulerService, type SchedulerDeps, type SchedulerSettings } from '../services/scheduler.js';
import type { MessageRecord } from '../repositories/messages.js';

const settings: SchedulerSettings = {
  enabled: true,
  minIntervalMinutes: 60,
  maxIntervalMinutes: 180,
  nextRunAt: new Date('2026-05-29T12:00:00.000Z')
};

const message: MessageRecord = {
  id: 'msg-1',
  body: 'Hello Bluesky',
  status: 'approved',
  weight: 100,
  cooldown_hours: 168,
  tags: [],
  self_labels: [],
  image_asset_id: null,
  image_path: null,
  image_alt: null,
  normalised_hash: 'sha256:one',
  last_posted_at: null,
  post_count: 0,
  created_at: new Date('2026-05-29T10:00:00.000Z'),
  updated_at: new Date('2026-05-29T10:00:00.000Z')
};

function deps(overrides: Partial<SchedulerDeps> = {}): SchedulerDeps {
  return {
    settings: {
      get: async () => settings,
      setNextRunAt: async () => undefined,
      markSuccess: async () => undefined,
      markError: async () => undefined
    },
    locks: {
      withLock: async (_key, fn) => fn()
    },
    messages: {
      list: async () => [message],
      markPosted: async () => undefined
    },
    runs: {
      recentHashes: async () => []
    },
    poster: {
      publish: async () => ({ status: 'success', uri: 'at://post', cid: 'cid' })
    },
    random: () => 0,
    now: () => new Date('2026-05-29T12:00:00.000Z'),
    ...overrides
  };
}

describe('SchedulerService', () => {
  test('does not post before next_run_at', async () => {
    let posted = false;
    const scheduler = new SchedulerService(deps({
      now: () => new Date('2026-05-29T11:59:59.000Z'),
      poster: {
        publish: async () => {
          posted = true;
          return { status: 'success', uri: null, cid: null };
        }
      }
    }));

    const result = await scheduler.runOnce();

    expect(result).toEqual({ status: 'skipped', reason: 'not_due' });
    expect(posted).toBe(false);
  });

  test('defers next_run_at by 15 minutes when no message is eligible', async () => {
    const captured: { nextRunAt: Date | null } = { nextRunAt: null };
    const scheduler = new SchedulerService(deps({
      messages: {
        list: async () => [{ ...message, status: 'draft' }],
        markPosted: async () => undefined
      },
      settings: {
        ...deps().settings,
        setNextRunAt: async (value) => {
          captured.nextRunAt = value;
        }
      }
    }));

    const result = await scheduler.runOnce();

    expect(result).toEqual({ status: 'skipped', reason: 'no_eligible_messages' });
    expect(captured.nextRunAt?.toISOString()).toBe('2026-05-29T12:15:00.000Z');
  });

  test('posts one eligible message and persists the next randomised run', async () => {
    let markedPosted = '';
    const captured: { nextRunAt: Date | null } = { nextRunAt: null };
    const scheduler = new SchedulerService(deps({
      random: () => 0.5,
      messages: {
        list: async () => [message],
        markPosted: async (id) => {
          markedPosted = id;
        }
      },
      settings: {
        ...deps().settings,
        setNextRunAt: async (value) => {
          captured.nextRunAt = value;
        }
      }
    }));

    const result = await scheduler.runOnce();

    expect(result).toEqual({ status: 'posted', messageId: 'msg-1' });
    expect(markedPosted).toBe('msg-1');
    expect(captured.nextRunAt?.toISOString()).toBe('2026-05-29T14:00:00.000Z');
  });
});
