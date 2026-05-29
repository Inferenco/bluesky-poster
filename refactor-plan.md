# Refactor report for a Bluesky autoposter with a message dashboard

## Executive summary

The current `Inferenco/bluesky-poster` repository is a small TypeScript CLI bot, not a dashboard application. It selects a random image, asks Nova AI to generate text, then posts to Bluesky from a GitHub Actions cron job. It has no web server, no dashboard for entering/saving pre-set messages, no database, no durable production storage, no structured observability layer, and no operator-facing admin controls. The repository’s current shape is therefore materially different from the target product you now want: an always-on system with a dashboard where an operator can enter, save, approve, and automatically rotate pre-written Bluesky posts at random intervals. fileciteturn43file0L3-L25 fileciteturn44file0L16-L27 fileciteturn46file0L43-L79 fileciteturn56file0L3-L12

There is also a concrete implementation defect in the current scheduled job: `src/index.ts` exits unless `BOT_ENABLED=true`, but the scheduled GitHub Actions workflow does not pass `BOT_ENABLED` into the runtime environment. Unless that value is being injected elsewhere, scheduled runs will simply exit without posting. The current “random interval” implementation is also only an approximation: the workflow runs on a fixed cron twice per hour, and the process then sleeps for a random number of minutes. That is not the same as a persistent 24/7 random scheduler. fileciteturn44file0L17-L21 fileciteturn44file0L76-L83 fileciteturn53file0L3-L7

The best refactor path is to keep **TypeScript/Node.js** because the repo already uses it and Bluesky’s official TypeScript library supports session management, posting, blob upload, and rich-text facets. The product should become a small web application with an embedded poster worker: **dashboard UI + API server + persistent scheduler + durable database + poster service + logs/metrics/alerts**. For a single-account automation tool, the bot worker should use a **Bluesky app password**; if the dashboard later needs to let multiple end users connect their own Bluesky accounts, add **OAuth** for that future mode. Bluesky’s own docs say OAuth is not currently recommended for headless bots, while the official SDK documentation steers general session management towards OAuth; the practical synthesis is: **app password for the headless worker, OAuth only when you turn the dashboard into a real multi-user web app**. citeturn13view0turn27view0

For hosting, **Replit Reserved VM** is the correct Replit deployment mode for a dashboard plus continuous worker, because Reserved VM is always-on and intended for bots/API servers; **Replit Scheduled Deployment** is explicitly for periodic jobs and not for continuous or long-running applications. If you publish on Replit, do **not** rely on the published filesystem for state; Replit’s own docs advise against relying on data written to a published app filesystem, so production state should live in a database. citeturn37view2turn37view4turn33view2

## Assumptions and target outcome

The user asked for “a dashboard where we can input and save the tweets for the automation to select from”. In this report I interpret that as **a private operator dashboard for writing and managing Bluesky post templates/messages**, not X/Twitter integration.

| Assumption | Working default |
|---|---|
| Account model | One Bluesky account in v1, because the current repo only supports a single credential set via environment variables. fileciteturn57file0L3-L14 |
| Runtime | Keep Node.js + TypeScript, because the existing repo already uses it and depends on `@atproto/api`. fileciteturn43file0L3-L25 |
| Content model | Replace Nova-generated posting as the **primary** path with **operator-authored messages** stored in a dashboard-managed database. Keep AI drafting only as an optional future feature, not the main poster path. fileciteturn46file0L43-L79 |
| Posting frequency | Make interval fully configurable in the dashboard; recommended default for v1: **minimum 60 minutes, maximum 180 minutes, 24/7 enabled by default**, with optional quiet hours if you want them later. This is a product assumption, not a Bluesky requirement. |
| Media | Text-first posts with optional image attachments; cap at Bluesky-supported limits and require alt text for each attached image. citeturn12view1turn24view1 |
| Scale | Single deployment instance in v1. Design the DB and lock model so that a second instance can be added safely later. |
| Language / framework | Unspecified by the request. My recommendation is still TypeScript/Node because it preserves the current codebase and the official library support is strongest there. fileciteturn43file0L3-L25 citeturn27view0 |

The target outcome should therefore be: **a private dashboard where an operator can create, edit, pause, delete, tag, preview, and approve saved Bluesky messages; the system then posts eligible messages at truly randomised intervals from an always-on worker, with deduplication, cooldowns, history, retries, logs, and monitoring**.

## Audit of the current repository

### Repository structure and what it does today

The repository is small and coherent, but narrowly scoped. The key audited files are:

