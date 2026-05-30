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
The sign-in button must use an onclick JS handler, NOT `target="_top"` on an anchor.

```html
<button class="btn" onclick="(window.top||window).location.href='${loginUrl}'">Sign in with Replit</button>
```

**Why (failure modes for alternatives):**
1. `window.location.replace(loginUrl)` — navigates the iframe to replit.com, which
   has `X-Frame-Options: DENY`, showing "refused to connect."
2. `window.top.location.replace(loginUrl)` — throws a cross-origin `SecurityError`
   because the workspace top frame is a different origin.
3. `target="_top"` on an `<a>` — silently blocked by the canvas iframe sandbox
   (the canvas iframe does not grant `allow-top-navigation`).
4. `(window.top||window).location.href = url` in an onclick — works because it is
   a user-gesture-initiated navigation, which bypasses the sandbox restriction.

This pattern has needed re-applying multiple times. Always check all three rules
when touching `makeRequireAuth` or `renderLoginPage`.
