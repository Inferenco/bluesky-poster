# Static (Hostless) Bluesky Autoposter — Build Spec

A small Node.js + TypeScript autoposter that runs on **GitHub Actions cron** (no server, no DB) and posts to **Bluesky only** from:

- a static, local **content queue** (`content/queue.csv`)
- a static, local **image pool** (`assets/images/processed/*` + `assets/images/manifest.json`)
- a committed **state file** (`state/state.json`) so it never repeats

It generates post copy with a lightweight OpenAI model, uploads 1–4 images as blobs, and posts an `app.bsky.embed.images` embed.

## Hard constraints (enforced in code)

- **Post text:** ≤ **300 grapheme clusters** (use `Intl.Segmenter` on Node 20+, not `.length`)
- **Images:** 1–4 images, each **≤ 1,000,000 bytes**
- **Alt text:** required for every image

## Reliability upgrades (vs “easy mode”)

1. **Idempotent posting:** create the Bluesky record with a deterministic `rkey` derived from `queue.csv:id` (so workflow retries can’t double-post the same queue item).
2. **Concurrency-safe Actions:** use workflow `concurrency` to prevent overlapping runs.
3. **Fallback copy:** if OpenAI fails or output is invalid, post a deterministic template (or exit cleanly in `DRY_RUN`).
4. **State stays small:** trim “recent” arrays to a fixed size; keep `posted_ids` as the canonical “never repeat” list.

## Repo layout

```
/config
  voice.md
  schedule.json

/content
  queue.csv

/assets/images
  originals/        # gitignored (optional)
  processed/        # committed
  manifest.json     # committed

/state
  state.json        # committed (updated by Actions)

/src
  index.ts          # CLI entry
  bluesky.ts        # login + upload + createRecord
  generator.ts      # OpenAI JSON generation + repair
  images.ts         # image selection + manifest loading
  queue.ts          # CSV parsing + selection
  state.ts          # load/save + trimming
  validate.ts       # grapheme count + schema checks

/scripts
  preprocess-images.ts
```

## Data files (schemas)

### `content/queue.csv`

One row = one post. Minimal columns plus optional overrides.

```csv
id,topic,link,tags,cta,active,image_ids
001,"Circle wallet multichain update","https://example.com","product;wallet;update","Try it today",true,
002,"Dev tip: prompts that behave","https://example.com","dev;ai;tips","More tomorrow",true,"product-card-001;product-card-002"
```

- `tags`: semicolon-separated (`;`)
- `active`: `true|false`
- `image_ids` (optional): semicolon-separated IDs from `manifest.json` to force exact images

Selection rule: pick the **first** row where `active=true` and `id` is not in `state.posted_ids` (deterministic, easy to reason about).

### `assets/images/manifest.json`

Static pool definition (built by the preprocess script).

```json
{
  "images": [
    {
      "id": "product-card-001",
      "path": "assets/images/processed/product-card-001.jpg",
      "tags": ["product", "wallet", "update"],
      "defaultAlt": "Branded product card with the headline 'Multichain update' and a logo.",
      "width": 1200,
      "height": 675,
      "bytes": 184233,
      "mime": "image/jpeg"
    }
  ]
}
```

### `config/schedule.json`

```json
{
  "posts_per_day": 3,
  "default_images_per_post": 1,
  "max_images_per_post": 4,
  "quiet_hours_utc": ["23:00", "07:00"],
  "random_jitter_minutes": 12,
  "max_recent_image_ids": 40,
  "max_recent_text_hashes": 80
}
```

### `state/state.json`

```json
{
  "posted_ids": ["001"],
  "recent_text_hashes": ["sha256:..."],
  "recent_image_ids": ["product-card-001"],
  "posted_today_utc": "2025-12-15",
  "posted_today_count": 1,
  "last_posted_at": "2025-12-15T09:00:00.000Z"
}
```

## Image pool workflow (static, no runtime processing)

Run `scripts/preprocess-images.ts` locally when you add images:

- auto-orient (`rotate()`)
- resize if needed (e.g. max dimension 1600px)
- encode to JPG/PNG and **ensure `< 1,000,000` bytes**
- write into `assets/images/processed/`
- update `assets/images/manifest.json` with `width/height/bytes/mime`

Commit `processed/` + `manifest.json`. Keep `originals/` gitignored if you want.

## Image selection (per post)

1. If `queue.csv:image_ids` is provided: use those (1–4), validate they exist and are ≤1MB.
2. Else:
   - compute tag overlap score between queue tags and image tags
   - prefer images not in `state.recent_image_ids`
   - pick `N = min(default_images_per_post, max_images_per_post)` (at least 1 if available)

## Post generation (OpenAI) with strict output

Inputs:

- `config/voice.md` (tone rules)
- queue fields (`topic`, `link`, `cta`, `tags`)
- selected images’ `defaultAlt` (so copy matches visuals)

Required model output (strict JSON):

```json
{
  "text": "…",
  "alt_overrides": ["…"]
}
```

### Prompt templates (copy/paste)

**Generate**

System:

> You write concise Bluesky posts. Follow the provided voice rules. Output JSON only (no markdown, no extra keys).

