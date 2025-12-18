import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { generatePost } from '../generator.js';
import type { ImageAsset } from '../images.js';
import type { QueueItem } from '../queue.js';

const baseItem: QueueItem = {
    id: '001',
    topic: 'Test topic',
    link: 'https://example.com',
    tags: ['test'],
    cta: 'Learn more',
    active: true,
    imageIds: undefined
};

const baseImage: ImageAsset = {
    id: 'img-001',
    path: 'assets/images/processed/test.jpg',
    tags: ['test'],
    defaultAlt: 'A test image',
    width: 1200,
    height: 675,
    bytes: 1234,
    mime: 'image/jpeg'
};

const baseInput = {
    voice: 'Direct, concise, no hashtags.',
    item: baseItem,
    images: [baseImage]
};

const originalEnv = { ...process.env };

beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    for (const key of Object.keys(process.env)) {
        if (!(key in originalEnv)) {
            delete process.env[key];
        }
    }
    for (const [key, value] of Object.entries(originalEnv)) {
        process.env[key] = value;
    }
});

function mockFetchOnce(payload: any, ok = true, status = 200) {
    const fetchMock = vi.mocked(globalThis.fetch);
    fetchMock.mockResolvedValueOnce({
        ok,
        status,
        json: async () => payload,
        text: async () => JSON.stringify(payload)
    } as any);
    return fetchMock;
}

describe('generatePost (Nova)', () => {
    it('falls back when NOVA_API_KEY is missing', async () => {
        delete process.env.NOVA_API_KEY;
        const result = await generatePost(baseInput);
        expect(result.source).toBe('fallback');
        expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it('returns valid output from Nova response', async () => {
        process.env.NOVA_API_KEY = 'test-key';
        mockFetchOnce({
            text: JSON.stringify({ text: 'Hello world', alt_overrides: ['Alt text'] }),
            model: 'gpt-5-mini',
            total_tokens: 123,
            file_search: 1
        });

        const result = await generatePost(baseInput);
        expect(result.source).toBe('nova');
        expect(result.text).toBe('Hello world');
        expect(result.alt_overrides).toEqual(['Alt text']);
        expect(result.model).toBe('gpt-5-mini');
        expect(result.meta?.total_tokens).toBe(123);
        expect(result.meta?.file_search).toBe(1);
        expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    });

    it('repairs invalid JSON output', async () => {
        process.env.NOVA_API_KEY = 'test-key';
        mockFetchOnce({
            text: 'not-json',
            model: 'gpt-5-mini'
        });
        mockFetchOnce({
            text: JSON.stringify({ text: 'Repaired copy', alt_overrides: ['Alt text'] }),
            model: 'gpt-5-mini'
        });

        const result = await generatePost(baseInput);
        expect(result.text).toBe('Repaired copy');
        expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    });
});
