# Cursor — usage API contract (live verification)

Status: VERIFIED

Verified 2026-09-23 on Windows 11, Node v24.14.0, Cursor 3.17.19
(`%LOCALAPPDATA%\Programs\cursor`). Account: Team plan (enterprise membership), 0% used
at time of capture.

## Token source

- DB path: `%APPDATA%\Cursor\User\globalStorage\state.vscdb`
  (= `C:\Users\<user>\AppData\Roaming\Cursor\User\globalStorage\state.vscdb`).
  Sidecar files present: `state.vscdb-wal`, `state.vscdb-shm` (WAL mode), `state.vscdb.backup`.
- Opened with `better-sqlite3` `{ readonly: true, fileMustExist: true }` — works.
- Tables: `ItemTable`, `cursorDiskKV`, `composerHeaders`. Auth lives in `ItemTable` (`key TEXT`, `value` returned as string).
- Build the path with `path.join(process.env.APPDATA, 'Cursor', 'User', 'globalStorage', 'state.vscdb')`.

Keys found with `SELECT key FROM ItemTable WHERE key LIKE 'cursorAuth/%'`:

| key | shape |
|---|---|
| `cursorAuth/accessToken` | JWT, 413 chars |
| `cursorAuth/refreshToken` | JWT, 413 chars. **Identical to accessToken.** Cursor itself stores `storeAccessRefreshToken(c.access_token, c.access_token)` after a refresh |
| `cursorAuth/cachedEmail` | string (email) <REDACTED> |
| `cursorAuth/cachedSignUpType` | `Auth_0` |
| `cursorAuth/cachedScopedProfile` | JSON `{"displayName": "..."}` |
| `cursorAuth/cachedTeam` | string, 42 chars <REDACTED> |
| `cursorAuth/stripeMembershipType` | `enterprise` |
| `cursorAuth/stripeMembershipAuthId` | `auth0\|user_<REDACTED>` |

Token type: HS256 JWT, used as a Bearer token. Claims: `sub, time, randomness, exp, iss, scope, aud, type`
(there is no `iat`).
- `sub` = `auth0|user_<REDACTED>`. The userId is the part after `|` (shape `user_` + 26 chars).
- `iss` = `https://authentication.cursor.sh`, `aud` = `https://cursor.com`,
  `scope` = `openid profile email offline_access`, `type` = `session`.
- `exp` = 2026-11-13T11:32:56Z, so the token is long-lived (about 60 days).

Lock behaviour: **not tested while Cursor was running.** Cursor was not running during
verification (`tasklist` showed no Cursor process). The DB uses WAL, and a read-only reader
normally does not block and is not blocked by a WAL writer. A `SQLITE_BUSY` error is still
possible during checkpoints, so the implementation should set a small `timeout` and turn a
BUSY error into a provider error.

## Primary endpoint (works)

```
POST https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage
Authorization: Bearer <REDACTED accessToken>
Content-Type: application/json
Connect-Protocol-Version: 1
body: {}
```
HTTP 200, `content-type: application/json`:

```json
{
  "billingCycleStart": "1789133341000",
  "billingCycleEnd": "1791725341000",
  "planUsage": {
    "remaining": 2000,
    "limit": 2000,
    "remainingBonus": false,
    "bonusTooltip": "We work with model providers to give you free usage beyond what you've purchased. Amounts may vary.",
    "autoPercentUsed": 0,
    "apiPercentUsed": 0,
    "totalPercentUsed": 0
  },
  "spendLimitUsage": { "pooledUsed": 0, "limitType": "team" },
  "displayThreshold": 200,
  "enabled": true,
  "displayMessage": "You've used 0% of your included usage",
  "autoModelSelectedDisplayMessage": "You've used 0% of your included total usage",
  "namedModelSelectedDisplayMessage": "You've used 0% of your included API usage",
  "autoBucketModels": ["default", "composer-1.5", "composer-2", "composer-2-fast", "composer-2.5", "composer-2.5-fast", "vega", "vega-medium", "vega-high", "vega-xhigh", "vega-fast-medium", "vega-fast-high", "vega-fast-xhigh", "grok-4.5", "cursor-grok-4.5", "cursor-grok-4.5-low", "cursor-grok-4.5-low-fast", "cursor-grok-4.5-medium", "cursor-grok-4.5-medium-fast", "cursor-grok-4.5-high", "cursor-grok-4.5-high-fast", "grok-4.5-medium", "grok-4.5-fast-medium", "grok-4.5-high", "grok-4.5-fast-high", "grok-4.5-xhigh", "grok-4.5-fast-xhigh", "composer-1"]
}
```

