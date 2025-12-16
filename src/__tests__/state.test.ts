import { describe, it, expect } from 'vitest';
import { ensureToday, recordSuccess, type BotState, type ScheduleConfig } from '../state.js';

const createState = (overrides: Partial<BotState> = {}): BotState => ({
    posted_ids: [],
    recent_text_hashes: [],
    recent_image_ids: [],
    posted_today_utc: null,
    posted_today_count: 0,
    last_posted_at: null,
    ...overrides
});

const createSchedule = (overrides: Partial<ScheduleConfig> = {}): ScheduleConfig => ({
    posts_per_day: 3,
    default_images_per_post: 1,
    max_images_per_post: 4,
    quiet_hours_utc: ['23:00', '07:00'],
    random_jitter_minutes: 12,
    max_recent_image_ids: 40,
    max_recent_text_hashes: 80,
    ...overrides
});

describe('ensureToday', () => {
    it('resets count when date changes', () => {
        const state = createState({
            posted_today_utc: '2025-12-15',
            posted_today_count: 3
        });
        const now = new Date('2025-12-16T10:00:00Z');

        const result = ensureToday(state, now);

        expect(result.posted_today_utc).toBe('2025-12-16');
        expect(result.posted_today_count).toBe(0);
    });

    it('preserves count when same date', () => {
        const state = createState({
            posted_today_utc: '2025-12-16',
            posted_today_count: 2
        });
        const now = new Date('2025-12-16T15:00:00Z');

        const result = ensureToday(state, now);

        expect(result.posted_today_utc).toBe('2025-12-16');
        expect(result.posted_today_count).toBe(2);
    });

    it('initializes from null date', () => {
        const state = createState({
            posted_today_utc: null,
            posted_today_count: 0
        });
        const now = new Date('2025-12-16T10:00:00Z');

        const result = ensureToday(state, now);

        expect(result.posted_today_utc).toBe('2025-12-16');
        expect(result.posted_today_count).toBe(0);
    });
});

describe('recordSuccess', () => {
    it('adds post ID to posted_ids', () => {
        const state = createState({ posted_ids: ['001'] });
        const schedule = createSchedule();

        const result = recordSuccess(state, schedule, {
            id: '002',
            textHash: 'sha256:abc',
            imageIds: ['img-001'],
            when: new Date('2025-12-16T10:00:00Z')
        });

        expect(result.posted_ids).toEqual(['001', '002']);
    });

    it('increments posted_today_count', () => {
        const state = createState({ posted_today_count: 1 });
        const schedule = createSchedule();

        const result = recordSuccess(state, schedule, {
            id: '002',
            textHash: 'sha256:abc',
            imageIds: [],
            when: new Date()
        });

        expect(result.posted_today_count).toBe(2);
    });

    it('updates last_posted_at', () => {
        const state = createState();
        const schedule = createSchedule();
        const when = new Date('2025-12-16T12:34:56Z');

        const result = recordSuccess(state, schedule, {
            id: '001',
            textHash: 'sha256:abc',
            imageIds: [],
            when
        });

        expect(result.last_posted_at).toBe('2025-12-16T12:34:56.000Z');
    });

    it('trims recent_text_hashes to max', () => {
        const state = createState({
            recent_text_hashes: Array.from({ length: 80 }, (_, i) => `hash-${i}`)
        });
        const schedule = createSchedule({ max_recent_text_hashes: 80 });

        const result = recordSuccess(state, schedule, {
            id: '001',
            textHash: 'new-hash',
            imageIds: [],
            when: new Date()
        });

        expect(result.recent_text_hashes).toHaveLength(80);
        expect(result.recent_text_hashes).toContain('new-hash');
        expect(result.recent_text_hashes).not.toContain('hash-0');
    });

    it('trims recent_image_ids to max', () => {
        const state = createState({
            recent_image_ids: Array.from({ length: 40 }, (_, i) => `img-${i}`)
        });
        const schedule = createSchedule({ max_recent_image_ids: 40 });

        const result = recordSuccess(state, schedule, {
            id: '001',
            textHash: 'hash',
            imageIds: ['new-img-1', 'new-img-2'],
            when: new Date()
        });

        expect(result.recent_image_ids).toHaveLength(40);
        expect(result.recent_image_ids).toContain('new-img-1');
        expect(result.recent_image_ids).toContain('new-img-2');
    });
});
