import { ImageAsset } from './images.js';
import { MAX_GRAPHEMES, countGraphemes, validateAltOverrides } from './validate.js';

export interface GenerationResult {
  text: string;
  alt_overrides?: string[];
  model: string;
  source: 'nova' | 'fallback';
  meta?: {
    total_tokens?: number;
    file_search?: number;
    web_search?: number;
    image_generation?: number;
    code_interpreter?: number;
  };
}

export interface GenerationInput {
  voice: string;
  images: ImageAsset[];
}

const DEFAULT_MODEL = process.env.NOVA_MODEL || 'gpt-5-mini';
const DEFAULT_VERBOSITY = normalizeVerbosity(process.env.NOVA_VERBOSITY);
const DEFAULT_MAX_TOKENS = parseMaxTokens(process.env.NOVA_MAX_TOKENS);
const DEFAULT_REASONING = parseBoolean(process.env.NOVA_REASONING);
const NOVA_BASE_URL = process.env.NOVA_BASE_URL || 'https://gateway.inferenco.com';

interface NovaResponse {
  text: string;
  model?: string;
  total_tokens?: number;
  web_search?: number;
  file_search?: number;
  image_generation?: number;
  code_interpreter?: number;
}

export async function generatePost(input: GenerationInput): Promise<GenerationResult> {
  const apiKey = process.env.NOVA_API_KEY;
  if (!apiKey) {
    return fallbackText(input, 'NOVA_API_KEY missing');
  }

  const basePrompt = buildGeneratePrompt(input);

  try {
    const first = await callNova(apiKey, basePrompt);
    const parsed = safeParse(first.text);
    const initial = parsed || null;
    const validated = validateOutput(initial, input.images.length);

    if (validated.ok) {
      return {
        ...validated.output!,
        model: first.model || DEFAULT_MODEL,
        source: 'nova',
        meta: extractMeta(first)
      };
    }

    // Attempt repair
    const repairPrompt = buildRepairPrompt(input.images.length, initial, validated.message);
    const repair = await callNova(apiKey, repairPrompt);
    const repaired = safeParse(repair.text);
    const repairedValid = validateOutput(repaired, input.images.length);
    if (repairedValid.ok) {
      return {
        ...repairedValid.output!,
        model: repair.model || DEFAULT_MODEL,
        source: 'nova',
        meta: extractMeta(repair)
      };
    }

    return fallbackText(input, repairedValid.message || 'repair failed');
  } catch (err) {
    return fallbackText(input, String(err));
  }
}

function buildGeneratePrompt(input: GenerationInput): string {
  const imageContext = input.images
    .map((img, idx) => `Image ${idx + 1}: id=${img.id}, alt="${img.defaultAlt}"`)
    .join('\n');

  const instructions = [
    'You write concise Bluesky posts.',
    'Follow the provided voice rules.',
    'Use uploaded docs as the primary source.',
    'Keep facts grounded; do not invent details.',
    'Pick one specific idea from the docs; avoid generic filler.',
    'Vary the opening and framing each time.',
    'Do not include links unless explicitly present in the docs.',
    'Output JSON only (no markdown, no extra keys).'
  ].join(' ');

  return `${instructions}\n\nVoice rules (authoritative):\n${input.voice}\n\nTask:\nWrite a Bluesky post (max 300 graphemes, target <= 260) grounded in the knowledge base. If an image is relevant, you may align the post with it without inventing visual details.\n\nImages (for grounding; do not invent details):\n${imageContext}\n\nOutput JSON with:\n- text: string\n- alt_overrides: optional array of strings (only include if you are confidently improving the provided alts; never add new visual facts)`;
}

function buildRepairPrompt(imageCount: number, original: any, validationError: string | undefined): string {
  return `You fix JSON outputs. Output JSON only (no markdown, no extra keys).\n\nFix the following output to satisfy constraints:\n- valid JSON\n- text <= 300 graphemes\n- if alt_overrides is present, it must have exactly ${imageCount} strings\n\nOriginal output:\n${JSON.stringify(original)}\n\nConstraint failures:\n${validationError || 'invalid JSON'}`;
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
    output: { text: obj.text, alt_overrides: obj.alt_overrides, model: '', source: 'nova' }
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
  const imageHint = input.images[0]?.defaultAlt;
  const base = imageHint ? `Quick note: ${imageHint}` : 'Quick note from the docs.';
  const text = trimToMaxGraphemes(base, MAX_GRAPHEMES);
  return { text, alt_overrides: undefined, model: 'fallback', source: 'fallback' };
}

function trimToMaxGraphemes(text: string, max: number): string {
  const segments = Array.from(new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(text));
  if (segments.length <= max) return text;
  return segments.slice(0, max).map((s) => s.segment).join('');
}

async function callNova(apiKey: string, prompt: string): Promise<NovaResponse> {
  const response = await fetch(`${NOVA_BASE_URL}/ai`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      input: prompt,
      model: DEFAULT_MODEL,
      verbosity: DEFAULT_VERBOSITY,
      max_tokens: DEFAULT_MAX_TOKENS,
      reasoning: DEFAULT_REASONING
    })
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Nova API error ${response.status}: ${body}`);
  }

  const data = (await response.json()) as NovaResponse;
  if (!data || typeof data.text !== 'string') {
    throw new Error('Nova response missing text');
  }
  return data;
}

function parseBoolean(value: string | undefined): boolean {
  return String(value || '').toLowerCase() === 'true';
}

function normalizeVerbosity(value: string | undefined): 'Low' | 'Medium' | 'High' {
  const normalized = String(value || '').toLowerCase();
  if (normalized === 'low') return 'Low';
  if (normalized === 'high') return 'High';
  return 'Medium';
}

function parseMaxTokens(value: string | undefined): number {
  const parsed = Number.parseInt(String(value || ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 400;
}

function extractMeta(response: NovaResponse): GenerationResult['meta'] {
  return {
    total_tokens: typeof response.total_tokens === 'number' ? response.total_tokens : undefined,
    file_search: typeof response.file_search === 'number' ? response.file_search : undefined,
    web_search: typeof response.web_search === 'number' ? response.web_search : undefined,
    image_generation: typeof response.image_generation === 'number' ? response.image_generation : undefined,
    code_interpreter: typeof response.code_interpreter === 'number' ? response.code_interpreter : undefined
  };
}
