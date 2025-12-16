/**
 * Safety filter to check for blocked phrases.
 * Reads from content/blocked_phrases.txt
 */

import fs from 'node:fs/promises';
import path from 'node:path';

let blockedPhrases: string[] | null = null;

export async function loadBlockedPhrases(root: string): Promise<string[]> {
    if (blockedPhrases !== null) {
        return blockedPhrases;
    }

    const filePath = path.join(root, 'content', 'blocked_phrases.txt');
    try {
        const raw = await fs.readFile(filePath, 'utf8');
        blockedPhrases = raw
            .split('\n')
            .map(line => line.trim().toLowerCase())
            .filter(line => line && !line.startsWith('#'));
        return blockedPhrases;
    } catch (err) {
        // File doesn't exist, no blocked phrases
        blockedPhrases = [];
        return blockedPhrases;
    }
}

export interface SafetyCheckResult {
    safe: boolean;
    blockedPhrase?: string;
}

export async function checkSafety(root: string, text: string): Promise<SafetyCheckResult> {
    const phrases = await loadBlockedPhrases(root);
    const lowerText = text.toLowerCase();

    for (const phrase of phrases) {
        if (lowerText.includes(phrase)) {
            return { safe: false, blockedPhrase: phrase };
        }
    }

    return { safe: true };
}

// Reset cache (useful for testing)
export function resetBlockedPhrasesCache(): void {
    blockedPhrases = null;
}
