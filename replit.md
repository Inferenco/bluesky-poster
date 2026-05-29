# Bluesky Autoposter Dashboard

A private dashboard and background worker for scheduling and posting saved messages to Bluesky at randomized intervals.

## Stack

- **Runtime**: Node.js + TypeScript
- **Web framework**: Fastify
- **Database**: Postgres (Replit-managed, via `DATABASE_URL`)
- **Bluesky client**: `@atproto/api`

## Running the App

The app starts automatically via the **Start application** workflow (`npm run dev`), which runs both the Fastify dashboard and the scheduler loop on port 5000.

## Dashboard

Open the preview and sign in with the credentials stored in `DASHBOARD_ADMIN_USER` / `DASHBOARD_ADMIN_PASSWORD`.

- `/messages` — create, edit, approve, pause, archive, and delete messages
- `/assets` — register reusable images (stored in Postgres)
- `/runs` — view post history

## Environment Variables

| Variable | Required | Description |
| --- | --- | --- |
| `DATABASE_URL` | yes | Postgres connection string (provided by Replit) |
| `DASHBOARD_ADMIN_USER` | yes | Basic-auth username |
| `DASHBOARD_ADMIN_PASSWORD` | yes | Basic-auth password |
| `BSKY_IDENTIFIER` | for live posting | Bluesky handle |
| `BSKY_APP_PASSWORD` | for live posting | Bluesky app password |
| `DRY_RUN` | no | `true` = log posts without calling Bluesky (default in dev) |
| `PORT` | no | Defaults to 5000 |

## Useful Commands

```bash
npm run dev          # start dashboard + worker (development)
npm run db:migrate   # apply Postgres schema
npm run bluesky:check  # verify Bluesky credentials
npm run test         # run tests
npm run build        # compile TypeScript to dist/
```

## User Preferences

- `DRY_RUN=true` is set by default so no real posts are made until Bluesky credentials are configured.
