# Codex — usage API contract (live verification)

Status: VERIFIED

Verified 2026-09-23 on Windows 11 (Node v24 `fetch`), Codex CLI `codex-cli 0.155.1`
(`C:\Users\<user>\AppData\Local\Programs\OpenAI\Codex\bin\codex.exe`; not an npm global
install). Account plan: `team`.

## Token location

File: `%USERPROFILE%\.codex\auth.json` (`path.join(os.homedir(), '.codex', 'auth.json')`).

Actual top-level structure (values masked):

```json
{
  "auth_mode": "chatgpt",
  "OPENAI_API_KEY": null,
  "tokens": {
    "id_token": "<REDACTED JWT>",
    "access_token": "<REDACTED JWT>",
    "refresh_token": "<REDACTED, opaque, 211 chars>",
    "account_id": "<REDACTED, UUID, 36 chars>"
  },
  "last_refresh": "2026-09-21T06:29:07.853642700Z"
}
```

- `tokens.access_token` — JWT (RS-signed, `iss: https://auth.openai.com`,
  `aud: ["https://api.openai.com/v1"]`, `client_id: app_EMoamEEZ73f0CkXaXp7hrann`,
  `scp: openid profile email offline_access`). **Lifetime 864000 s = 10 days**
  (`iat` 1789972139 → `exp` 1790836139 = 2026-10-01T06:28:59Z), not ~1h.
  Expiry can be checked locally by decoding the `exp` claim (base64url payload) — no call needed.
  Payload claim `https://api.openai.com/auth` holds `chatgpt_account_id`, `chatgpt_plan_type`,
  `chatgpt_user_id`, `user_id`, etc.
