import crypto from 'node:crypto';
import { URL } from 'node:url';

const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });

export const MAX_GRAPHEMES = 300;

export function countGraphemes(text: string): number {
  return Array.from(segmenter.segment(text)).length;
}

export function ensureTextLength(text: string): { ok: boolean; count: number } {
  const count = countGraphemes(text);
  return { ok: count <= MAX_GRAPHEMES, count };
}

export function normalizeText(text: string): string {
  // Lowercase, collapse whitespace, strip common tracking params from URLs.
  const collapsed = text.replace(/\s+/g, ' ').trim().toLowerCase();
  return collapsed.replace(/https?:\/\/[^\s]+/g, (match) => stripTracking(match));
}

function stripTracking(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    const trackingParams = new Set(['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'gclid', 'fbclid']);
    for (const key of Array.from(url.searchParams.keys())) {
      if (trackingParams.has(key)) {
        url.searchParams.delete(key);
      }
    }
    return url.toString();
  } catch (err) {
    return rawUrl;
  }
}

export function hashText(text: string): string {
  const normalized = normalizeText(text);
  const hash = crypto.createHash('sha256').update(normalized, 'utf8').digest('hex');
  return `sha256:${hash}`;
}

export function validateAltOverrides(count: number, overrides?: string[] | null): { ok: boolean; message?: string } {
  if (!overrides) return { ok: true };
  if (!Array.isArray(overrides)) return { ok: false, message: 'alt_overrides must be an array' };
  if (overrides.length !== count) return { ok: false, message: `alt_overrides must have ${count} entries` };
  if (overrides.some((v) => typeof v !== 'string' || !v.trim())) return { ok: false, message: 'alt_overrides entries must be non-empty strings' };
  return { ok: true };
}
