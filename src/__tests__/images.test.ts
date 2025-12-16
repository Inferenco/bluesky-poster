import { describe, it, expect, vi, beforeEach } from 'vitest';
import { selectImages, type ImageAsset, type Manifest } from '../images.js';

const createImage = (overrides: Partial<ImageAsset> = {}): ImageAsset => ({
    id: 'img-001',
    path: 'assets/images/processed/img-001.jpg',
    tags: ['product', 'demo'],
    defaultAlt: 'A demo image',
    width: 1200,
    height: 675,
    bytes: 100000,
    mime: 'image/jpeg',
    ...overrides
});

describe('selectImages', () => {
    describe('with requested IDs', () => {
        it('returns images matching requested IDs', () => {
            const manifest: Manifest = {
                images: [
                    createImage({ id: 'img-001' }),
                    createImage({ id: 'img-002' }),
                    createImage({ id: 'img-003' })
                ]
            };

            const result = selectImages(manifest, {
                requestedIds: ['img-002', 'img-003'],
                tags: [],
                defaultImagesPerPost: 1,
                maxImagesPerPost: 4,
                recentImageIds: []
            });

            expect(result).toHaveLength(2);
            expect(result.map(i => i.id)).toEqual(['img-002', 'img-003']);
        });

        it('filters out missing requested IDs', () => {
            const manifest: Manifest = {
                images: [createImage({ id: 'img-001' })]
            };

            const result = selectImages(manifest, {
                requestedIds: ['img-001', 'missing'],
                tags: [],
                defaultImagesPerPost: 1,
                maxImagesPerPost: 4,
                recentImageIds: []
            });

            expect(result).toHaveLength(1);
            expect(result[0].id).toBe('img-001');
        });

        it('limits to 4 images max', () => {
            const manifest: Manifest = {
                images: Array.from({ length: 6 }, (_, i) => createImage({ id: `img-00${i}` }))
            };

            const result = selectImages(manifest, {
                requestedIds: ['img-000', 'img-001', 'img-002', 'img-003', 'img-004', 'img-005'],
                tags: [],
                defaultImagesPerPost: 1,
                maxImagesPerPost: 4,
                recentImageIds: []
            });

            expect(result).toHaveLength(4);
        });
    });

    describe('automatic selection', () => {
        it('filters out images over 1MB', () => {
            const manifest: Manifest = {
                images: [
                    createImage({ id: 'small', bytes: 500000 }),
                    createImage({ id: 'large', bytes: 1500000 })
                ]
            };

            const result = selectImages(manifest, {
                tags: [],
                defaultImagesPerPost: 2,
                maxImagesPerPost: 4,
                recentImageIds: []
            });

            expect(result).toHaveLength(1);
            expect(result[0].id).toBe('small');
        });

        it('prefers images with tag overlap', () => {
            const manifest: Manifest = {
                images: [
                    createImage({ id: 'no-match', tags: ['unrelated'] }),
                    createImage({ id: 'match', tags: ['product', 'wallet'] })
                ]
            };

            const result = selectImages(manifest, {
                tags: ['product', 'wallet'],
                defaultImagesPerPost: 1,
                maxImagesPerPost: 4,
                recentImageIds: []
            });

            expect(result[0].id).toBe('match');
        });

        it('deprioritizes recently used images', () => {
            const manifest: Manifest = {
                images: [
                    createImage({ id: 'recent', tags: ['product'] }),
                    createImage({ id: 'fresh', tags: ['product'] })
                ]
            };

            // Run multiple times to account for random tiebreaker
            const results = Array.from({ length: 10 }, () =>
                selectImages(manifest, {
                    tags: ['product'],
                    defaultImagesPerPost: 1,
                    maxImagesPerPost: 4,
                    recentImageIds: ['recent']
                })
            );

            // Fresh should be selected more often
            const freshCount = results.filter(r => r[0].id === 'fresh').length;
            expect(freshCount).toBeGreaterThan(5);
        });

        it('respects defaultImagesPerPost', () => {
            const manifest: Manifest = {
                images: Array.from({ length: 5 }, (_, i) => createImage({ id: `img-${i}` }))
            };

            const result = selectImages(manifest, {
                tags: [],
                defaultImagesPerPost: 2,
                maxImagesPerPost: 4,
                recentImageIds: []
            });

            expect(result).toHaveLength(2);
        });
    });
});
