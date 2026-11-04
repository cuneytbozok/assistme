# T-013 evidence: no credential prompts, logged-out status

Date: 2026-11-04. Instance: `dev469966.service-now.com` (PDI). All browser runs used throwaway
Chrome profiles (deleted with the scratchpad), never the user's profile. Unauthenticated requests
only; no credentials were sent or stored.

## 1. Which 401 challenge does ServiceNow send?

`curl` GET `/api/now/table/sys_db_object?sysparm_limit=1&sysparm_fields=sys_id`, no cookies:

| Request headers                       | Status | `WWW-Authenticate`          | Runs |
| ------------------------------------- | ------ | --------------------------- | ---- |
| `Accept: application/json`            | 401    | `Basic realm="Service-now"` | 3/3  |
| + `X-Requested-With: XMLHttpRequest`  | 401    | `Basic realm="Service-now"` | 3/3 (one earlier run: a single `400` HTML, not repeatable) |
| + `X-UserToken: <any value>`          | 401    | `none`                      | 3/3  |

`Basic` is what makes Chrome show its sign-in dialog (T-005, H7 caveat). With `X-UserToken`
present, ServiceNow sends `none`, so there is no challenge for Chrome to prompt about.
The executor sends **every** request with `X-UserToken`, and sends nothing when no token can be
read (`NO_INSTANCE_TAB`). A unit test enforces this invariant (`test/session.test.ts`).

## 2. Service-worker fetches in headed Chrome (throwaway profile)

`auth-challenge-experiment.mjs` (headless and headed variants): SW `fetch(credentials:'include')`
to the logged-out PDI, with and without a guest session (login.do opened first), with and
without a stale `X-UserToken`. In every combination the request returned `401` within
0.3–1.7 s. No dialog appeared and nothing hung. A `declarativeNetRequest` rule removing
`WWW-Authenticate` was also shown to work (header absent), but it isn't needed, so no manifest
change was made.

## 3. Real extension code against the logged-out PDI

`live-logged-out-check.mjs`: test-only manifest copy (adds a host permission instead of the
popup grant), registry seeded with `dev`, `login.do` open (guest session; `g_ck` present).
The popup's `popup.checkStatus` → `{"dev": "session_expired"}`. The popup showed "Session
expired. Sign in again in your ServiceNow tab". No sign-in dialog, no console errors.

## Not covered here

The same check in the user's own profile (real extension, real grant, real logout) is part of
T-015.