| File | Role | Key evidence |
|---|---|---|
| [`package.json`](https://github.com/Inferenco/bluesky-poster/blob/main/package.json) | Shows the app is a CLI-style TypeScript project with no web framework dependencies. | `autopost` runs `tsx src/index.ts`; dependencies are only `@atproto/api`, `image-size`, and `sharp`; there is no Fastify/Express/React/DB package. fileciteturn43file0L3-L25 |
| [`src/index.ts`](https://github.com/Inferenco/bluesky-poster/blob/main/src/index.ts) | Main orchestration flow. | Loads schedule/state, picks one random image, calls Nova, builds text, sleeps with jitter, logs in, posts, then writes state. fileciteturn44file0L23-L27 fileciteturn44file0L40-L89 fileciteturn44file0L108-L126 |
| [`src/bluesky.ts`](https://github.com/Inferenco/bluesky-poster/blob/main/src/bluesky.ts) | Bluesky login and post implementation. | Uses `BskyAgent({ service: 'https://bsky.social' })`, uploads blobs, detects facets with `RichText`, then calls `createRecord`. fileciteturn45file0L24-L27 fileciteturn45file0L30-L78 |
| [`src/generator.ts`](https://github.com/Inferenco/bluesky-poster/blob/main/src/generator.ts) | Nova-dependent content generation. | Prompts Nova for JSON-ish output and falls back to a hard-coded generic post if Nova fails. fileciteturn46file0L43-L79 fileciteturn46file0L103-L112 |
| [`src/state.ts`](https://github.com/Inferenco/bluesky-poster/blob/main/src/state.ts) | Flat-file state storage. | Reads/writes `state/state.json`; no database or locking. fileciteturn48file0L25-L47 |
| [`config/schedule.json`](https://github.com/Inferenco/bluesky-poster/blob/main/config/schedule.json) | Existing schedule settings. | `posts_per_day: 12`, `random_jitter_minutes: 10`, quiet hours `00:00`–`06:00` UTC. fileciteturn51file0L3-L14 |
| [`.github/workflows/autopost.yml`](https://github.com/Inferenco/bluesky-poster/blob/main/.github/workflows/autopost.yml) | Existing automation host. | Runs on fixed cron `7,37 * * * *`, passes Bluesky/Nova env vars, then commits `state/state.json` back to git. fileciteturn53file0L3-L7 fileciteturn53file0L28-L50 |
| [`README.md`](https://github.com/Inferenco/bluesky-poster/blob/main/README.md) | Documents current intent. | Describes random image + Nova AI + publish; no dashboard or service model. fileciteturn56file0L3-L12 |

### What is sound

The current repo does a few things correctly for a minimal bot. It uses the official Bluesky TypeScript client, it uses `RichText.detectFacets()` so links/mentions can be transformed into proper facets, it hashes normalised text to reduce duplicate posting, and it already has some unit tests around text validation, image selection, generator behaviour, and state logic. fileciteturn45file0L48-L61 fileciteturn49file0L8-L16 fileciteturn49file0L40-L50 fileciteturn50file0L51-L116 fileciteturn58file0L27-L147 fileciteturn59file0L16-L72 fileciteturn60file0L6-L127

The use of `https://bsky.social` in the TypeScript SDK is reasonable for Bluesky-hosted accounts, because Bluesky’s “entryway” service is designed to hide underlying PDS hosts, and Bluesky’s TypeScript library can dynamically route to the user’s actual PDS after session creation. citeturn43view0turn43view1

### Gaps, defects, and missing pieces

The largest gap is product mismatch: the repo is built around **AI generation from Nova**, while the requested system is built around **author-managed saved messages**. The README, plan, and generator all point to Nova as the content source; there is no CRUD layer for post templates, no approval workflow, and no operator UI. fileciteturn54file0L5-L13 fileciteturn54file0L108-L131 fileciteturn56file0L5-L12 fileciteturn46file0L43-L79

The scheduling model is also not the right one for the new requirement. Today it is “cron + jitter + exit”, not a persistent 24/7 scheduler. It cannot compute and persist a true `next_run_at`, it cannot reschedule itself after a successful post, and it cannot handle dashboard-driven min/max interval changes in real time. It is also coupled to GitHub Actions and git state commits, which is operationally brittle for a dashboard product. fileciteturn53file0L3-L7 fileciteturn44file0L76-L83 fileciteturn53file0L43-L50

There is a likely runtime bug in production scheduling: `BOT_ENABLED` defaults to false in code and `.env.example`, but the workflow never supplies it. That should be treated as a P0 fix even before the larger refactor. fileciteturn44file0L17-L21 fileciteturn57file0L3-L14 fileciteturn53file0L30-L42

State handling is too weak for an always-on admin product. The app stores everything in `state/state.json` and then commits that file back to the repo after posting. For a dashboard this is the wrong persistence model: it is hard to query, hard to audit, unsafe under concurrent instances, and awkward for operator edits and post history. Replit also advises against relying on the published app filesystem for stored data. fileciteturn48file0L25-L47 fileciteturn52file0L3-L10 fileciteturn53file0L43-L50 citeturn33view2

A few internal config values are either drifting or only partially used. `config/schedule.json` exposes `default_images_per_post` and `max_images_per_post`, and state tracks `recent_image_ids`, but the runtime path always selects exactly one image and never consults `recent_image_ids` before selection. That is a design smell and makes the current duplicate-avoidance incomplete. fileciteturn51file0L4-L13 fileciteturn47file0L23-L76 fileciteturn48file0L6-L23 fileciteturn44file0L40-L47 fileciteturn44file0L118-L123

The image policy is conservative but stale. The repo rejects images over 1 MB and the preprocessor targets 950 KB, while Bluesky’s current image-embed lexicon allows images up to 2 MB each and up to four images per post. That means the current bot is stricter than necessary and leaves useful headroom unused. fileciteturn47file0L17-L18 fileciteturn47file0L39-L42 fileciteturn55file0L10-L11 citeturn12view1turn24view1

Test coverage is present but incomplete. The visible tests are unit tests for generator, state, validation, and image selection. There are no visible integration tests for the Bluesky adapter, no end-to-end tests for the scheduler and posting pipeline together, and coverage explicitly excludes `src/index.ts`, which is the orchestration path where most operational failures happen. fileciteturn50file0L51-L116 fileciteturn58file0L27-L147 fileciteturn59file0L16-L72 fileciteturn60file0L6-L127 fileciteturn61file0L5-L15

## Bluesky API, auth, limits, and posting rules

### Required endpoints and flows

For the requested product, the minimum Bluesky/AT Protocol surface is small and stable:

| Endpoint / flow | Why the refactor needs it | Notes |
|---|---|---|
| `com.atproto.server.createSession` | Start a session with identifier + password/app password. | Returns `accessJwt`, `refreshJwt`, handle, and DID. citeturn21view0 |
| `com.atproto.server.refreshSession` | Refresh the session without forcing repeated logins. | Must be called using the `refreshJwt`, not the `accessJwt`. citeturn23view3 |
| `com.atproto.repo.uploadBlob` | Upload each image before posting. | Post guidance shows upload first, then include the returned blob in `app.bsky.embed.images`. citeturn12view1 |
| `com.atproto.repo.createRecord` | Create the actual `app.bsky.feed.post` record. | Requires auth and is implemented by the user’s PDS. citeturn12view0turn24view2 |
| App password lifecycle | Create, list, and revoke app passwords operationally. | `createAppPassword`, `listAppPasswords`, and `revokeAppPassword` exist for management and rotation. citeturn23view0turn23view1turn23view2 |

Bluesky’s own API host guidance matters for implementation detail. Repository writes and account management happen against the user’s PDS; Bluesky’s `bsky.social` entryway exists to simplify this for Bluesky-hosted users, and the TypeScript SDK can start from `bsky.social` and reconfigure dynamically to the actual PDS. That is why keeping the official TypeScript client is a good fit for this repo. citeturn43view0turn43view1turn27view0

### Auth choice for this specific product

For a **single-account, headless posting worker**, the cleanest choice is a **non-privileged app password** stored server-side. Bluesky’s OAuth guide says OAuth is not currently recommended for headless clients such as command-line tools or bots, while the official SDK docs steer broader application session management towards OAuth. The practical interpretation is straightforward: use an app password for the always-on bot worker now; add OAuth only if you later evolve the dashboard into a multi-user product where each user connects their own Bluesky account. That is an inference, but it is the inference most consistent with the official materials. citeturn13view0turn27view0turn23view0

### Rate limits and posting constraints

Bluesky’s rate limits are generous for a single-account autoposter, but they still matter for design. Bluesky documents write limits of **5,000 points/hour** and **35,000 points/day** per account, with creates costing 3 points each; most authenticated API requests also pass through the PDS, where overall API requests are limited by IP to **3,000 per 5 minutes**, and `createSession` is measured per account at **30 per 5 minutes** and **300 per day**. Services commonly return rate-limit headers, and rate-limit breaches usually return HTTP 429. citeturn10view0

For posting itself, a basic post record requires `text` and `createdAt`, and image posting is a two-step flow: upload blob(s), then embed them in `app.bsky.embed.images`. Bluesky’s posting guide also stresses setting aspect ratios when known. The current image embed schema allows up to **four images** per post and **2 MB per image**, and the image object requires `alt` text, which means the dashboard should require alt text whenever operators attach an image. citeturn12view0turn12view1turn24view1

Rich-text handling should be done with facets, not ad hoc plain text substitutions. Bluesky’s rich-text guidance documents facets for links, mentions, and hashtags, and the current repo already uses `RichText.detectFacets()` from the official client, which should be preserved in the refactor. The dashboard should preview the exact emitted post and final grapheme count after tags and line breaks are applied. citeturn10view4turn12view3 fileciteturn45file0L48-L61

The current repo already enforces a 300-grapheme text limit locally, which is the correct user-facing limit to keep in the dashboard validation path. It should remain a hard validation rule at save time and again at send time. fileciteturn49file0L8-L16

### Content rules and moderation implications

Bluesky’s Community Guidelines explicitly prohibit spam, manipulation, scams, harassment, and attempts to abuse platform systems or rate limits. For an autoposter, the most relevant policy risks are repetitive spammy posting, deceptive or undisclosed commercial content, harmful content categories, and behaviour that looks like artificial signal manipulation. That means the dashboard needs approval states, cooldowns, deduplication, link/domain controls, and a clear operator review flow rather than “fire anything that exists in the database”. Bluesky also supports a moderation model that includes labels and user controls; where relevant, the poster should support self-labels/content warnings on saved messages. citeturn42view0turn11view7turn24view0

## Recommended architecture and implementation

### Target architecture

The simplest strong v1 is a **single Node.js service** that serves the dashboard and runs a background worker in the same process, backed by a real database. That is enough for one account and one operator, but still leaves room to scale.

```mermaid
flowchart LR
    A[Dashboard UI] --> B[Fastify app]
    B --> C[(Postgres)]
    B --> D[Message CRUD]
    B --> E[Settings API]

    F[Scheduler loop] --> C
    F --> G[Selection engine]
    G --> C

    H[Poster service] --> I[@atproto/api]
    G --> H
    H --> C

    J[Logs and metrics] --> B
    J --> F
    J --> H

    K[Secrets store] --> B
    K --> H
```

This architecture is justified by the repo’s current TS/Node base, Bluesky’s official TypeScript support, and the operational requirements of a dashboard plus continuous worker. fileciteturn43file0L3-L25 citeturn27view0turn37view2

### Core components

| Component | What it should do |
|---|---|
| Dashboard | Create/edit/pause/archive saved messages; attach images; set weights, tags, labels, cooldowns; view history and next scheduled run. |
| Scheduler | Persist `next_run_at`; wake every 15–30 seconds; acquire a DB lock; post only when due. |
| Selection engine | Choose an eligible message using weighted random choice plus cooldown and dedupe rules. |
| Poster | Build rich text, upload blobs, create post record, persist history, back off on 429/5xx. |
| Storage | Real database tables for messages, assets, settings, post history, scheduler state, and locks. |
| Logging / monitoring | Structured JSON logs, counters, health routes, alerts for repeated failures or prolonged silence. |
| Secrets | Keep Bluesky app password and dashboard secrets in environment/secret management, never in client-side JS. |

### Message management design

The dashboard is the centrepiece of this refactor. A good v1 data model is:

| Table | Minimum fields |
|---|---|
| `messages` | `id`, `body`, `status`, `weight`, `cooldown_hours`, `image_asset_id`, `self_labels`, `tags`, `last_posted_at`, `post_count`, `normalised_hash`, `created_at`, `updated_at` |
| `assets` | `id`, `path_or_object_key`, `mime_type`, `width`, `height`, `bytes`, `alt_text_default`, `created_at` |
| `post_runs` | `id`, `message_id`, `attempted_at`, `status`, `bsky_uri`, `bsky_cid`, `http_status`, `error`, `retry_count` |
| `scheduler_state` | `singleton_key`, `enabled`, `timezone`, `min_interval_minutes`, `max_interval_minutes`, `quiet_hours_json`, `next_run_at`, `last_success_at`, `last_error_at` |
| `locks` or DB advisory lock | Used to prevent double posting when more than one instance exists |

The selection algorithm should not simply pick a uniform random row. A stronger rule is:

1. Filter to `status='approved' AND enabled=true`.
2. Exclude anything still in cooldown.
3. Exclude exact text-hash duplicates within a configurable no-repeat window.
4. Optionally exclude messages too similar to recent posts using fuzzy similarity.
5. Sample from the remaining set using weighted random choice.

A practical scoring function is:

```text
effective_weight = base_weight × freshness_bonus × image_bonus × operator_priority
```

where `freshness_bonus` penalises recently used messages. This produces variety without making the system feel chaotic.

For deduplication, keep the current normalisation idea from `validate.ts` — lowercase, collapse whitespace, strip tracking parameters — but apply it to **saved messages on insert/update** as well as to outbound posts. Then add a near-duplicate check so “same sentence, tiny punctuation change” does not cycle endlessly. The policy reason for this is straightforward: repetitive posting and manipulative posting patterns are explicitly risky under Bluesky’s guidelines. fileciteturn49file0L19-L43 citeturn42view0

### Recommended module split

Refactor the repo into something like:

```text
src/
  server.ts
  app.ts
  config.ts
  db/
    migrations/
    client.ts
  routes/
    dashboard.ts
    api.ts
    health.ts
  services/
    scheduler.ts
    selector.ts
    poster.ts
    bluesky.ts
    moderation.ts
  repositories/
    messages.ts
    assets.ts
    runs.ts
    settings.ts
  views/
    messages/
    settings/
    runs/
```

Keep `src/bluesky.ts` conceptually, but rewrite it around a persistent worker contract rather than the current one-shot CLI flow. Keep `validate.ts` but move message validation into both the dashboard save path and the send path. Remove `generator.ts` from the core runtime path; if retained at all, make it an operator-only “draft suggestion” tool. fileciteturn45file0L24-L78 fileciteturn49file0L8-L50 fileciteturn46file0L43-L79

### Core pseudocode

#### Auth module

```ts
// src/services/bluesky.ts
import { BskyAgent, RichText } from "@atproto/api";

export async function getAgent(cfg: {
  identifier: string;
  appPassword: string;
  serviceUrl?: string;
}) {
  const agent = new BskyAgent({
    service: cfg.serviceUrl ?? "https://bsky.social",
  });

  await agent.login({
    identifier: cfg.identifier,
    password: cfg.appPassword,
  });

  return agent;
}
```

This is the right v1 shape because the worker is headless and single-account. If you later support multiple customer accounts from the dashboard, split this into `getAgentFromAppPassword()` and `getAgentFromOAuthSession()`. That recommendation is consistent with Bluesky’s headless-bot guidance and the SDK direction of travel. citeturn13view0turn27view0

#### Post module

```ts
// src/services/poster.ts
export async function publishMessage(agent, message, assetStore) {
  const rt = new RichText({ text: message.body });
  await rt.detectFacets(agent);

  assertGraphemeLimit(rt.text, 300);          // hard fail
  assertImageCount(message.images.length, 4); // hard fail

  const uploaded = [];
  for (const img of message.images) {
    const bin = await assetStore.read(img.key);
    const blob = await agent.com.atproto.repo.uploadBlob(bin, {
      encoding: img.mimeType,
    });
    uploaded.push({
      image: blob.data.blob,
      alt: img.altText,
      aspectRatio: { width: img.width, height: img.height },
    });
  }

  const record = {
    $type: "app.bsky.feed.post",
    text: rt.text,
    facets: rt.facets,
    createdAt: new Date().toISOString(),
    tags: message.tags?.slice(0, 8),
    labels: message.selfLabels?.length ? { $type: "com.atproto.label.defs#selfLabels", values: message.selfLabels } : undefined,
    embed: uploaded.length
      ? { $type: "app.bsky.embed.images", images: uploaded }
      : undefined,
  };

  return agent.com.atproto.repo.createRecord({
    repo: agent.session.did,
    collection: "app.bsky.feed.post",
    record,
  });
}
```

#### Scheduler module

```ts
// src/services/scheduler.ts
export async function schedulerLoop(deps) {
  while (true) {
    await deps.sleep(15000);

    const gotLock = await deps.locks.tryAcquire("poster", 30000);
    if (!gotLock) continue;

    try {
      const settings = await deps.settings.get();
      if (!settings.enabled) continue;
      if (new Date() < settings.nextRunAt) continue;

      const candidate = await deps.selector.pickEligibleMessage();
      if (!candidate) {
        await deps.settings.deferNextRun(minutesFromNow(15));
        continue;
      }

      try {
        const result = await deps.poster.publish(candidate);
        await deps.runs.recordSuccess(candidate.id, result);
        await deps.messages.markPosted(candidate.id);
      } catch (err) {
        const retryAt = computeBackoff(err);
        await deps.runs.recordFailure(candidate.id, err, retryAt);
      }

      const nextRunAt = randomBetween(
        settings.minIntervalMinutes,
        settings.maxIntervalMinutes,
      );
      await deps.settings.setNextRun(nextRunAt);
    } finally {
      await deps.locks.release("poster");
    }
  }
}
```

This gives you **true persisted random intervals**, not “fixed cron plus jitter”.

### Prioritised refactor plan

| Priority | Task | Outcome | Est. effort |
|---|---|---|---:|
| P0 | Fix `BOT_ENABLED` mismatch or remove the flag in the current workflow while refactor is underway | Existing automation stops silently failing | 0.5 h |
| P0 | Remove GitHub Actions as the posting scheduler; keep GitHub Actions for CI only | Prevent dual schedulers and git-committed state | 1 h |
| P0 | Introduce durable DB schema for messages, runs, settings, and locks | Creates the foundation for the dashboard and worker | 4 h |
| P0 | Build admin dashboard CRUD for saved messages and settings | Enables the user’s requested operator workflow | 8 h |
| P0 | Implement persistent scheduler with `next_run_at` and DB lock | Delivers true randomised 24/7 behaviour | 6 h |
| P1 | Refactor poster service to post saved messages instead of Nova output | Aligns product with requested behaviour | 5 h |
| P1 | Add exact and near-duplicate protection, cooldowns, and approval states | Reduces spam/policy risk | 4 h |
| P1 | Add structured logging, health endpoints, and failure counters | Makes the service operable | 4 h |
| P1 | Add retry/backoff and 429-aware handling | Improves resilience under transient failure | 3 h |
| P2 | Add image upload management in the dashboard with alt text validation | Completes media workflow | 5 h |
| P2 | Add integration tests and e2e dry-run staging flow | Reduces regression risk | 8 h |
| P2 | Add Replit, Docker, and local dev configs | Makes the project portable | 4 h |
| P3 | Make Nova an optional “draft suggestion” feature only | Preserves existing value without driving automation | 4 h |

**Estimated total:** about **56–57.5 hours** for a solid v1.

## Deployment, security, testing, observability, and maintenance

### Deployment options

| Option | Suitability | Recommendation |
|---|---|---|
| Replit Reserved VM | Best Replit fit for a dashboard + continuous worker; intended for always-on servers and bots. citeturn37view2 | **Recommended on Replit** |
| Replit Scheduled Deployment | Good for periodic one-off jobs, but Replit says it is **not designed for continuous or long-running tasks such as web applications**. citeturn37view4 | Not suitable for the full dashboard product |
| Local VS Code / PC | Best for development and debugging | Use for day-to-day dev |
| Docker on VPS / VM | Best for portable self-hosting and predictable ops | Recommended outside Replit |
| GitHub Actions | Useful for CI, lint, test, build; poor fit for a stateful dashboard scheduler | Keep for **CI only** |

If you deploy on Replit, use **Secrets** for credentials and a real database for state. Replit’s Secrets store encrypts secrets and exposes them as environment variables; publishing documentation also warns against relying on published app filesystem data. citeturn32view0turn33view2

### Replit deployment instructions and sample config files

**Recommended Replit path**

1. Import the GitHub repo into Replit; Replit’s import flow supports GitHub repositories and expects secrets to be added separately. citeturn34view1  
2. Add secrets in Replit Secrets: `BSKY_IDENTIFIER`, `BSKY_APP_PASSWORD`, `DATABASE_URL`, `DASHBOARD_ADMIN_USER`, `DASHBOARD_ADMIN_PASSWORD`, `SESSION_SECRET`, `LOG_LEVEL`. Replit Secrets are encrypted and available as environment variables. citeturn32view0  
3. Publish using **Reserved VM**, not Scheduled Deployment, because the product is an always-on dashboard plus worker. citeturn37view2turn37view4  
4. Point the deployment at a real database. Do **not** use a local file for production state on published Replit. citeturn33view2

**Sample `.replit`**

```toml
entrypoint = "src/server.ts"
run = "npm run dev"

[gitHubImport]
requiredFiles = [".replit", "replit.nix", "package.json"]

[deployment]
build = "npm ci && npm run build"
run = "npm run start"
ignorePorts = false

[[ports]]
localPort = 3000
externalPort = 80
```

This matches Replit’s documented `.replit` concepts for `run`, deployment `build`, deployment `run`, and port mapping. citeturn45view0turn45view2

**Sample `replit.nix`**

```nix
{ pkgs }: {
  deps = [
    pkgs.nodejs-20_x
    pkgs.nodePackages.npm
    pkgs.openssl
  ];
}
```

**Sample `Dockerfile`**

```Dockerfile
FROM node:20-bookworm-slim
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

CMD ["npm", "run", "start"]
```

**Sample `docker-compose.yml`**

```yaml
services:
  app:
    build: .
    ports:
      - "3000:3000"
    env_file:
      - .env
    depends_on:
      - db

  db:
    image: postgres:16
    environment:
      POSTGRES_DB: bluesky_poster
      POSTGRES_USER: poster
      POSTGRES_PASSWORD: poster
    ports:
      - "5432:5432"
    volumes:
      - pgdata:/var/lib/postgresql/data

volumes:
  pgdata:
```

### Security and compliance

A secure v1 should follow these rules:

| Risk area | Recommendation |
|---|---|
| Bluesky credentials | Use a **server-side app password**, not browser-side auth; prefer a **non-privileged** app password because this tool only needs posting, not sensitive account-state access. Rotate periodically using the official app-password management endpoints. citeturn23view0turn23view1turn23view2 |
| Dashboard access | Make the dashboard private. For v1, basic auth or a simple session-based admin login is acceptable; do not expose posting credentials to client-side JS. |
| Secrets storage | Store secrets in Replit Secrets, local `.env` for dev only, or container/runtime secret management. Replit’s Secrets are encrypted and exposed as env vars. citeturn32view0 |
| Policy compliance | Validate message content before approval and again before send to reduce risks around spam, manipulation, scams, harassment, and dangerous content. Bluesky guidelines explicitly prohibit these categories. citeturn42view0 |
| Rate-limit handling | On 429 or rate-limit headers, back off and reschedule rather than retrying aggressively. Bluesky documents 429 and evolving limits. citeturn10view0 |
| Auditability | Persist `who changed what` in the dashboard: editor identity, timestamp, version history, send history, and any moderation/approval decisions. |

### Testing strategy

The current repo’s tests are useful but too narrow. The refactor should add three layers:

| Test layer | What to test |
|---|---|
| Unit | Text validation, tag/image limits, weighted random selection, cooldown logic, backoff calculation, schedule generation |
| Integration | DB repositories, dashboard routes, scheduler lock logic, poster service with mocked Bluesky client |
| End-to-end | Full dry-run from saved message → scheduler → post payload → success/failure history update |

Concrete acceptance tests for the refactor:

1. Saving a message over the limit should fail with a clear validation error.  
2. Two near-identical saved messages should trigger a duplicate/near-duplicate warning.  
3. A message in cooldown must never be selected.  
4. Two worker processes started at once must not double-post the same message.  
5. `DRY_RUN=true` should record a simulated success without calling Bluesky.  
6. 429 responses should trigger backoff and a later retry.  
7. A 24-hour test run with a 1–2 minute interval range should produce no duplicate posts and no overlapping executions.

### Observability and maintenance

At minimum, add:

| Signal | Why it matters |
|---|---|
| Structured logs with `run_id`, `message_id`, `post_uri`, `status` | Makes failures diagnosable |
| Counters: `posts_attempted_total`, `posts_success_total`, `posts_failed_total`, `rate_limit_total` | Core operating metrics |
| Gauge: `next_run_timestamp`, `eligible_messages_count` | Confirms scheduler health |
| Health endpoints: `/healthz`, `/readyz` | Host/platform integration |
| Alerting | Alert if no successful post for X hours, N consecutive failures, or database unavailable |

Maintenance-wise, rate limits are documented as likely to evolve, so the bot should treat limits and payload validation as configuration-driven, not hard-coded assumptions. The official docs explicitly note that limits can change over time. citeturn10view0

### Risk assessment

| Risk | Impact | Mitigation |
|---|---|---|
| Credential leakage | Account compromise | Secrets only; never commit or render secrets client-side; rotate app passwords periodically. citeturn32view0turn23view2 |
| Repetitive or spammy output | Account restrictions or reduced trust | Approval states, cooldowns, dedupe, near-duplicate checks, manual pause switch. citeturn42view0 |
| Double posting from multiple instances | Duplicate posts | DB advisory lock / singleton scheduler ownership |
| Rate-limit burst after restart | 429s / degraded reliability | Persist `next_run_at`; disable catch-up bursts; backoff on 429. citeturn10view0 |
| Filesystem state loss on Replit publish | Lost schedule/history | Use production DB, not local file state. citeturn33view2 |
| Dashboard becomes publicly reachable | Abuse or tampering | Private deployment, admin auth, optional IP allowlist |
| Image validation mismatch | Failed posts | Validate count, bytes, MIME, alt text, aspect ratio before send. citeturn12view1turn24view1 |
| Bluesky API behavioural changes | Broken posting | Pin SDK, add contract tests, review official docs/limits quarterly. citeturn10view0turn43view0 |

## Handoff document for the AI agent

### Goal

Transform `Inferenco/bluesky-poster` from a one-shot Nova-driven CLI bot into a **private dashboard + persistent scheduler + poster worker** that posts **saved operator-authored Bluesky messages** at random intervals.

### Exact implementation sequence

#### Branch and install

```bash
git checkout -b feat/dashboard-randomised-poster

npm install fastify @fastify/formbody @fastify/static @fastify/basic-auth @fastify/view ejs pg zod pino nanoid
npm install -D supertest @types/supertest
```

#### Replace the runtime shape

1. **Keep** `src/bluesky.ts`, but rewrite it to expose:
   - `getAgent()`
   - `publishMessage()`
   - `validateOutboundPost()`

2. **Stop using** `src/generator.ts` in the main automation path.
   - Do not delete immediately.
   - Move it behind an optional feature flag such as `ENABLE_NOVA_DRAFTS=false`.

3. **Replace** `src/index.ts` with `src/server.ts` as the main entrypoint.

4. **Create** these files:

```text
src/server.ts
src/config.ts
src/db/client.ts
src/db/migrate.ts
src/routes/dashboard.ts
src/routes/health.ts
src/routes/api.ts
src/services/scheduler.ts
src/services/selector.ts
src/services/poster.ts
src/services/moderation.ts
src/repositories/messages.ts
src/repositories/settings.ts
src/repositories/runs.ts
src/views/layout.ejs
src/views/messages/index.ejs
src/views/messages/form.ejs
src/views/settings/index.ejs
src/views/runs/index.ejs
db/001_init.sql
```

#### Database schema to create

```sql
create table if not exists messages (
  id text primary key,
  body text not null,
  status text not null default 'draft',
  weight integer not null default 100,
  cooldown_hours integer not null default 168,
  tags jsonb not null default '[]',
  self_labels jsonb not null default '[]',
  image_path text,
  image_alt text,
  normalised_hash text not null,
  last_posted_at timestamptz,
  post_count integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists post_runs (
  id text primary key,
  message_id text not null references messages(id) on delete cascade,
  attempted_at timestamptz not null default now(),
  status text not null,
  bsky_uri text,
  bsky_cid text,
  error text,
  retry_count integer not null default 0
);

create table if not exists scheduler_state (
  singleton_key text primary key,
  enabled boolean not null default true,
  timezone text not null default 'UTC',
  min_interval_minutes integer not null default 60,
  max_interval_minutes integer not null default 180,
  quiet_hours_json jsonb not null default '[]',
  next_run_at timestamptz,
  last_success_at timestamptz,
  last_error_at timestamptz
);
```

#### `package.json` edits

Add or replace scripts with:

```json
{
  "scripts": {
    "dev": "tsx watch src/server.ts",
    "build": "tsc -p tsconfig.json",
    "start": "node dist/server.js",
    "db:migrate": "tsx src/db/migrate.ts",
    "lint": "tsc --noEmit",
    "test": "vitest run",
    "test:e2e": "vitest run --dir test/e2e"
  }
}
```

#### Dashboard features to implement first

1. `/messages` list page  
2. `/messages/new` create form  
3. `/messages/:id/edit` edit form  
4. Pause/archive/delete actions  
5. `/settings` page for interval range, enable switch, optional quiet hours  
6. `/runs` page showing send history and failures  
7. `/healthz` and `/readyz`

#### Selection rules to implement exactly

- Only `approved` messages are eligible.
- Exclude anything posted within `cooldown_hours`.
- Exclude exact `normalised_hash` duplicates from the last `N` sent messages.
- Weighted random selection over the remaining messages.
- If no message is eligible, move `next_run_at` forward by 15 minutes and log the reason.

#### Posting rules to implement exactly

- Count graphemes before send; hard fail above 300.
- Detect facets with `RichText`.
- If image exists:
  - verify bytes ≤ Bluesky limit,
  - verify MIME starts with `image/`,
  - require non-empty alt text,
  - upload blob first,
  - then create record with `app.bsky.embed.images`.
- Record every attempt in `post_runs`.

#### Commands the AI agent should run

```bash
cp .env.example .env
# fill secrets manually

npm install
npm run db:migrate
npm run lint
npm run test
npm run build
npm run dev
```

#### Manual verification commands

```bash
curl -u "$DASHBOARD_ADMIN_USER:$DASHBOARD_ADMIN_PASSWORD" http://localhost:3000/healthz
curl -u "$DASHBOARD_ADMIN_USER:$DASHBOARD_ADMIN_PASSWORD" http://localhost:3000/messages
```

#### Tests the AI agent must add

- `selector.test.ts`
  - eligible filtering
  - cooldown
  - weighted random selection
- `scheduler.test.ts`
  - no post before `next_run_at`
  - reschedule after success
  - backoff after failure
- `poster.test.ts`
  - text over limit rejected
  - image without alt rejected
  - dry-run does not call Bluesky
- `dashboard.routes.test.ts`
  - create/edit/pause message
  - settings update
- e2e dry-run staging test
  - create 3 approved messages
  - set interval to 1–2 minutes
  - assert one message was selected and recorded

#### GitHub Actions changes

- **Delete or disable** `.github/workflows/autopost.yml` as the production scheduler.
- **Add** `.github/workflows/ci.yml`:

```yaml
name: ci
on:
  push:
  pull_request:

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
      - run: npm ci
      - run: npm run lint
      - run: npm run test
      - run: npm run build
```

### Definition of done

The refactor is done when all of the following are true:

- A private dashboard exists and can save/edit/approve messages.
- The bot posts saved messages without using Nova.
- The scheduler persists `next_run_at` and survives restarts.
- No state is committed back into git after posting.
- Replit Reserved VM or Docker deployment works with a real database.
- `npm run lint`, `npm run test`, and `npm run build` all pass.
- A dry-run staging test proves randomised scheduling, history recording, and dedupe/cooldown behaviour.

## Open questions and limitations

A few choices remain product-level rather than purely technical:

- Whether Nova should be removed entirely or kept as an optional draft-assistance feature.
- Whether the dashboard is strictly single-admin/private, or whether it may later support multiple users and therefore needs OAuth.
- Whether message reuse after a long cooldown is desirable, or whether every saved message should be effectively one-time use.
- Whether image upload/editing is required in v1, or whether v1 can ship text-only with images added in the next iteration.

The highest-confidence recommendation is still clear despite those open questions: **refactor this repo into a TypeScript dashboard application with an always-on scheduler and durable database, use the official Bluesky client, post from saved operator-authored messages, and host it on Replit Reserved VM or Docker — not GitHub Actions cron — for true 24/7 randomised posting.**