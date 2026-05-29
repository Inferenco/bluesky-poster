import { describe, expect, test } from 'vitest';
import { hashText } from '../../src/validate.js';
import type { MessageRecord } from '../../src/repositories/messages.js';
import { PosterService, type RunRecorder } from '../../src/services/poster.js';
import { SchedulerService, type SchedulerDeps, type SchedulerSettings } from '../../src/services/scheduler.js';

function message(id: string, body: string): MessageRecord {
  return {
    id,
    body,
    status: 'approved',
    weight: 100,
    cooldown_hours: 168,
    tags: [],
    self_labels: [],
    image_asset_id: null,
    image_path: null,
    image_alt: null,
    normalised_hash: hashText(body),
    last_posted_at: null,
    post_count: 0,
    created_at: new Date('2026-05-29T10:00:00.000Z'),
    updated_at: new Date('2026-05-29T10:00:00.000Z')
  };
}

describe('dry-run staging flow', () => {
  test('selects one approved message, records a dry run, and advances next_run_at', async () => {
    const messages = [
      message('msg-1', 'First approved message'),
      message('msg-2', 'Second approved message'),
      message('msg-3', 'Third approved message')
    ];
    const runs: Parameters<RunRecorder['record']>[0][] = [];
    const settings: SchedulerSettings = {
      enabled: true,
      minIntervalMinutes: 1,
      maxIntervalMinutes: 2,
      nextRunAt: new Date('2026-05-29T12:00:00.000Z')
    };
    let nextRunAt: Date | null = null;

    const poster = new PosterService({
      dryRun: true,
      publisher: {
        async publish() {
          throw new Error('Bluesky must not be called in dry-run mode');
        }
      },
      runs: {
        async record(input) {
          runs.push(input);
        }
      }
    });

    const deps: SchedulerDeps = {
      settings: {
        get: async () => settings,
        setNextRunAt: async (value) => {
          nextRunAt = value;
        },
        markSuccess: async () => undefined,
        markError: async () => undefined
      },
      locks: {
        withLock: async (_key, fn) => fn()
      },
      messages: {
        list: async () => messages,
        markPosted: async (id, when) => {
          const current = messages.find((candidate) => candidate.id === id);
          if (current) {
            current.last_posted_at = when;
            current.post_count += 1;
          }
        }
      },
      runs: {
        recentHashes: async () => []
      },
      poster,
      random: () => 0,
      now: () => new Date('2026-05-29T12:00:00.000Z')
    };

    const result = await new SchedulerService(deps).runOnce();

    expect(result).toEqual({ status: 'posted', messageId: 'msg-1' });
    expect(runs).toMatchObject([{ messageId: 'msg-1', status: 'dry_run' }]);
    expect(messages[0].post_count).toBe(1);
    expect(nextRunAt?.toISOString()).toBe('2026-05-29T12:01:00.000Z');
  });
});
