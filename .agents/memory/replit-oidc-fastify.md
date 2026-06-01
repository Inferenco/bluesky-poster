---
name: Replit OIDC in Fastify
description: How to wire Replit Auth (OIDC blueprint) into a Fastify+SSR app instead of the Express+React blueprint defaults
---

## The rule
The `javascript_log_in_with_replit` blueprint targets Express + React. For a Fastify + SSR app, implement OIDC manually using `openid-client` (installed by the blueprint) and `@fastify/session` + `@fastify/cookie`.

**Why:** The blueprint installs Express-style `passport` + `express-session` wiring. Fastify has its own plugin system; mixing the two causes session and middleware-order issues.

## How to apply
1. Create `src/replit_integrations/replitAuth.ts` with:
   - `getOidcConfig()` — memoized `oidcClient.discovery("https://replit.com/oidc", REPL_ID)`
   - `buildLoginUrl()` — PKCE auth URL via `oidcClient.buildAuthorizationUrl()`
   - `exchangeCode()` — `oidcClient.authorizationCodeGrant()` (pass `redirect_uri` as `new URLSearchParams(...)` 4th arg, NOT in the checks object — that's a TS error)
   - `buildLogoutUrl()` — `oidcClient.buildEndSessionUrl()`
   - Session type augmentation: `declare module '@fastify/session' { interface FastifySessionObject { ... } }`
2. In `buildApp()`: register `@fastify/cookie` then `@fastify/session` before routes.
3. Add `/api/login`, `/api/callback`, `/api/logout` routes in `buildApp()`.
4. In `requireAuth`: check `request.session.user` first, fall back to `x-replit-user-id` header (works in dev preview).

## Key env vars (auto-provided by Replit)
- `REPL_ID` — OIDC client ID
- `SESSION_SECRET` — session signing key
- `ISSUER_URL` — defaults to `https://replit.com/oidc`

## Allowlist
`DASHBOARD_ALLOWED_REPLIT_USERS` (comma-separated, lowercased) matched against `preferred_username`, `username`, `sub`, or `email` from OIDC claims. Enforced in `/api/callback` before the session is written.

## Claim inspection
The callback logs all OIDC claims: `console.log('[auth] OIDC login claims:', JSON.stringify(claims))`. Check logs on first login to see which claim holds the Replit username (likely `preferred_username`).
