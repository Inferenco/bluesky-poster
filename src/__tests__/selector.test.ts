import { describe, expect, test } from 'vitest';
import { pickWeightedMessage, selectEligibleMessages, type SelectableMessage } from '../services/selector.js';

const baseMessage: SelectableMessage = {
  id: 'msg-1',
  body: 'A saved post',
  status: 'approved',
  weight: 100,
  cooldown_hours: 24,
  normalised_hash: 'sha256:one',
  last_posted_at: null
};

describe('selectEligibleMessages', () => {
  test('keeps only approved messages outside cooldown and recent duplicate window', () => {
    const now = new Date('2026-05-29T12:00:00.000Z');
    const messages: SelectableMessage[] = [
      baseMessage,
      { ...baseMessage, id: 'draft', status: 'draft', normalised_hash: 'sha256:draft' },
      { ...baseMessage, id: 'cooldown', normalised_hash: 'sha256:cooldown', last_posted_at: '2026-05-29T00:30:00.000Z' },
      { ...baseMessage, id: 'duplicate', normalised_hash: 'sha256:duplicate', last_posted_at: null },
      { ...baseMessage, id: 'old', normalised_hash: 'sha256:old', last_posted_at: '2026-05-25T12:00:00.000Z' }
    ];

    const eligible = selectEligibleMessages(messages, {
      now,
      recentHashes: ['sha256:duplicate']
    });

    expect(eligible.map((message) => message.id)).toEqual(['msg-1', 'old']);
  });
});

describe('pickWeightedMessage', () => {
  test('selects using message weight and supplied random source', () => {
    const messages: SelectableMessage[] = [
      { ...baseMessage, id: 'low', weight: 1 },
      { ...baseMessage, id: 'high', weight: 3 }
    ];

    expect(pickWeightedMessage(messages, () => 0.49)?.id).toBe('high');
  });
});
