import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { generatePost } from '../generator.js';
import type { ImageAsset } from '../images.js';

const baseImage: ImageAsset = {
    id: 'img-001',
    path: 'assets/images/originals/test.jpg',
    defaultAlt: 'A test image',
    width: 1200,
    height: 675,
    bytes: 1234,
    mime: 'image/jpeg'
};

const baseInput = {
    image: baseImage
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

    it('returns valid output from Nova response with hashtags', async () => {
        process.env.NOVA_API_KEY = 'test-key';
        mockFetchOnce({
            text: JSON.stringify({
                text: 'Hello world',
                hashtags: ['AI', 'blockchain'],
                alt_text: 'A descriptive alt'
            }),
            model: 'gpt-5-mini',
            total_tokens: 123,
            file_search: 1
        });

        const result = await generatePost(baseInput);
        expect(result.source).toBe('nova');
        expect(result.text).toBe('Hello world');
        expect(result.hashtags).toEqual(['AI', 'blockchain']);
        expect(result.alt_text).toBe('A descriptive alt');
        expect(result.model).toBe('gpt-5-mini');
        expect(result.meta?.total_tokens).toBe(123);
        expect(result.meta?.file_search).toBe(1);
        expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    });

    it('falls back on invalid JSON', async () => {
        process.env.NOVA_API_KEY = 'test-key';
        mockFetchOnce({
            text: 'not-json-at-all',
            model: 'gpt-5-mini'
        });

        const result = await generatePost(baseInput);
        expect(result.source).toBe('fallback');
        expect(result.hashtags).toBeDefined();
        expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    });

    it('extracts JSON from wrapped response', async () => {
        process.env.NOVA_API_KEY = 'test-key';
        mockFetchOnce({
            text: 'Here is the JSON: {"text": "Extracted", "hashtags": ["test"]}',
            model: 'gpt-5-mini'
        });

        const result = await generatePost(baseInput);
        expect(result.source).toBe('nova');
        expect(result.text).toBe('Extracted');
        expect(result.hashtags).toEqual(['test']);
    });

    it('falls back when API returns error', async () => {
        process.env.NOVA_API_KEY = 'test-key';
        mockFetchOnce({ error: 'Server error' }, false, 500);

        const result = await generatePost(baseInput);
        expect(result.source).toBe('fallback');
    });
});