Notes on the schema:
- `billingCycleStart` and `billingCycleEnd` are **epoch milliseconds as strings** (protobuf int64 in JSON).
  1789133341000 = 2026-09-11T13:29:01Z and 1791725341000 = 2026-10-11T13:29:01Z. These match `/api/usage-summary` below.
- `planUsage.limit` and `planUsage.remaining` are **cents**. Evidence: `GetPlanInfo.includedAmountCents` is 2000, the same value as `limit`, which is $20 of included usage. The plan is "Team $40/mo".
- Usage is **dollar-based** (`pricingStrategy: "tokens"` in GetTeams), not request-count based. The old "fast requests" model does not apply to this account.
- Protobuf JSON leaves out zero or default fields. Expect `remaining`, `*PercentUsed` and `pooledUsed` to be **missing** when they are 0 (they were present here, but do not rely on that). Default a missing number to 0.

### Field mapping (recommended)

> **Correction 2026-10-09 (first check with non-zero usage).** The mapping in the table below was
> verified at 0 % used, where everything agreed. With real usage the fields disagree:
> `totalSpend: 591`, `includedSpend: 591`, `remaining: 1409`, `limit: 2000`,
> `autoPercentUsed: 2.1238`, `apiPercentUsed: 3.625`, `totalPercentUsed: 2.364`.
> $5.91 of $20.00 would be 29.6 %, so the percentages are NOT `spend / limit`. They are consistent
> with allowances of $210 (auto bucket) + $40 (API bucket) = $250 — derived arithmetic, not in the API.
> Cursor's own usage page shows two meters and no dollar limit: "Cursor Models" 2 % (= `autoPercentUsed`,
> the `autoBucketModels`: Composer, Cursor Grok, ...) and "Other Models" 4 % (= `apiPercentUsed`).
> agentsctl now renders exactly those two (`Cursor Models`, `Other Models`) plus
> `$<totalSpend> spent in total`; it no longer shows spend against `limit`. `totalPercentUsed` is only
> used as a single `Monthly` meter when neither auto nor api percentage is present.

| UsageWindow | source |
|---|---|
| label | `"Included usage"` (or `"Monthly (included)"`) |
| percentUsed | `planUsage.totalPercentUsed`. Fallback: `(limit - remaining) / limit * 100` when `limit > 0` |
| resetsAt | `new Date(Number(billingCycleEnd))` |
| extra | `$${(limit-remaining)/100}/$${limit/100}`, e.g. `$0.00/$20.00` |

Optional extra windows: `planUsage.autoPercentUsed` ("Auto models") and `planUsage.apiPercentUsed`
("Named/API models"). They map to Cursor's own "included total usage" and "included API usage" messages.
"Limit" = `planUsage.limit` (plan-included amount in cents). On-demand or usage-based spend is
disabled for this account (`GetHardLimit.noUsageBasedAllowed: true`, `onDemand.enabled: false`).
`spendLimitUsage.pooledUsed` is team-pooled spend and is not shown.

Treat `enabled: false` or a missing `planUsage` as "no included-usage data" and return an error
result. Do not report 0%.

## Other endpoints tried (all worked, for reference)

All `aiserver.v1.DashboardService/*` calls use the same headers and the `{}` body as above.

| call | status | result (masked) |
|---|---|---|
| POST `.../DashboardService/GetPlanInfo` | 200 | `{"planInfo":{"planName":"Team","includedAmountCents":2000,"price":"$40/mo","billingCycleEnd":"1791725341000"}}` |
| POST `.../DashboardService/GetUsageLimitStatusAndActiveGrants` | 200 | `{"usageLimitPolicyStatus":{"limitType":"seat-tier-upgrade","primaryButton":{"label":"Request Upgrade","dashboardAction":{"action":"requestLimitIncrease","args":{"limitType":"seat-tier-upgrade"},"successMessage":"Seat upgrade request sent to your team admin"}},"creditRequestButtonHidden":false}}`. Contains no numbers |
| POST `.../DashboardService/GetUsageLimitPolicyStatus` | 200 | same object as above, unwrapped |
| POST `.../DashboardService/GetHardLimit` | 200 | `{"noUsageBasedAllowed":true}` |
| POST `.../DashboardService/GetTeams` | 200 | `{"teams":[{"name":"<REDACTED>","id":<REDACTED>,"role":"TEAM_ROLE_MEMBER","seats":10,"hasBilling":true,"requestQuotaPerSeat":1,"billingCycleStart":"1789133341000","billingCycleEnd":"1791725341000","pricingStrategy":"tokens","membershipType":"SELF_SERVE","subscriptionStatus":"active", ...permissions/flags omitted...}]}` |
| GET `https://cursor.com/api/usage?user=<REDACTED userId>` + cookie `WorkosCursorSessionToken=<REDACTED userId>%3A%3A<REDACTED accessToken>` | 200 | `{"gpt-4":{"numRequests":0,"numRequestsTotal":0,"numTokens":0,"maxTokenUsage":null,"maxRequestUsage":null},"startOfMonth":"2026-09-11T13:29:01.000Z"}`. This is the legacy request-count model and has no limit for this plan (`maxRequestUsage: null`). Not useful |
| GET `https://cursor.com/api/usage-summary` + same cookie | 200 | see below |
| GET `https://cursor.com/api/auth/me` + same cookie | 200 | `{"email":"<REDACTED>","email_verified":true,"name":"<REDACTED>","sub":"<REDACTED>","created_at":"2025-11-11T11:11:20.616Z","updated_at":"2026-08-24T07:41:53.864Z","picture":"","id":<REDACTED>,"automation_client":false}` |

