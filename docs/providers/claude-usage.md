# Claude — usage API contract (live verification)

Status: VERIFIED

Verified 2026-09-23 ~12:44 UTC on Windows 11 / Node v24, Claude Code 2.1.280 (native binary
`C:\Users\<user>\.local\bin\claude.exe`), account subscriptionType `pro`.

## 1. Token location

- `CLAUDE_CONFIG_DIR` was **not set**, so the file is `C:\Users\<user>\.claude\.credentials.json`
  (i.e. `%USERPROFILE%\.claude\.credentials.json`, 577 bytes, plain JSON).
- Real structure (values masked; lengths/types from the live file):

```jsonc
{
  "claudeAiOauth": {
    "accessToken": "<REDACTED>",            // string, len 108, prefix "sk-ant-oat"
    "refreshToken": "<REDACTED>",           // string, len 108, prefix "sk-ant-ort"
    "expiresAt": 1790171301389,             // number, epoch MILLISECONDS
    "refreshTokenExpiresAt": 1792351794389, // number, epoch MILLISECONDS (not documented anywhere)
    "scopes": ["user:file_upload","user:inference","user:mcp_servers","user:plugins",
               "user:profile","user:sessions:claude_code"],
    "subscriptionType": "pro",
    "rateLimitTier": "default_claude_ai"
  },
  "organizationUuid": "<REDACTED>"          // top-level (not under claudeAiOauth), string len 36
}
```

- `expiresAt` = 1790171301389 ms = 2026-09-23T13:48:21Z. At call time (12:44Z) the token was
  valid (~1 h left). Access tokens are short-lived, so an expired token is a normal case when
  Claude Code has not run recently.

## 2. Request that worked

```
GET https://api.anthropic.com/api/oauth/usage
Authorization: Bearer <REDACTED accessToken>
anthropic-beta: oauth-2025-04-20
```

No other headers (no User-Agent, no Content-Type). Plain Node `fetch`.

HTTP status: **200 OK**, `content-type: application/json`. Notable response headers:
`anthropic-organization-id: <REDACTED>`, `anthropic-workspace-id: <REDACTED>`, `server: cloudflare`.

## 3. Full response (verbatim values, pretty-printed; the body contained no ids/tokens/emails)

```json
{
  "five_hour": {
    "utilization": 22.0,
    "resets_at": "2026-09-23T15:50:00.667714+00:00",
    "limit_dollars": null,
    "used_dollars": null,
    "remaining_dollars": null,
    "locked_reason": null
  },
  "seven_day": {
    "utilization": 61.0,
    "resets_at": "2026-09-27T17:00:00.667742+00:00",
    "limit_dollars": null,
    "used_dollars": null,
    "remaining_dollars": null,
    "locked_reason": null
  },
  "seven_day_oauth_apps": null,
  "seven_day_opus": null,
  "seven_day_sonnet": null,
  "seven_day_cowork": null,
  "seven_day_omelette": null,
  "tangelo": null,
  "iguana_necktie": null,
  "omelette_promotional": null,
  "nimbus_quill": {
    "utilization": 0.0,
    "resets_at": null,
    "limit_dollars": null,
    "used_dollars": null,
    "remaining_dollars": null,
    "locked_reason": null
  },
  "cinder_cove": null,
  "copper_kite": null,
  "harbor_lantern": null,
  "wattle_ember": null,
  "amber_ladder": null,
  "juniper_tide": null,
  "cedar_ember": null,
  "amber_gauge": null,
  "extra_usage": {
    "is_enabled": false,
    "monthly_limit": 8500,
    "used_credits": 0.0,
    "utilization": 0.0,
    "currency": "EUR",
    "decimal_places": 2,
    "disabled_reason": "out_of_credits",
    "user_disabled": false,
    "spend_limit_reached": false,
    "credits_ever_enabled": true,
    "daily": null,
    "weekly": null
  },
  "limits": [
    {
      "kind": "session",
      "group": "session",
      "percent": 22,
      "severity": "normal",
      "resets_at": "2026-09-23T15:50:00.667714+00:00",
      "scope": null,
      "is_active": false
    },
    {
      "kind": "weekly_all",
      "group": "weekly",
      "percent": 61,
      "severity": "normal",
      "resets_at": "2026-09-27T17:00:00.667742+00:00",
      "scope": null,
      "is_active": true
    }
  ],
  "spend": {
    "used": { "amount_minor": 0, "currency": "EUR", "exponent": 2 },
    "limit": { "amount_minor": 8500, "currency": "EUR", "exponent": 2 },
    "percent": 0,
    "severity": "normal",
    "enabled": false,
    "disabled_reason": "out_of_credits",
    "cap": {
      "money": { "amount_minor": 8500, "currency": "EUR", "exponent": 2 },
      "credits": null
    },
    "balance": null,
    "auto_reload": null,
    "disclaimer": "Usage credits cover you when you hit your plan limits. [Learn more](https://support.claude.com/articles/12429409)",
    "can_purchase_credits": false,
    "can_toggle": false
  },
  "member_dashboard_available": false,
  "seven_day_breakdown": {
    "as_of": "2026-09-23T12:44:22.751494+00:00",
    "window_started_at": "2026-09-20T17:00:00.667742+00:00",
    "rows": [
      { "key": "claude_code", "display_name": "Claude Code", "percent": 87 },
      { "key": "chat", "display_name": "Chats", "percent": 3 },
      { "key": "cowork", "display_name": "Cowork", "percent": 10 },
      { "key": "other", "display_name": "Other", "percent": 0 }
    ]
  }
}
```

