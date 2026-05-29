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

## Rule 2 — renderLoginPage
`renderLoginPage` must NOT use `window.location.replace(loginUrl)` (inline script).
The sign-in button must use `target="_top"` on the anchor tag.

```html
<a class="btn" href="${loginUrl}" target="_top">Sign in with Replit</a>
```

**Why (two failure modes):**
1. `window.location.replace(loginUrl)` navigates the iframe itself to replit.com,
   which sets `X-Frame-Options: DENY` and shows "refused to connect."
2. `window.top.location.replace(loginUrl)` throws a cross-origin `SecurityError`
   because the Replit workspace top frame is a different origin.
3. `target="_top"` is pure HTML, avoids JS cross-origin restrictions, and correctly
   navigates the entire browser tab to the auth URL.

This pattern has needed re-applying multiple times. Always check both rules when
touching `makeRequireAuth` or `renderLoginPage`.
