Nova AI integration plan (GPT-5-mini + docs)

1) Nova API key + knowledge base setup
   - Generate a Nova API key via Telegram: /usersettings -> "API Key".
   - Upload docs to the API key's document library (Telegram) or via API:
     - Base URL: https://gateway.inferenco.com
     - POST /vector-store/files with base64 file contents.
     - Verify with GET /vector-store/files.

2) Replace OpenAI generation with Nova Gateway /ai
   - Update `src/generator.ts` to call POST https://gateway.inferenco.com/ai
     with Authorization: Bearer <NOVA_API_KEY>.
   - Request body fields per docs: input, model, verbosity, max_tokens, reasoning
     (use model = gpt-5-mini by default).
   - Parse the JSON response body, then parse `text` as JSON output
     (text + optional alt_overrides) and keep existing validation/fallback.
   - Keep prompts grounded with voice + queue details and add a "fresh angle"
     instruction to encourage novel posts.

3) Configuration + secrets
   - Replace OPENAI_* with NOVA_* env vars:
     - NOVA_API_KEY (required)
     - NOVA_MODEL (default gpt-5-mini)
     - NOVA_VERBOSITY (default Medium)
     - NOVA_MAX_TOKENS (default 400)
     - NOVA_REASONING (default false)
   - Update `.github/workflows/autopost.yml` and README to document the new
     secrets and defaults.

4) Optional doc-sync script
   - Add a small `scripts/upload-docs.ts` that base64-encodes files from a
     `docs/` folder and calls POST /vector-store/files.
   - Provide a dry-run mode and a simple manifest output so uploads are traceable.

5) Observability + tests
   - Log Nova response metadata (model, total_tokens, file_search) for visibility.
   - Update `src/__tests__/generator.test.ts` to mock fetch and cover:
     - Missing NOVA_API_KEY -> fallback
     - Invalid JSON in response text -> repair/fallback
     - Valid JSON -> success path
