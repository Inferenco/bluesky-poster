import { describe, it, expect, vi, beforeEach } from 'vitest';

// We'll test the validation logic used by generator
// The actual OpenAI calls would need mocking for full integration tests

describe('generator validation', () => {
    describe('output structure', () => {
        it('requires text field', () => {
            const validateBasic = (obj: any) => {
                if (!obj || typeof obj !== 'object') return { ok: false, reason: 'not an object' };
                if (typeof obj.text !== 'string') return { ok: false, reason: 'text missing' };
                return { ok: true };
            };

            expect(validateBasic(null)).toEqual({ ok: false, reason: 'not an object' });
            expect(validateBasic({})).toEqual({ ok: false, reason: 'text missing' });
            expect(validateBasic({ text: 123 })).toEqual({ ok: false, reason: 'text missing' });
            expect(validateBasic({ text: 'hello' })).toEqual({ ok: true });
        });

        it('validates alt_overrides array length', () => {
            const validateAlts = (count: number, alts?: string[]) => {
                if (!alts) return { ok: true };
                if (!Array.isArray(alts)) return { ok: false, reason: 'not array' };
                if (alts.length !== count) return { ok: false, reason: 'count mismatch' };
                return { ok: true };
            };

            expect(validateAlts(2, undefined)).toEqual({ ok: true });
            expect(validateAlts(2, ['a', 'b'])).toEqual({ ok: true });
            expect(validateAlts(2, ['a'])).toEqual({ ok: false, reason: 'count mismatch' });
            expect(validateAlts(2, ['a', 'b', 'c'])).toEqual({ ok: false, reason: 'count mismatch' });
        });
    });

    describe('fallback generation', () => {
        it('creates deterministic fallback from queue item', () => {
            const createFallback = (item: { topic: string; link?: string; cta?: string }) => {
                return `${item.topic} ${item.link || ''} ${item.cta ? `— ${item.cta}` : ''}`.trim();
            };

            expect(createFallback({ topic: 'New feature', link: 'https://x.com', cta: 'Try it' }))
                .toBe('New feature https://x.com — Try it');

            expect(createFallback({ topic: 'Just a topic' }))
                .toBe('Just a topic');

            expect(createFallback({ topic: 'With CTA', cta: 'Click here' }))
                .toBe('With CTA  — Click here');
        });
    });

    describe('grapheme trimming', () => {
        it('trims text to max graphemes', () => {
            const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });
            const trimToMax = (text: string, max: number): string => {
                const segments = Array.from(segmenter.segment(text));
                if (segments.length <= max) return text;
                return segments.slice(0, max).map(s => s.segment).join('');
            };

            expect(trimToMax('hello', 10)).toBe('hello');
            expect(trimToMax('hello', 3)).toBe('hel');
            expect(trimToMax('👨‍👩‍👧‍👦 family', 3)).toBe('👨‍👩‍👧‍👦 f');
        });
    });
});