## 4. Format: this account gets BOTH

The response contains the flat fields (`five_hour`, `seven_day`, `seven_day_sonnet`,
`seven_day_opus`, ...) **and** the structured `limits[]` list at the same time. They agree
(22 / 61, identical `resets_at`).

## 5. Field mapping

| Source | Field | Meaning / format |
|---|---|---|
| flat `five_hour` | `utilization` | float, **0–100 percent used** (22.0 = 22 %) → `percentUsed` directly |
| flat `five_hour` | `resets_at` | ISO 8601 string with microseconds and `+00:00` offset; parse with `new Date()` |
| flat `seven_day` | same | weekly, all models |
| flat `seven_day_sonnet` / `seven_day_opus` | object or **null** | null on this Pro account → skip nulls |
| flat `nimbus_quill`, `tangelo`, ... | obfuscated codenames | can be non-null with `resets_at: null` (nimbus_quill = 0.0) → do NOT render unknown keys |
| flat `*_dollars`, `locked_reason` | null here | ignore in v1 |
| `limits[]` | `kind` | seen: `session`, `weekly_all`. `weekly_scoped` NOT present for this account (unverified) |
| `limits[]` | `percent` | **integer 0–100 percent used** (rounded version of `utilization`) |
| `limits[]` | `resets_at` | same ISO format as flat |
| `limits[]` | `scope` | `null` for session/weekly_all; `scope.model.display_name` NOT observed (unverified) |
| `limits[]` | `group`, `severity` (`normal`), `is_active` | extra; `is_active` appears to mark the currently binding limit |
| `extra_usage` / `spend` | money | pay-as-you-go credits; 8500 = minor units (85.00 EUR). Out of scope for v1 |
| `seven_day_breakdown` | per-surface share of weekly usage | informational only |

Suggested normalisation: prefer `limits[]` when present (session → "5h session",
weekly_all → "Weekly (all models)", weekly_scoped → "Weekly (<scope.model.display_name>)"),
fall back to flat `five_hour` / `seven_day` / `seven_day_sonnet` / `seven_day_opus` (skipping nulls)
when `limits` is absent.

## 6. Refresh (NOT performed — it would rotate the refresh token)

Evidence source: strings in the installed native binary `C:\Users\<user>\.local\bin\claude.exe`
(Claude Code **2.1.280**), production OAuth config object (verbatim):

```
BASE_API_URL:"https://api.anthropic.com",
CONSOLE_AUTHORIZE_URL:"https://platform.claude.com/oauth/authorize",
TOKEN_URL:"https://platform.claude.com/v1/oauth/token",
CLIENT_ID:"9d1c250a-e61b-44d9-88ed-5944d1962f5e",
```

A second config block (`CLIENT_ID:"22422756-60c9-4084-8eb7-27705fd5cf9a"`,
`OAUTH_FILE_SUFFIX:"-local-oauth"`, `http://localhost:3000`) is the internal dev/local config —
ignore it. `console.anthropic.com` does not appear as a token URL in this version.

Refresh function in the binary (minified, verbatim excerpt):

```js
T={grant_type:"refresh_token",refresh_token:e,client_id:s??nn().CLIENT_ID,scope:C.join(" ")};
if(r!==void 0)T.expires_in=r;
let D=await dt.post(nn().TOKEN_URL,T,{headers:{"Content-Type":"application/json"},timeout:30000,signal:h});
if(D.status!==200)throw Error(`Token refresh failed: ${D.statusText}`);
let I=D.data,{access_token:N,refresh_token:F=e,expires_in:L}=I,B=Date.now()+L*1000,
    X=yLn(I.refresh_token_expires_in,!1),G=BQt(I.scope);
```

Resulting request:

```
POST https://platform.claude.com/v1/oauth/token
Content-Type: application/json

{"grant_type":"refresh_token",
 "refresh_token":"<refreshToken>",
 "client_id":"9d1c250a-e61b-44d9-88ed-5944d1962f5e",
 "scope":"<space-separated scopes, e.g. claudeAiOauth.scopes joined by ' '>"}
```

Response fields (from the code, not observed live): `access_token`, `refresh_token` (optional;
code falls back to the old one), `expires_in` (seconds → `expiresAt = Date.now() + expires_in*1000`),
`refresh_token_expires_in`, `scope`.

## 7. Caveats

- Refresh is **unverified live** by design. Refresh tokens rotate: if agentsctl refreshes and does
  not write the new tokens back to `.credentials.json`, Claude Code's own next refresh will fail
  and the user must log in again. agentsctl therefore refreshes only when needed and writes the
  new tokens back atomically with a compare-and-swap (`src/providers/refresh.ts`); with
  `--no-refresh` it reports "token expired — run `claude` once" instead.
- Only one account type sampled (Pro, personal). Max/Team accounts may populate
  `seven_day_opus` / `seven_day_sonnet` and `limits[]` entries of kind `weekly_scoped` with a
  non-null `scope`; the shape of `scope` was NOT observed.
- The response has many obfuscated codename keys that change between releases; parse only known
  keys and tolerate unknown ones.
- Claude Code itself also calls query variants (`/api/oauth/usage?at_wall=1&skip_spend=1`,
  `?cedar_ember=1&skip_spend=1`); the plain URL works.
- Endpoint is undocumented/internal; schema may change without notice.
