import { describe, it, expect, vi, beforeEach, afterEach, MockedFunction } from 'vitest';
import { selectRandomImage, type ImageAsset } from '../images.js';

const createImage = (id: string): ImageAsset => ({
    id,
    path: `assets/images/originals/${id}.jpg`,
    defaultAlt: 'Test image',
    width: 1200,
    height: 675,
    bytes: 100000,
    mime: 'image/jpeg'
});

describe('selectRandomImage', () => {
    it('returns null for empty array', () => {
        const result = selectRandomImage([]);
        expect(result).toBeNull();
    });

    it('returns the only image when array has one item', () => {
        const image = createImage('only');
        const result = selectRandomImage([image]);
        expect(result).toBe(image);
    });

    it('returns an image from the array', () => {
        const images = [
            createImage('img-001'),
            createImage('img-002'),
            createImage('img-003')
        ];

        const result = selectRandomImage(images);
        expect(result).not.toBeNull();
        expect(images).toContain(result);
    });

    it('provides random distribution over multiple calls', () => {
        const images = [
            createImage('a'),
            createImage('b'),
            createImage('c')
        ];

        const counts = new Map<string, number>();
        for (let i = 0; i < 100; i++) {
            const result = selectRandomImage(images)!;
            counts.set(result.id, (counts.get(result.id) || 0) + 1);
        }

        // All images should be selected at least once in 100 tries
        expect(counts.size).toBe(3);
        for (const [_, count] of counts) {
            expect(count).toBeGreaterThan(0);
        }
    });
});

describe('ImageAsset interface', () => {
    it('has required properties', () => {
        const image = createImage('test');
        expect(image.id).toBe('test');
        expect(image.path).toBe('assets/images/originals/test.jpg');
        expect(image.defaultAlt).toBe('Test image');
        expect(image.width).toBe(1200);
        expect(image.height).toBe(675);
        expect(image.bytes).toBe(100000);
        expect(image.mime).toBe('image/jpeg');
    });
});