User (template):

> Voice rules (authoritative):
> {{voice_md}}
>
> Task:
> Write a Bluesky post (max 300 graphemes, target ≤ 260) about:
> - topic: {{topic}}
> - link (optional): {{link}}
> - call to action (optional): {{cta}}
> - tags: {{tags}}
>
> Images (for grounding; do not invent details):
> {{images_with_defaultAlt}}
>
> Output JSON with:
> - text: string
> - alt_overrides: optional array of strings (only include if you are confidently improving the provided alts; never add new visual facts)

**Repair/shorten**

System:

> You fix JSON outputs. Output JSON only (no markdown, no extra keys).

User (template):

> Fix the following output to satisfy constraints:
> - valid JSON
> - text ≤ 300 graphemes
> - if alt_overrides is present, it must have exactly {{image_count}} strings
>
> Original output:
> {{original_json}}
>
> Constraint failures:
> {{validation_errors}}

Rules:

- `text` must be ≤ 300 graphemes (target ≤ 260 to leave buffer)
- `alt_overrides` is optional; if present it must have **exactly N** strings (N images)
- alt text should default to `defaultAlt` unless a safe override is provided

Repair strategy:

- If JSON invalid or `text` too long: make **one** “shorten/fix” call.
- If still invalid: fall back to a deterministic template like `"{topic} {link} — {cta}"` trimmed to 300 graphemes.

De-dupe:

- Normalize text (lowercase, collapse whitespace, strip common tracking params from URLs).
- Hash with SHA-256 and compare to `state.recent_text_hashes` (regen once or fall back).

## Bluesky posting flow (exact)

1. Login with app password (`agent.login({ identifier, password })`)
2. Upload each image as a blob (≤1MB, correct mime)
3. Create the post record with an `app.bsky.embed.images` embed

**Idempotency:** use `queue.id` as the record `rkey` when calling `com.atproto.repo.createRecord` for `app.bsky.feed.post`. If the record already exists, treat it as “already posted”, update state, and exit cleanly.

## Scheduling (GitHub Actions, no hosting)

- Run the workflow multiple times/day (more triggers than `posts_per_day` is fine).
- Each run:
  - exits if in `quiet_hours_utc`
  - exits if `posted_today_count >= posts_per_day`
  - sleeps a random `0..random_jitter_minutes` before posting (optional)
- On success: commit and push `state/state.json`

Add `concurrency` so only one run can post at a time.

### Example `.github/workflows/autopost.yml`

```yaml
name: autopost
on:
  schedule:
    # Run more often than `posts_per_day` so quiet hours + jitter still work.
    - cron: "7,37 * * * *"
  workflow_dispatch: {}

concurrency:
  group: autopost
  cancel-in-progress: false

permissions:
  contents: write

jobs:
  autopost:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
      - run: npm ci
      - run: npm run autopost
        env:
          BSKY_HANDLE: ${{ secrets.BSKY_HANDLE }}
          BSKY_APP_PASSWORD: ${{ secrets.BSKY_APP_PASSWORD }}
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
          DRY_RUN: ${{ vars.DRY_RUN }}
      - name: Commit state
        run: |
          if git diff --quiet; then exit 0; fi
          git config user.name "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"
          git add state/state.json
          git commit -m "chore: update autoposter state"
          git pull --rebase
          git push

## Secrets (GitHub Actions)

**Required:**
- `BSKY_HANDLE` — Your Bluesky handle (e.g., `yourname.bsky.social`)
- `BSKY_APP_PASSWORD` — App password from Bluesky settings
- `OPENAI_API_KEY` — OpenAI API key for post generation

**Optional:**
- `TG_BOT_TOKEN` — Telegram bot token for notifications (from @BotFather)
- `TG_CHAT_ID` — Telegram chat ID to receive notifications
- `DRY_RUN=true` (as a repository variable) — Test without posting

## Development

```bash
# Install dependencies
npm install

# Run tests
npm run test

# Type check
npm run lint

# Dry run
DRY_RUN=true BSKY_HANDLE=x BSKY_APP_PASSWORD=x OPENAI_API_KEY=your-key npm run autopost
```

## Features

### ✅ Implemented

- **Rich text links** — URLs render as clickable links via `RichText` facets
- **Safety filter** — Blocked phrase checking via `content/blocked_phrases.txt`
- **Telegram notifications** — Optional alerts on post success/failure
- **Idempotent posting** — Deterministic `rkey` prevents double-posting
- **AI with fallback** — OpenAI generation with auto-repair and fallback templates
- **Image handling** — Auto-selection based on tags, recency tracking
- **Comprehensive tests** — 59+ tests covering all core modules

### 🖼️ Adding Images

1. Add your images to `assets/images/originals/`
2. Run `npm run preprocess-images`
3. Update `assets/images/manifest.json` with tags and alt text
4. Commit `assets/images/processed/` and `manifest.json`

### 📝 Adding Content

Edit `content/queue.csv` with your topics:

```csv
id,topic,link,tags,cta,active,image_ids
011,"Your topic here","https://link.com","tag1;tag2","Call to action",true,
```