- `tokens.id_token` — JWT, lifetime 3600 s (already expired; irrelevant for usage call).
- `tokens.refresh_token` — opaque string.
- `tokens.account_id` — ChatGPT account UUID (same as the JWT's `chatgpt_account_id`).
- `auth_mode` may also be API-key mode (`OPENAI_API_KEY` set, no ChatGPT tokens) — then there
  is no subscription usage to report.

## Endpoint

**`GET https://chatgpt.com/backend-api/wham/usage`**

NOT `/backend-api/codex/usage` — that path (and `/backend-api/api/codex/usage`) returns
**403 `text/html`, header `cf-mitigated: challenge`** (Cloudflare "Enable JavaScript and cookies
to continue" challenge page), with or without Codex-style headers.

Evidence from the codex.exe binary strings: backend-client picks path by base URL — if the base
contains `/backend-api` it uses `/wham/...` paths, otherwise `/api/codex/...`
(pairs seen: `/api/codex/usage` ↔ `/wham/usage`, `/api/codex/tasks` ↔ `/wham/tasks`,
`/api/codex/rate-limit-reset-credits` ↔ `/wham/rate-limit-reset-credits`, ...). Default base is
`https://chatgpt.com/backend-api`, so the CLI calls `https://chatgpt.com/backend-api/wham/usage`.

### Request headers that worked

Minimal (works, HTTP 200):

```
Authorization: Bearer <REDACTED access_token>
Accept: application/json
```

Codex-like (also HTTP 200, identical body) — recommended to mirror the CLI:

```
Authorization: Bearer <REDACTED access_token>
ChatGPT-Account-Id: <REDACTED tokens.account_id>
User-Agent: codex_cli_rs/0.155.1 (Windows 10.0.26200; x86_64)
originator: codex_cli_rs
```

(The binary contains `ChatGPT-Account-Id` / `chatgpt-account-id` header names, the log line
"auth: set ChatGPT-Account-Id header", originator values `codex_cli_rs`, `codex-tui`,
`codex_exec`, `codex_vscode`, ..., and a UA format `<originator>/<version> (<os> <ver>; <arch>) ...`.)

HTTP status: **200**, `content-type: application/json`.

Invalid token → **401** `application/json`:
`{"detail":"Could not parse your authentication token. Please try signing in again."}`

### Example response (masked)

Captured at `now = 1790167518` (2026-09-23T12:45:18Z):

```json
{
  "user_id": "<REDACTED>",
  "account_id": "<REDACTED>",
  "email": "<REDACTED>",
  "plan_type": "team",
  "rate_limit": {
    "allowed": true,
    "limit_reached": false,
    "primary_window": {
      "used_percent": 75,
      "limit_window_seconds": 18000,
      "reset_after_seconds": 8077,
      "reset_at": 1790175592
    },
    "secondary_window": {
      "used_percent": 12,
      "limit_window_seconds": 604800,
      "reset_after_seconds": 543136,
      "reset_at": 1790710652
    }
  },
  "code_review_rate_limit": null,
  "additional_rate_limits": null,
  "model_usage": {
    "gpt-6-astra": {
      "available": true,
      "available_at": null,
      "credits_would_enable": false
    }
  },
  "credits": {
    "has_credits": false,
    "unlimited": false,
    "overage_limit_reached": false,
    "balance": null,
    "approx_local_messages": null,
    "approx_cloud_messages": null
  },
  "spend_control": {
    "reached": false,
    "individual_limit": null
  },
  "rate_limit_reached_type": null,
  "promo": null,
  "rate_limit_reset_credits": {
    "available_count": 3,
    "applicable_available_count": 0
  }
}
```

## Field mapping

| Window | JSON path | Notes |
|---|---|---|
| 5h limit | `rate_limit.primary_window` | `limit_window_seconds` = 18000 (5 h) |
| Weekly limit | `rate_limit.secondary_window` | `limit_window_seconds` = 604800 (7 d) |

Per window:

- `used_percent` — number, percent **used** (0–100). Here integers (75, 12); treat as number
  (may be fractional). Percent left = `100 - used_percent`.
- `reset_at` — **Unix epoch seconds** (integer). 1790175592 = 2026-09-23T14:59:52Z.
- `reset_after_seconds` — seconds until reset, relative to response time
  (`reset_at - now` ≈ `reset_after_seconds`, confirmed: 1790175592 − 1790167518 = 8074 ≈ 8077).
- `limit_window_seconds` — window length; use it to label windows rather than trusting
  primary/secondary order.

Easy to get wrong: the field is `used_percent` (not `utilization`), reset is
`reset_at` epoch seconds (not `resets_at`/`reset_time`), and both windows are nested under
`rate_limit`.

Other fields: `rate_limit.allowed` / `rate_limit.limit_reached` (booleans),
`rate_limit_reached_type` (null here), `plan_type`, `credits.*`,
`code_review_rate_limit` and `additional_rate_limits` (null here — schema of non-null values
not observed; likely same window shape, unverified). Handle `primary_window`/`secondary_window`
being null defensively (not observed, but plausible for plans without limits).

## Refresh (documented only — NOT performed)

Source: strings in `codex.exe` 0.155.1.

- Endpoint: `POST https://auth.openai.com/oauth/token`
  (overridable in CLI via env `CODEX_REFRESH_TOKEN_URL_OVERRIDE`).
- client_id: `app_EMoamEEZ73f0CkXaXp7hrann` (also matches the access token's `client_id`
  claim; binary also references env `CODEX_APP_SERVER_LOGIN_CLIENT_ID`).
- Body: `Content-Type: application/json` with fields `client_id`, `grant_type`,
  `refresh_token` (string sequence `refresh_tokenclient_idgrant_type` next to
  `Content-Typeapplication/json` in the refresh code), i.e.
  `{"client_id":"app_EMoamEEZ73f0CkXaXp7hrann","grant_type":"refresh_token","refresh_token":"<...>"}`.
  Exact inclusion of a `scope` field not confirmed.
- Response parsed into `id_token`, `access_token`, `refresh_token`.
- Error string seen: "Your access token could not be refreshed. Please log out and sign in again."
  The response returns a new `refresh_token`, so **refresh tokens likely rotate** (not verified) —
  performing a refresh from agentsctl without writing back to auth.json could invalidate the CLI's
  stored refresh token. Given the 10-day access-token lifetime, v1 should probably skip refresh
  and just report "run `codex` to renew login" when `exp` has passed or on 401.

## Caveats

- Undocumented internal API; the path is `/wham/usage`, not `/codex/usage`.
- `/backend-api/codex/usage` is behind a Cloudflare JS challenge (403 HTML) — detect non-JSON
  responses and report an error rather than trying to parse.
- Response contains PII (`email`, `user_id`, `account_id`) — never log raw body.
- Only one account/plan (`team`) observed; other plans (plus/pro/free) may differ.
