# Bluesky Autoposter with Nova API

## Overview

The **Nova API** already has knowledge of posting subjects through its built-in document store (RAG). This means the app does **not** need to manage prompts, content, or knowledge bases—Nova handles all of that internally.

The app's job is simple:
1. **Request a Bluesky post** from Nova on a schedule
2. **Randomly select an image** from `assets/images/originals`
3. **Publish the response** to Bluesky

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      GitHub Action                          │
│                  (scheduled cron trigger)                    │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                       1. Select Image                        │
│         Randomly pick an image from originals folder         │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                    2. Call Nova API                          │
│    POST /ai with simple prompt + JSON schema constraint      │
│    Nova uses its built-in knowledge to generate the post     │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                   3. Publish to Bluesky                      │
│              Upload image + post text + hashtags             │
└─────────────────────────────────────────────────────────────┘
```

---

## Implementation Details

### 1. Nova API Call

**Endpoint:** `POST https://gateway.inferenco.com/ai`

**Request:**
```typescript
{
  input: "Write a Bluesky post for Inferenco. Use your knowledge base.",
  model: "gpt-5-mini",
  verbosity: "Medium",
  max_tokens: 400,
  reasoning: false,
  response_format: {
    type: "json_schema",
    json_schema: {
      name: "bluesky_post",
      schema: {
        type: "object",
        properties: {
          text: { type: "string", description: "Post text (max 300 chars)" },
          hashtags: { 
            type: "array", 
            items: { type: "string" },
            description: "Relevant hashtags without # prefix"
          },
          alt_text: { type: "string", description: "Alt text for the image" }
        },
        required: ["text", "hashtags"]
      }
    }
  }
}
```

**Response:**
```typescript
{
  text: "{ \"text\": \"...\", \"hashtags\": [...], \"alt_text\": \"...\" }",
  model: "gpt-5-mini",
  total_tokens: 150,
  file_search: 1  // Indicates RAG was used
}
```

### 2. Image Selection

Randomly select one image from `assets/images/originals/`:
- Read directory contents
- Pick a random file
- Use for the Bluesky post embed

### 3. Post Construction

Combine Nova's response into a Bluesky post:
- **Text:** `{response.text}\n\n{hashtags.map(h => '#' + h).join(' ')}`
- **Image:** Random image from originals with `alt_text` from Nova
- **RKey:** Use timestamp-based unique key

---

## Changes Required

### `src/generator.ts`

Simplify to:
- Remove complex prompt building (Nova already has the knowledge)
- Add JSON schema for structured output with hashtags
- Simple prompt: "Write a Bluesky post for Inferenco. Use your knowledge base."

### `src/images.ts`

Update to:
- Select a random image from `assets/images/originals`
- No need for complex manifest tracking

### `src/index.ts`

Simplify the main flow:
1. Pick random image
2. Call Nova with JSON schema
3. Parse response
4. Construct post with text + hashtags
5. Publish to Bluesky

---

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `NOVA_API_KEY` | ✅ | - | Nova API key with knowledge base |
| `BLUESKY_IDENTIFIER` | ✅ | - | Bluesky handle |
| `BLUESKY_PASSWORD` | ✅ | - | Bluesky app password |
| `NOVA_MODEL` | ❌ | `gpt-5-mini` | Model to use |
| `NOVA_MAX_TOKENS` | ❌ | `400` | Max response tokens |

---

## JSON Schema Output

The Nova API will return structured JSON with:

```typescript
interface PostOutput {
  text: string;      // The main post content
  hashtags: string[]; // Array of hashtags (without #)
  alt_text?: string;  // Optional alt text for image
}
```

This ensures consistent, parseable output every time.

---

## Verification

1. **Unit Tests:** Mock Nova API response, verify JSON parsing and post construction
2. **Integration Test:** Run with real Nova API key, verify structured output
3. **Manual Test:** Trigger workflow, check Bluesky post appears correctly
