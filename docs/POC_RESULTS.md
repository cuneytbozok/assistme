# Live session PoC results (T-005)

- **Date:** 2026-11-04, 16:32–16:39 UTC
- **Instance:** `dev469966.service-now.com` (personal developer instance, alias `dev`, env DEV), local login as `admin`.
- **Chrome:** 156.0.8078.80 (macOS), extension `clipfeocpiljpcngmjpdbegciimchbol` loaded unpacked.
- **Instance build:** not determined.
  - `glide.buildtag` is not a `sys_properties` row (0 rows).
  - The newest `sys_upgrade_history` entry is an app upgrade (`sn_creatorstudio`), not the platform build.
  - The UI is Next Experience (Polaris) with classic pages in an iframe.
- **Method:**
  - A dev-only diagnostics page plus a service-worker handler, built with `npm run build:diag` (commit `08aa721`; the code was removed after this task).
  - The user ran it in their own Chrome: run 1 logged in; run 2 after logging out and in again; run 3 logged out.
  - Only `GET` requests to `/api/now/table/*` and `/api/now/stats/*`. No tab was navigated.
- **What was recorded:** token values were never recorded, only presence, length (72) and an 8-hex SHA-256 fingerprint. No cookie values were accessed (the extension has no `cookies` permission).

## Hypotheses

**Request labels used below:**
- **SW:** the request is sent by the extension's service worker.
- **cookies:** the request is sent with `credentials: 'include'`, so the browser attaches the user's ServiceNow cookies.
- **token:** the request carries the `X-UserToken` header, set to the page's `g_ck` value.

| ID  | Hypothesis | Result | Evidence |
| --- | --- | --- | --- |
| H1 | Service-worker `fetch(credentials:'include')` sends the session cookies | **Confirmed** | SW, cookies + token → `200` JSON (`X-Total-Count: 6775`). The same request with `credentials:'omit'` → `401`. Only the cookies differ, so they are sent. |
| H2 | Cookies without `X-UserToken` → 401 | **Confirmed** | SW, cookies, no token → `401` `application/json` "User is not authenticated" (every logged-in run). |
| H3 | `g_ck` is readable via MAIN-world `executeScript` | **Confirmed** | Next Experience top frame (`/now/nav/ui/classic/...`) and its classic iframe (`/ui_page.do`): `g_ck` present, length 72, same fingerprint in both frames. Also present on `/navpage.do`. `NOW.ck` and `NOW.g_ck` don't exist. |
| H4 | The token lasts the session, changes after re-login, and an invalid token → 401 | **Confirmed** | Invalid token → `401`. The fingerprint stayed `31248090` across runs 2 min apart (same session) and changed to `481d9340` after re-login (`last_login_time` 16:36:23 → 16:38:42). The new token works at once (`200`). Validity over hours is not measured. |
| H5 | Fallback: MAIN-world `fetch` inside a tab of the host | **Confirmed (not chosen)** | In-tab fetch with the page token → `200`; without it → `401`. It runs inside the user's page, which can trigger page-level UI (see H7), so it is kept only as a documented fallback. |
| H6 | SSO/MFA sessions behave like local login | **Untested** | The PDI uses local login and no SSO instance is available. Re-check when an SSO instance is first used (T-015/T-034). |
| H7 | Session end shows up as 401 or a redirect/HTML login page | **Confirmed: 401 JSON**, with a caveat | Logged out → every request returns `401` `application/json` "User is not authenticated". No redirect and no HTML. **Caveat:** while logged out, credentialed requests made **Chrome show its native HTTP-auth "Sign in" dialog** for the host, and the request waited until the user pressed Cancel. Likely cause: a `WWW-Authenticate: Basic` challenge on the 401 when only a guest session exists. Logged-in 401s (missing token) showed no dialog. Must be handled in T-013 (see below). |
| H8 | Reads cause no visible side effects | **Confirmed** | Five extra reads per run: `admin.last_login_time` unchanged, `sys_user_session` row count unchanged (696/696, 707/707, 716/716, 720/720). |

Logout invalidates the session immediately. Idle timeout was not waited for, and is assumed to behave the same (401 JSON).

## Decision (ADR-002 → Accepted): Path A

H1 ∧ H2 ∧ H3 holds, so the service worker owns all ServiceNow requests:

- **Request form:** `fetch(https://<granted host>/api/now/…, {method:'GET', credentials:'include', redirect:'manual', headers:{Accept:'application/json', 'X-UserToken': <g_ck>}})`.
- **Token source:**
  - `g_ck` is read on demand with `chrome.scripting.executeScript({world:'MAIN'})` from an open tab of the *granted* host (top frame, or the first frame that has it).
  - It is cached in service-worker memory only. It is never stored, logged or sent outside the extension.
- **No open tab of the host:** `NO_INSTANCE_TAB`.
- **On `401`:** re-read the token from the tab once and retry once. If it's still `401`, return `SESSION_EXPIRED` and clear the cached token.
- **Fallback:** path B (in-tab fetch) is not used.

## Query semantics observed (sys_db_object, 6,775 rows)

| Query | Rows | Meaning |
| --- | --- | --- |
| `sys_created_onRELATIVEGE@minute@ago@1` | 0 | `RELATIVEGE` is honored (an ignored term would return 6,775) |
| `sys_created_onRELATIVELT@minute@ago@1` | 6,775 | `RELATIVELT` is honored |
| `sys_created_onRELATIVEGE@year@ago@100` | 6,775 | Consistent |
| `sys_created_onBETWEEN2000-01-01 00:00:00@2000-01-02 00:00:00` | 0 | — |
| `sys_created_onBETWEEN2000-01-01 00:00:00@2100-01-01 00:00:00` | 6,775 | **Plain-date `BETWEEN` works** (the narrow and wide ranges differ) |
| `sys_created_on>=2000-01-01 00:00:00` / `<…` | 6,775 / 0 | Plain-date comparisons work |
| `zz_no_such_field_zz=1` | **6,775** | **An invalid field is silently ignored and returns all rows.** This confirms the anti-broadening risk (T-018). |
| `name=zz_no_such_table_zz^ORzz_no_such_field_zz=1` | 0 | The invalid OR term is dropped and only the valid term applies |

The Stats API works: `GET /api/now/stats/incident?sysparm_count=true` → `count=67`.

## Follow-ups created

- **T-013:** prevent Chrome's HTTP-auth dialog on expired sessions. The connector must never cause a credential prompt, and requests must not hang. Candidate fixes, to be verified live:
  1. A request header that makes ServiceNow omit the `WWW-Authenticate` challenge (e.g. `X-Requested-With: XMLHttpRequest`), if ServiceNow honors it.
  2. `chrome.webRequest.onAuthRequired` cancelling challenges for the extension's own requests (needs `webRequest` + `webRequestAuthProvider`; a manifest change, so user approval).
  3. A cheap no-credential pre-check is **not** viable, because the session can't be told apart without credentials.
  - Pick the simplest one that works live, and record it in ADR-002.
- **T-015/T-034:** re-check H6 on an SSO instance if one becomes available.
