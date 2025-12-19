import { ImageAsset } from './images.js';
import { MAX_GRAPHEMES, countGraphemes } from './validate.js';

export interface PostOutput {
  text: string;
  hashtags: string[];
  alt_text?: string;
}

export interface GenerationResult {
  text: string;
  hashtags: string[];
  alt_text?: string;
  model: string;
  source: 'nova' | 'fallback';
  meta?: {
    total_tokens?: number;
    file_search?: number;
  };
}

export interface GenerationInput {
  image: ImageAsset;
}

const DEFAULT_MODEL = process.env.NOVA_MODEL || 'gpt-5-mini';
const DEFAULT_MAX_TOKENS = parseMaxTokens(process.env.NOVA_MAX_TOKENS);
const NOVA_BASE_URL = process.env.NOVA_BASE_URL || 'https://gateway.inferenco.com';

interface NovaResponse {
  text: string;
  model?: string;
  total_tokens?: number;
  file_search?: number;
}

/**
 * Generate a Bluesky post using Nova API.
 * Nova already has knowledge via its built-in document store (RAG).
 */
export async function generatePost(input: GenerationInput): Promise<GenerationResult> {
  const apiKey = process.env.NOVA_API_KEY;
  if (!apiKey) {
    return fallbackResult('NOVA_API_KEY missing');
  }

  const prompt = `Write a short engaging Bluesky post about Inferenco based on your knowledge. Include 2-3 hashtags. Output as JSON: {"text": "...", "hashtags": ["...", "..."]}`;

  try {
    const response = await callNova(apiKey, prompt);
    console.log('Full Nova response:', JSON.stringify(response, null, 2));
    const parsed = safeParse(response.text);

    if (parsed && isValidOutput(parsed)) {
      // Validate grapheme count
      if (countGraphemes(parsed.text) > MAX_GRAPHEMES) {
        return fallbackResult('Generated text too long');
      }

      return {
        text: parsed.text,
        hashtags: parsed.hashtags || [],
        alt_text: parsed.alt_text,
        model: response.model || DEFAULT_MODEL,
        source: 'nova',
        meta: {
          total_tokens: response.total_tokens,
          file_search: response.file_search
        }
      };
    }

    console.log('Parsed result:', parsed);
    return fallbackResult('Invalid JSON response from Nova');
  } catch (err) {
    return fallbackResult(String(err));
  }
}

function isValidOutput(obj: unknown): obj is PostOutput {
  if (!obj || typeof obj !== 'object') return false;
  const o = obj as Record<string, unknown>;
  if (typeof o.text !== 'string') return false;
  if (!Array.isArray(o.hashtags)) return false;
  return true;
}

function safeParse(content: string): PostOutput | null {
  try {
    // Try to extract JSON from the response (in case there's extra text)
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
    return JSON.parse(content);
  } catch {
    return null;
  }
}

function fallbackResult(reason: string): GenerationResult {
  console.warn(`Generation fallback: ${reason}`);
  return {
    text: 'Building the future with blockchain & AI. 🚀',
    hashtags: ['blockchain', 'AI', 'Inferenco'],
    alt_text: 'Inferenco promotional image',
    model: 'fallback',
    source: 'fallback'
  };
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
      verbosity: 'low',
      max_tokens: DEFAULT_MAX_TOKENS,
      reasoning: true,
      effort: 'low',
      image_urls: []
    })
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Nova API error ${response.status}: ${body}`);
  }

  const data = (await response.json()) as NovaResponse;
  console.log('Full Nova response:', JSON.stringify(data, null, 2));
  if (!data || typeof data.text !== 'string') {
    throw new Error('Nova response missing text');
  }
  return data;
}

function parseMaxTokens(value: string | undefined): number {
  const parsed = Number.parseInt(String(value || ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 8000;
}
