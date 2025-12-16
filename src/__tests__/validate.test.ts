import { describe, it, expect } from 'vitest';
import { countGraphemes, ensureTextLength, normalizeText, hashText, validateAltOverrides, MAX_GRAPHEMES } from '../validate.js';

describe('countGraphemes', () => {
    it('counts ASCII characters correctly', () => {
        expect(countGraphemes('hello')).toBe(5);
        expect(countGraphemes('')).toBe(0);
        expect(countGraphemes('a b c')).toBe(5);
    });

    it('counts emoji as single graphemes', () => {
        expect(countGraphemes('👍')).toBe(1);
        expect(countGraphemes('👨‍👩‍👧‍👦')).toBe(1); // Family emoji (ZWJ sequence)
        expect(countGraphemes('🏳️‍🌈')).toBe(1); // Rainbow flag
        expect(countGraphemes('Hello 👋')).toBe(7);
    });

    it('counts accented characters correctly', () => {
        expect(countGraphemes('café')).toBe(4);
        expect(countGraphemes('naïve')).toBe(5);
    });

    it('handles mixed content', () => {
        expect(countGraphemes('こんにちは')).toBe(5); // Japanese
        expect(countGraphemes('🎉 Party time! 🎊')).toBe(15);
    });
});

describe('ensureTextLength', () => {
    it('returns ok for text within limit', () => {
        const result = ensureTextLength('Short text');
        expect(result.ok).toBe(true);
        expect(result.count).toBe(10);
    });

    it('returns not ok for text over limit', () => {
        const longText = 'x'.repeat(301);
        const result = ensureTextLength(longText);
        expect(result.ok).toBe(false);
        expect(result.count).toBe(301);
    });

    it('handles exactly MAX_GRAPHEMES', () => {
        const exactText = 'x'.repeat(MAX_GRAPHEMES);
        const result = ensureTextLength(exactText);
        expect(result.ok).toBe(true);
        expect(result.count).toBe(MAX_GRAPHEMES);
    });
});

describe('normalizeText', () => {
    it('lowercases text', () => {
        expect(normalizeText('HELLO World')).toBe('hello world');
    });

    it('collapses whitespace', () => {
        expect(normalizeText('hello   world')).toBe('hello world');
        expect(normalizeText('  spaced  ')).toBe('spaced');
    });

    it('strips tracking parameters from URLs', () => {
        const url = 'https://example.com/page?utm_source=twitter&utm_medium=social&id=123';
        const normalized = normalizeText(url);
        expect(normalized).toContain('id=123');
        expect(normalized).not.toContain('utm_source');
        expect(normalized).not.toContain('utm_medium');
    });

    it('preserves non-tracking query params', () => {
        const url = 'https://example.com/page?foo=bar&baz=qux';
        const normalized = normalizeText(url);
        expect(normalized).toContain('foo=bar');
        expect(normalized).toContain('baz=qux');
    });
});

describe('hashText', () => {
    it('returns consistent hash for same text', () => {
        const hash1 = hashText('hello world');
        const hash2 = hashText('hello world');
        expect(hash1).toBe(hash2);
    });

    it('returns sha256 prefixed hash', () => {
        const hash = hashText('test');
        expect(hash.startsWith('sha256:')).toBe(true);
        expect(hash.length).toBe(7 + 64); // prefix + 64 hex chars
    });

    it('normalizes before hashing', () => {
        const hash1 = hashText('Hello World');
        const hash2 = hashText('hello   world');
        expect(hash1).toBe(hash2);
    });
});

describe('validateAltOverrides', () => {
    it('returns ok when no overrides provided', () => {
        expect(validateAltOverrides(2, undefined)).toEqual({ ok: true });
        expect(validateAltOverrides(2, null)).toEqual({ ok: true });
    });

    it('returns ok when overrides match count', () => {
        const result = validateAltOverrides(2, ['alt1', 'alt2']);
        expect(result.ok).toBe(true);
    });

    it('fails when count mismatch', () => {
        const result = validateAltOverrides(2, ['alt1']);
        expect(result.ok).toBe(false);
        expect(result.message).toContain('2 entries');
    });

    it('fails for non-array', () => {
        const result = validateAltOverrides(2, 'not an array' as any);
        expect(result.ok).toBe(false);
        expect(result.message).toContain('must be an array');
    });

    it('fails for empty string entries', () => {
        const result = validateAltOverrides(2, ['valid', '   ']);
        expect(result.ok).toBe(false);
        expect(result.message).toContain('non-empty');
    });
});