`GET https://cursor.com/api/usage-summary` (cookie auth), HTTP 200. This is an alternative with ISO
dates and explicit `used` (cents):

```json
{
  "billingCycleStart": "2026-09-11T13:29:01.000Z",
  "billingCycleEnd": "2026-10-11T13:29:01.000Z",
  "membershipType": "enterprise",
  "limitType": "team",
  "isUnlimited": false,
  "autoModelSelectedDisplayMessage": "You've used 0% of your included total usage",
  "namedModelSelectedDisplayMessage": "You've used 0% of your included API usage",
  "individualUsage": {
    "plan": {
      "enabled": true, "used": 0, "limit": 2000, "remaining": 2000,
      "breakdown": { "included": 0, "bonus": 0, "total": 0 },
      "autoPercentUsed": 0, "apiPercentUsed": 0, "totalPercentUsed": 0
    },
    "onDemand": { "enabled": false, "used": 0, "limit": null, "remaining": null }
  },
  "teamUsage": { "onDemand": { "enabled": false, "used": 0, "limit": null, "remaining": null } }
}
```

Recommendation: use `GetCurrentPeriodUsage` (Bearer, no cookie construction). Keep
`/api/usage-summary` as a documented fallback.

## Refresh flow (documented, NOT performed)

Evidence source:
`%LOCALAPPDATA%\Programs\cursor\resources\app\out\vs\workbench\workbench.desktop.main.js`
(Cursor 3.17.19), in function `_performAccessTokenRefresh`. The flow is not in `out/main.js`.

```
POST https://api2.cursor.sh/oauth/token          (cursorCreds.backendUrl = Upt = "https://api2.cursor.sh")
content-type: application/json
x-cursor-client-type: ide                        (Vmt="x-cursor-client-type"; "glass" in Glass env)
(+ optional MDM sign-in-policy headers)
body: {"grant_type":"refresh_token","client_id":"KbZUR41cY7W6zRSdpSUJ7I7mLYBKOCmB","refresh_token":"<refreshToken>"}
```

- Production `client_id` is `KbZUR41cY7W6zRSdpSUJ7I7mLYBKOCmB`. It is the minified constant
  `QIi`, used together with `authDomain: "prod.authentication.cursor.sh"` and `backendUrl: "https://api2.cursor.sh"`.
  The other constant `UKe="OzaBXLClY5CAGxNzUhQ2vlknpi07tGuE"` is only used with the
  localhost/dev-staging (`dev.authentication.cursor.sh`) configs. Do not use it.
- Response handling: `const c = await a.json()`. If `c.shouldLogout === true`, Cursor logs out.
  Otherwise it calls `storeAccessRefreshToken(c.access_token, c.access_token)`, so the new access
  token also becomes the refresh token.
- Cursor only refreshes when fewer than `hir = 1272*60*60*1e3` ms (53 days) remain before `exp`.
  It uses a 20 s abort timeout.
- Access and refresh tokens are the same long-lived JWT (about 60 days) and Cursor refreshes on
  its own, so agentsctl rarely needs to. When it does, it reads `state.vscdb` read-only and
  opens a separate short read-write transaction to store the new tokens, with a compare-and-swap
  on `cursorAuth/refreshToken`; if the DB is locked nothing is written and the token is used for
  that run only (`writeBackCursorTokens` in `src/providers/cursor/usage.ts`).

## Caveats

- Undocumented, internal Connect-RPC API. Field names may change between Cursor versions (best-effort, like Copilot).
- Only verified on a Team/enterprise plan with dollar-based included usage and 0% used. Pro and
  individual plans, or legacy request-based plans, may return different or missing `planUsage`
  fields. The implementation must tolerate missing fields, and must not fall back to guessing.
- Number fields are omitted when 0 (protobuf JSON); the int64 timestamps are strings.
- The DB-lock behaviour while Cursor is running was not observed (Cursor was closed).
- `cachedEmail`, `cachedTeam`, `stripeMembershipAuthId`, and the team name/id are PII. Do not log them.
