import { describe, expect, test, vi } from 'vitest';
import { OpenAIInferencoPostGenerator } from '../services/postGenerator.js';

function jsonResponse(payload: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload)
  } as Response;
}

describe('OpenAIInferencoPostGenerator', () => {
  test('requests a structured Inferenco post with the configured OpenAI model', async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({
      output_text: JSON.stringify({
        body: 'Need production-ready software without the guesswork? Inferenco builds apps, AI systems, and Web3 platforms with a transparent path from interview to delivery. Start at inferenco.com or spielcrypto@inferenco.com',
        tags: ['Inferenco', 'CustomSoftware', 'AI', 'Web3']
      })
    }));
    const generator = new OpenAIInferencoPostGenerator({
      apiKey: 'test-openai-key',
      model: 'gpt-5.4-mini',
      fetcher
    });

    const suggestion = await generator.generate();

    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe('https://api.openai.com/v1/responses');
    expect(init.headers.Authorization).toBe('Bearer test-openai-key');
    const requestBody = JSON.parse(init.body);
    expect(requestBody.model).toBe('gpt-5.4-mini');
    expect(requestBody.reasoning).toEqual({ effort: 'low', summary: 'auto' });
    expect(requestBody.text.verbosity).toBe('medium');
    expect(requestBody.text.format.type).toBe('json_schema');
    expect(requestBody.store).toBe(true);
    expect(JSON.stringify(requestBody)).toContain('spielcrypto@inferenco.com');
    expect(JSON.stringify(requestBody)).toContain('singularityshift@inferenco.com');
    expect(JSON.stringify(requestBody)).toContain('Custom Application Development');

    expect(suggestion.body).toContain('inferenco.com');
    expect(suggestion.body).toMatch(/spielcrypto@inferenco\.com|singularityshift@inferenco\.com/);
    expect(suggestion.tags).toEqual(['Inferenco', 'CustomSoftware', 'AI', 'Web3']);
  });

  test('normalizes missing contact details and hash-prefixed tags', async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({
      output: [
        {
          content: [
            {
              type: 'output_text',
              text: JSON.stringify({
                body: 'Inferenco helps teams ship custom software, AI systems, and cloud platforms through a clear proposal-led process.',
                tags: ['#Inferenco', 'Custom Software', 'AI & ML', 'Web3', 'Cloud DevOps', 'Consulting', 'Extra']
              })
            }
          ]
        }
      ]
    }));
    const generator = new OpenAIInferencoPostGenerator({
      apiKey: 'test-openai-key',
      model: 'gpt-5.4-mini',
      fetcher
    });

    const suggestion = await generator.generate();

    expect(suggestion.body).toContain('inferenco.com');
    expect(suggestion.body).toContain('spielcrypto@inferenco.com');
    expect(suggestion.tags).toEqual(['Inferenco', 'CustomSoftware', 'AIML', 'Web3', 'CloudDevOps', 'Consulting']);
  });

  test('keeps required site and email when trimming long model output', async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({
      output_text: JSON.stringify({
        body: `Inferenco ${'ships reliable custom software '.repeat(20)}`,
        tags: ['Inferenco', 'Software', 'AI']
      })
    }));
    const generator = new OpenAIInferencoPostGenerator({
      apiKey: 'test-openai-key',
      model: 'gpt-5.4-mini',
      fetcher
    });

    const suggestion = await generator.generate();

    expect(suggestion.body).toContain('inferenco.com');
    expect(suggestion.body).toContain('spielcrypto@inferenco.com');
    expect([...new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(suggestion.body)]).toHaveLength(300);
  });

  test('throws a clear error when the API key is missing', async () => {
    const generator = new OpenAIInferencoPostGenerator({
      apiKey: null,
      model: 'gpt-5.4-mini',
      fetcher: vi.fn()
    });

    await expect(generator.generate()).rejects.toThrow('OPENAI_API_KEY is not configured');
  });
});
