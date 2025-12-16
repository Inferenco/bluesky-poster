import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { checkSafety, loadBlockedPhrases, resetBlockedPhrasesCache } from '../safety.js';

// Mock fs module
vi.mock('node:fs/promises', () => ({
    default: {
        readFile: vi.fn()
    }
}));

describe('safety filter', () => {
    beforeEach(() => {
        resetBlockedPhrasesCache();
        vi.clearAllMocks();
    });

    describe('loadBlockedPhrases', () => {
        it('loads phrases from file', async () => {
            vi.mocked(fs.readFile).mockResolvedValue('bad-word\nanother-bad\n# comment\n\n');

            const phrases = await loadBlockedPhrases('/root');

            expect(phrases).toEqual(['bad-word', 'another-bad']);
            expect(fs.readFile).toHaveBeenCalledWith(
                expect.stringContaining('blocked_phrases.txt'),
                'utf8'
            );
        });

        it('returns empty array if file not found', async () => {
            vi.mocked(fs.readFile).mockRejectedValue(new Error('ENOENT'));

            const phrases = await loadBlockedPhrases('/root');

            expect(phrases).toEqual([]);
        });

        it('caches phrases after first load', async () => {
            vi.mocked(fs.readFile).mockResolvedValue('cached-phrase');

            await loadBlockedPhrases('/root');
            await loadBlockedPhrases('/root');

            expect(fs.readFile).toHaveBeenCalledTimes(1);
        });
    });

    describe('checkSafety', () => {
        it('returns safe for clean text', async () => {
            vi.mocked(fs.readFile).mockResolvedValue('blocked-word');

            const result = await checkSafety('/root', 'This is a clean message');

            expect(result.safe).toBe(true);
            expect(result.blockedPhrase).toBeUndefined();
        });

        it('returns unsafe for text with blocked phrase', async () => {
            vi.mocked(fs.readFile).mockResolvedValue('blocked-word\nanother-bad');
            resetBlockedPhrasesCache();

            const result = await checkSafety('/root', 'This contains blocked-word in it');

            expect(result.safe).toBe(false);
            expect(result.blockedPhrase).toBe('blocked-word');
        });

        it('is case insensitive', async () => {
            vi.mocked(fs.readFile).mockResolvedValue('BadWord');
            resetBlockedPhrasesCache();

            const result = await checkSafety('/root', 'This has BADWORD here');

            expect(result.safe).toBe(false);
        });

        it('returns safe when no blocked phrases configured', async () => {
            vi.mocked(fs.readFile).mockRejectedValue(new Error('ENOENT'));
            resetBlockedPhrasesCache();

            const result = await checkSafety('/root', 'Any text is fine');

            expect(result.safe).toBe(true);
        });
    });
});
