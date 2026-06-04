import { countGraphemes, MAX_GRAPHEMES } from '../validate.js';

const CONTACT_EMAILS = ['spielcrypto@inferenco.com', 'singularityshift@inferenco.com'] as const;
const BASE_URL = 'inferenco.com';
const RESPONSES_URL = 'https://api.openai.com/v1/responses';

export interface PostSuggestion {
  body: string;
  tags: string[];
}

export interface PostGenerator {
  generate(): Promise<PostSuggestion>;
}

export interface OpenAIInferencoPostGeneratorOptions {
  apiKey: string | null;
  model: string;
  fetcher?: typeof fetch;
}

interface ResponsesApiPayload {
  output_text?: unknown;
  output?: Array<{
    content?: Array<{
      text?: unknown;
    }>;
  }>;
}

export class OpenAIInferencoPostGenerator implements PostGenerator {
  private readonly fetcher: typeof fetch;

  constructor(private readonly options: OpenAIInferencoPostGeneratorOptions) {
    this.fetcher = options.fetcher ?? fetch;
  }

  async generate(): Promise<PostSuggestion> {
    if (!this.options.apiKey) {
      throw new Error('OPENAI_API_KEY is not configured');
    }

    const response = await this.fetcher(RESPONSES_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.options.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(buildOpenAIRequest(this.options.model))
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`OpenAI response generation failed: ${response.status} ${body}`);
    }

    const payload = await response.json() as ResponsesApiPayload;
    return normalizeSuggestion(parseSuggestion(extractOutputText(payload)));
  }
}

function buildOpenAIRequest(model: string): Record<string, unknown> {
  return {
    model,
    instructions: [
      'Generate one Bluesky post suggestion for Inferenco.',
      'Return only JSON matching the supplied schema.',
      'The body must be concise, professional, and under 300 graphemes.',
      `The body must include ${BASE_URL} and exactly one contact email from: ${CONTACT_EMAILS.join(', ')}.`,
      'Tags must be clean tag words without # symbols.'
    ].join(' '),
    input: buildPromptContext(),
    reasoning: {
      effort: 'low',
      summary: 'auto'
    },
    text: {
      verbosity: 'medium',
      format: {
        type: 'json_schema',
        name: 'inferenco_post_suggestion',
        strict: true,
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['body', 'tags'],
          properties: {
            body: {
              type: 'string',
              minLength: 80,
              maxLength: 300
            },
            tags: {
              type: 'array',
              minItems: 3,
              maxItems: 6,
              items: {
                type: 'string',
                minLength: 2,
                maxLength: 24
              }
            }
          }
        }
      }
    },
    store: true
  };
}

function buildPromptContext(): string {
  return `
Inferenco base website: https://inferenco.com
Contact emails: ${CONTACT_EMAILS.join(', ')}

About Inferenco:
Inferenco is a software development company formed through the collaboration of Singularity Shift Ltd and Spielcrypto Ltd. It builds custom software solutions that drive business growth and innovation. Core expertise includes full-stack development, custom software, blockchain and Web3 integration, AI and machine learning, mobile application development, and enterprise system architecture.

Services:
- Custom Application Development: bespoke software designed around business processes.
- Web Development & Design: modern responsive web applications with intuitive UX/UI.
- Mobile App Development: native and cross-platform iOS and Android apps.
- Blockchain & Web3 Development: smart contracts, decentralized applications, and Web3 integrations.
- AI & Machine Learning Solutions: intelligent systems that automate processes, provide insights, and create competitive advantages.
- Cloud & DevOps Solutions: cloud infrastructure, CI/CD, reliability, and performance practices.
- IT Consulting & Strategy: technology selection, architecture design, and digital transformation.
- Legacy System Modernization: upgrades for performance, security, and maintainability.

Methodology:
1. You Contact Us by email to start the project conversation.
2. We Schedule an Interview to understand project needs and business objectives.
3. You Receive a Detailed Proposal with costs, timeline, and required access/accounts.
4. We Sign the Contract and begin the project.
5. You Get Your Invoice from the preferred company and work starts.

Approach:
Transparent, collaborative, results-driven software development with continuous communication, honest pricing, quality and reliability, practical innovation, timely delivery, and scalable architectures.
`.trim();
}

function extractOutputText(payload: ResponsesApiPayload): string {
  if (typeof payload.output_text === 'string') {
    return payload.output_text;
  }

  for (const item of payload.output ?? []) {
    for (const content of item.content ?? []) {
      if (typeof content.text === 'string') {
        return content.text;
      }
    }
  }

  throw new Error('OpenAI response did not include output text');
}

function parseSuggestion(raw: string): PostSuggestion {
  const parsed = JSON.parse(raw) as Partial<PostSuggestion>;
  if (typeof parsed.body !== 'string' || !Array.isArray(parsed.tags)) {
    throw new Error('OpenAI response did not match the post suggestion schema');
  }
  return {
    body: parsed.body,
    tags: parsed.tags.filter((tag): tag is string => typeof tag === 'string')
  };
}

function normalizeSuggestion(input: PostSuggestion): PostSuggestion {
  const body = input.body.replace(/\s+/g, ' ').trim();
  return {
    body: trimToLimit(ensureRequiredContact(body)),
    tags: normalizeTags(input.tags)
  };
}

function ensureRequiredContact(body: string): string {
  const requiredParts: string[] = [];
  const lowered = body.toLowerCase();
  if (!lowered.includes(BASE_URL)) requiredParts.push(BASE_URL);
  if (!CONTACT_EMAILS.some((email) => lowered.includes(email))) requiredParts.push(CONTACT_EMAILS[0]);
  if (requiredParts.length === 0) return body;

  const suffix = ` ${requiredParts.join(' ')}`;
  const availableBodyLength = MAX_GRAPHEMES - graphemeLength(suffix);
  const normalized = `${takeGraphemes(body, Math.max(0, availableBodyLength)).trimEnd()}${suffix}`;
  return normalized;
}

function trimToLimit(body: string): string {
  if (countGraphemes(body) <= MAX_GRAPHEMES) return body;
  return takeGraphemes(body, MAX_GRAPHEMES).trim();
}

function graphemeLength(value: string): number {
  return Array.from(new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(value)).length;
}

function takeGraphemes(value: string, limit: number): string {
  return Array.from(new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(value))
    .slice(0, limit)
    .map((segment) => segment.segment)
    .join('');
}

function normalizeTags(tags: string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const tag of tags) {
    const cleaned = tag
      .replace(/^#+/, '')
      .replace(/&/g, '')
      .replace(/[^a-zA-Z0-9]+/g, ' ')
      .split(' ')
      .filter(Boolean)
      .map((part) => part[0].toUpperCase() + part.slice(1))
      .join('');
    if (!cleaned || seen.has(cleaned.toLowerCase())) continue;
    seen.add(cleaned.toLowerCase());
    normalized.push(cleaned);
    if (normalized.length === 6) break;
  }

  return normalized.length > 0 ? normalized : ['Inferenco', 'CustomSoftware', 'AI'];
}
