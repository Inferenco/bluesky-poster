---
name: Replit preview auth fix
description: How requireAuth must behave so the preview pane doesn't get stuck on a native Basic Auth dialog
---

# Replit preview pane auth — recurring fix

## The rule
In `makeRequireAuth` (src/app.ts), the 401 + `WWW-Authenticate: Basic` response
must ONLY be sent when the incoming request includes an `Authorization: Basic`
header (i.e. a client explicitly tried to authenticate and failed).

Browser requests with no Authorization header must always fall through to the
Replit login page redirect (`renderLoginPage`), even when
`DASHBOARD_ADMIN_USER` / `DASHBOARD_ADMIN_PASSWORD` are configured.

## Why
The Replit preview pane is an iframe. When the server returns
`WWW-Authenticate: Basic`, the browser shows its native credential dialog —
which never appears inside an iframe, leaving users stuck on a blank page.
Replit auth (`x-replit-user-id` header) is the correct mechanism for browser
access; Basic Auth is only for programmatic clients (e.g. automated tests).

## How to apply
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

This has needed re-applying multiple times. Always check this pattern when
touching `makeRequireAuth`.
