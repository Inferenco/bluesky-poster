import OpenAI from 'openai';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { ImageAsset } from './images.js';
import { QueueItem } from './queue.js';
import { MAX_GRAPHEMES, countGraphemes, validateAltOverrides } from './validate.js';

export interface GenerationResult {
  text: string;
  alt_overrides?: string[];
  model: string;
  source: 'openai' | 'fallback';
}

export interface GenerationInput {
  voice: string;
  item: QueueItem;
  images: ImageAsset[];
}

const DEFAULT_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

export async function generatePost(input: GenerationInput): Promise<GenerationResult> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return fallbackText(input, 'OPENAI_API_KEY missing');
  }

  const client = new OpenAI({ apiKey });
  const basePayload = buildGeneratePrompt(input);

  try {
    const first = await client.chat.completions.create({
      model: DEFAULT_MODEL,
      messages: basePayload,
      response_format: { type: 'json_object' }
    });

    const parsed = safeParse(first.choices[0]?.message?.content || '');
    const initial = parsed || null;
    const validated = validateOutput(initial, input.images.length);

    if (validated.ok) {
      return { ...validated.output!, model: first.model, source: 'openai' };
    }

    // Attempt repair
    const repair = await client.chat.completions.create({
      model: DEFAULT_MODEL,
      messages: buildRepairPrompt(input.images.length, initial, validated.message),
      response_format: { type: 'json_object' }
    });

    const repaired = safeParse(repair.choices[0]?.message?.content || '');
    const repairedValid = validateOutput(repaired, input.images.length);
    if (repairedValid.ok) {
      return { ...repairedValid.output!, model: repair.model, source: 'openai' };
    }

    return fallbackText(input, repairedValid.message || 'repair failed');
  } catch (err) {
    return fallbackText(input, String(err));
  }
}

function buildGeneratePrompt(input: GenerationInput): ChatCompletionMessageParam[] {
  const imageContext = input.images
    .map((img, idx) => `Image ${idx + 1}: id=${img.id}, alt="${img.defaultAlt}"`)
    .join('\n');

  const system = 'You write concise Bluesky posts. Follow the provided voice rules. Output JSON only (no markdown, no extra keys).';
  const user = `Voice rules (authoritative):\n${input.voice}\n\nTask:\nWrite a Bluesky post (max 300 graphemes, target <= 260) about:\n- topic: ${input.item.topic}\n- link (optional): ${input.item.link || ''}\n- call to action (optional): ${input.item.cta || ''}\n- tags: ${input.item.tags.join(', ')}\n\nImages (for grounding; do not invent details):\n${imageContext}\n\nOutput JSON with:\n- text: string\n- alt_overrides: optional array of strings (only include if you are confidently improving the provided alts; never add new visual facts)`;

  return [
    { role: 'system', content: system },
    { role: 'user', content: user }
  ];
}

function buildRepairPrompt(imageCount: number, original: any, validationError: string | undefined): ChatCompletionMessageParam[] {
  const system = 'You fix JSON outputs. Output JSON only (no markdown, no extra keys).';
  const user = `Fix the following output to satisfy constraints:\n- valid JSON\n- text <= 300 graphemes\n- if alt_overrides is present, it must have exactly ${imageCount} strings\n\nOriginal output:\n${JSON.stringify(original)}\n\nConstraint failures:\n${validationError || 'invalid JSON'}`;

  return [
    { role: 'system', content: system },
    { role: 'user', content: user }
  ];
}

function validateOutput(obj: any, imageCount: number): { ok: boolean; message?: string; output?: GenerationResult } {
  if (!obj || typeof obj !== 'object') return { ok: false, message: 'JSON missing or not an object' };
  if (typeof obj.text !== 'string') return { ok: false, message: 'text missing' };

  const { ok: altOk, message: altMsg } = validateAltOverrides(imageCount, obj.alt_overrides);
  if (!altOk) return { ok: false, message: altMsg };

  const count = countGraphemes(obj.text);
  if (count > MAX_GRAPHEMES) {
    return { ok: false, message: `text too long (${count} > ${MAX_GRAPHEMES})` };
  }

  return {
    ok: true,
    output: { text: obj.text, alt_overrides: obj.alt_overrides, model: '', source: 'openai' }
  };
}

function safeParse(content: string): any | null {
  try {
    return JSON.parse(content);
  } catch (err) {
    return null;
  }
}

function fallbackText(input: GenerationInput, reason: string): GenerationResult {
  const base = `${input.item.topic} ${input.item.link || ''} ${input.item.cta ? `— ${input.item.cta}` : ''}`.trim();
  const text = trimToMaxGraphemes(base, MAX_GRAPHEMES);
  return { text, alt_overrides: undefined, model: 'fallback', source: 'fallback' };
}

function trimToMaxGraphemes(text: string, max: number): string {
  const segments = Array.from(new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(text));
  if (segments.length <= max) return text;
  return segments.slice(0, max).map((s) => s.segment).join('');
}
