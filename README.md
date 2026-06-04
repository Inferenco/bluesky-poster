# Bluesky Poster Dashboard

Private dashboard and worker for posting saved operator-authored messages to Bluesky and optionally Mastodon at randomized intervals.

The app is now shaped as a Node.js/TypeScript web service:

- Fastify dashboard for creating, editing, approving, pausing, archiving, and deleting saved messages.
- Per-message platform selection for Bluesky, Mastodon, or both.
- Persistent scheduler that stores `next_run_at` in Postgres.
- Saved-message poster path that records every attempt in `post_runs`.
- Postgres-backed state and optional Postgres-backed image uploads, suitable for Replit Postgres, local Docker Postgres, or any hosted Postgres exposed through `DATABASE_URL`.
- GitHub Actions CI only. Production posting no longer runs from GitHub cron and no state is committed back to git.

## Local Development

Install dependencies:

```bash
npm install
```

Create `.env` from the example and point `DATABASE_URL` at Postgres:

```bash
cp .env.example .env
```

For local Postgres with Docker:

```bash
docker compose up -d db
npm run db:migrate
npm run dev
```

Open the dashboard at `http://localhost:3000/messages` and sign in with `DASHBOARD_ADMIN_USER` / `DASHBOARD_ADMIN_PASSWORD`.

Use `/assets` to register reusable images. For Replit-friendly durability, upload images through the dashboard so the image bytes and default alt text are stored in Postgres. Repo-path assets are also supported for bundled images such as files under `assets/images/originals/`.

## Required Environment

| Variable | Required | Description |
| --- | --- | --- |
| `DATABASE_URL` | yes | Postgres connection string. Use Replit Postgres' `DATABASE_URL` after import. |
| `DASHBOARD_ADMIN_USER` | yes | Basic-auth username for the private dashboard. |
| `DASHBOARD_ADMIN_PASSWORD` | yes | Basic-auth password for the private dashboard. |
| `BSKY_IDENTIFIER` | for live posting | Bluesky handle or identifier. |
| `BSKY_APP_PASSWORD` | for live posting | Bluesky app password for the worker. |
| `MASTODON_INSTANCE_URL` | no | Mastodon instance base URL. Defaults to `https://mastodon.social`. |
| `MASTODON_ACCESS_TOKEN` | for Mastodon posting | Mastodon access token with `write:statuses` scope. |
| `MASTODON_VISIBILITY` | no | Mastodon status visibility. Defaults to `public`. |
| `DRY_RUN` | no | Set `true` to record dry-run posts without calling external posting APIs. |
| `PORT` | no | Defaults to `3000`. |

## Commands

```bash
npm run dev         # start Fastify dashboard + worker loop
npm run db:migrate  # apply Postgres schema
npm run bluesky:check # verify Bluesky credentials without creating a post
npm run bluesky:live-test # create one real Bluesky test post, guarded by CONFIRM_LIVE_POST
npm run lint        # TypeScript check
npm run test        # run tests
npm run build       # compile to dist/
npm run start       # run compiled server
```

## Replit Deployment

Import the GitHub repo into Replit, attach Replit Postgres, and set Secrets for the variables above. The app expects Replit Postgres to provide `DATABASE_URL`; it does not rely on the published filesystem for dashboard or scheduler state.

For production images on Replit, prefer dashboard uploads so image bytes are stored in Postgres/App Storage. Repo-path assets are best for images committed to the repository. Mastodon v1 does not upload media; if an attached asset has a public App Storage URL, that URL is appended to the Mastodon post text.

Use a Reserved VM deployment for the dashboard plus continuous worker. Scheduled Deployments are not the target shape for this app.

The included `.replit` runs:

```bash
npm ci && npm run build
npm run db:migrate && npm run start
```

## Notes

Nova generation remains in the repository as legacy draft-assistance code, but it is not the primary automation path. The worker posts saved dashboard messages.

`npm run bluesky:check` only creates a Bluesky session and prints the authenticated handle/DID. It does not upload blobs or create posts.

`npm run bluesky:live-test` creates a real Bluesky post and refuses to run unless `CONFIRM_LIVE_POST=I_UNDERSTAND_THIS_WILL_POST_TO_BLUESKY` is set. You can override the default timestamped body with `LIVE_TEST_TEXT`.
