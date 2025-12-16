import { describe, it, expect } from 'vitest';
import { selectNext, type QueueItem } from '../queue.js';

const createItem = (overrides: Partial<QueueItem> = {}): QueueItem => ({
    id: '001',
    topic: 'Test topic',
    link: 'https://example.com',
    tags: ['test'],
    cta: 'Check it out',
    active: true,
    ...overrides
});

describe('selectNext', () => {
    describe('fresh selection', () => {
        it('returns first active item not in posted list', () => {
            const queue: QueueItem[] = [
                createItem({ id: '001', active: true }),
                createItem({ id: '002', active: true }),
                createItem({ id: '003', active: true })
            ];

            const result = selectNext(queue, ['001']);
            expect(result?.item.id).toBe('002');
            expect(result?.isRecycled).toBe(false);
        });

        it('skips inactive items', () => {
            const queue: QueueItem[] = [
                createItem({ id: '001', active: false }),
                createItem({ id: '002', active: true })
            ];

            const result = selectNext(queue, []);
            expect(result?.item.id).toBe('002');
            expect(result?.isRecycled).toBe(false);
        });

        it('returns null when all items are inactive', () => {
            const queue: QueueItem[] = [
                createItem({ id: '001', active: false }),
                createItem({ id: '002', active: false })
            ];

            const result = selectNext(queue, []);
            expect(result).toBeNull();
        });

        it('returns null for empty queue', () => {
            const result = selectNext([], []);
            expect(result).toBeNull();
        });

        it('handles imageIds field', () => {
            const queue: QueueItem[] = [
                createItem({ id: '001', imageIds: ['img-001', 'img-002'] })
            ];

            const result = selectNext(queue, []);
            expect(result?.item.imageIds).toEqual(['img-001', 'img-002']);
        });
    });

    describe('recycling', () => {
        it('recycles oldest posted item when queue is exhausted', () => {
            const queue: QueueItem[] = [
                createItem({ id: '001', active: true }),
                createItem({ id: '002', active: true }),
                createItem({ id: '003', active: true })
            ];

            // All items posted, 002 was posted first
            const result = selectNext(queue, ['002', '001', '003']);
            expect(result?.item.id).toBe('002');
            expect(result?.isRecycled).toBe(true);
        });

        it('respects posting order for recycling', () => {
            const queue: QueueItem[] = [
                createItem({ id: '001', active: true }),
                createItem({ id: '002', active: true })
            ];

            // 001 posted first, then 002
            const result = selectNext(queue, ['001', '002']);
            expect(result?.item.id).toBe('001');
            expect(result?.isRecycled).toBe(true);
        });

        it('only recycles active items', () => {
            const queue: QueueItem[] = [
                createItem({ id: '001', active: false }),  // inactive
                createItem({ id: '002', active: true })
            ];

            const result = selectNext(queue, ['001', '002']);
            expect(result?.item.id).toBe('002');
            expect(result?.isRecycled).toBe(true);
        });
    });
});

