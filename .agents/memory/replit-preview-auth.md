---
name: Replit preview auth fix
description: How requireAuth and renderLoginPage must behave so the preview pane works correctly inside Replit's iframe
---

# Replit preview pane auth — recurring fix

## Rule 1 — makeRequireAuth
In `makeRequireAuth` (src/app.ts), the 401 + `WWW-Authenticate: Basic` response
must ONLY be sent when the incoming request includes an `Authorization: Basic`
header (i.e. a client explicitly tried to authenticate and failed).

Browser requests with no Authorization header must always fall through to the
Replit login page (`renderLoginPage`), even when
`DASHBOARD_ADMIN_USER` / `DASHBOARD_ADMIN_PASSWORD` are configured.

```ts
if (credentialsConfigured) {
  const authHeader = request.headers['authorization'] ?? '';
  if (authHeader.startsWith('Basic ')) {
    // validate — if wrong, send 401
    // if right, return (authenticated)
  }
  // No Authorization header → fall through to Replit login page below
}
// Replit login redirect (renderLoginPage)
```

**Why:** The preview pane is an iframe. `WWW-Authenticate: Basic` triggers the
browser's native credential dialog, which never appears inside an iframe.

## Rule 2 — renderLoginPage host detection
Use `x-forwarded-host` (falling back to `host`) when building the `loginUrl`:

```ts
const host = (request.headers['x-forwarded-host'] as string | undefined) ?? request.headers['host'] ?? '';
const loginUrl = `https://replit.com/auth_with_repl_site?domain=${host}`;
```

**Why:** Behind the Replit proxy the public domain arrives in `x-forwarded-host`;
`host` may be the raw internal address (localhost:PORT).

## Rule 3 — renderLoginPage sign-in button
The sign-in button must use a try/catch onclick handler:

```html
<button class="btn" onclick="try{window.top.location.href='${loginUrl}'}catch(e){window.open('${loginUrl}')}">Sign in with Replit</button>
```

**Why (failure modes for alternatives):**
1. `window.location.href = loginUrl` — navigates the iframe to replit.com, which has
   `X-Frame-Options: DENY`; the iframe shows "refused to connect."
2. `window.top.location.href = loginUrl` (unconditional) — throws `SecurityError`
   when the canvas/preview iframe is cross-origin from the Replit editor top frame.
3. `(window.top||window).location.href` — also throws; `||window` fallback never
   reached because the assignment itself is what throws.
4. `target="_top"` on an `<a>` — silently blocked by the canvas iframe sandbox
   (the sandbox does not grant `allow-top-navigation`).

**Correct pattern:**
- `window.top.location.href` in a try block → works when accessed directly (top frame
  or same-origin iframe, e.g. deployed app).
- Catch `SecurityError`, fall back to `window.open(loginUrl)` → opens auth in a new
  tab when running inside the cross-origin Replit editor canvas.

This pattern has needed re-applying multiple times. Always check all three rules
when touching `makeRequireAuth` or `renderLoginPage`.
