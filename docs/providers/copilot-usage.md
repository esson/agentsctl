# Copilot — usage API contract (live verification)

**Status: VERIFIED** (2026-09-23 15:28, via `gh auth token`). The response schema below was
observed live. The Copilot CLI credential path (`copilot-cli/...`) is implemented but was empty
at verification time (see the last section), so the token actually used was the gh fallback.

## Verified request

```
GET https://api.github.com/copilot_internal/user
Authorization: token <REDACTED gho_ token from `gh auth token`>
Accept: application/json
```

No Editor-Version / X-GitHub-Api-Version headers needed; Node fetch's default User-Agent is
accepted. HTTP **200**, `application/json; charset=utf-8`. A `gho_` token from the GitHub CLI
OAuth app (scopes gist, read:org, repo, workflow) is accepted.

## Masked response (Copilot Business)

```json
{
  "id": "<REDACTED>",
  "login": "<REDACTED>",
  "access_type_sku": "copilot_for_business_seat_quota",
  "analytics_tracking_id": "<REDACTED>",
  "assigned_date": "2024-05-17T15:53:06+02:00",
  "can_signup_for_limited": false,
  "chat_enabled": true,
  "cli_enabled": true,
  "copilotignore_enabled": false,
  "copilot_plan": "business",
  "editor_preview_features_enabled": true,
  "is_mcp_enabled": true,
  "is_staff": false,
  "enterprise_list": [],
  "organization_login_list": ["<REDACTED>"],
  "organization_list": [{ "id": "<REDACTED>", "login": "<REDACTED>", "name": "<REDACTED>" }],
  "restricted_telemetry": false,
  "cli_remote_control_enabled": false,
  "copilot_app_enabled": true,
  "cloud_session_storage_enabled": false,
  "endpoints": {
    "api": "https://api.business.githubcopilot.com",
    "origin-tracker": "https://origin-tracker.business.githubcopilot.com",
    "proxy": "https://proxy.business.githubcopilot.com",
    "telemetry": "https://telemetry.business.githubcopilot.com",
    "exp": "https://exp.business.githubcopilot.com"
  },
  "can_upgrade_plan": false,
  "te": false,
  "quota_reset_date": "2026-10-01",
  "quota_snapshots": {
    "chat": {
      "overage_count": 0, "overage_permitted": false, "percent_remaining": 100,
      "quota_id": "<REDACTED>", "quota_remaining": 0, "unlimited": true,
      "timestamp_utc": "2026-09-23T13:28:31.583Z", "has_quota": true, "quota_reset_at": 0,
      "token_based_billing": "<REDACTED (masked by probe; type not recorded)>",
      "credits_used": 0, "overage_entitlement": 0, "remaining": 0, "entitlement": 0
    },
    "completions": { "...": "same fields as chat, all unlimited, credits_used 0" },
    "premium_interactions": {
      "overage_count": 0, "overage_permitted": true, "percent_remaining": 100,
      "quota_id": "<REDACTED>", "quota_remaining": 0, "unlimited": true,
      "timestamp_utc": "2026-09-23T13:28:31.583Z", "has_quota": true, "quota_reset_at": 0,
      "token_based_billing": "<REDACTED (masked by probe; type not recorded)>",
      "credits_used": 8190, "overage_entitlement": 0, "remaining": 0, "entitlement": 0
    }
  },
  "quota_reset_date_utc": "2026-10-01T00:00:00.000Z",
  "token_based_billing": "<REDACTED (masked by probe; type not recorded)>"
}
```

## Field mapping (as implemented in src/providers/copilot/usage.ts)

- `token_based_billing: true` (top level or on `premium_interactions`) → report the team pool,
  see the next section. The window is `Monthly (Team)`, with
  `premium_interactions.credits_used` (8190 here) shown as your own share in AI credits.
- Team pool unavailable (no org admin/billing access) → `Monthly (You)`: your `credits_used`,
  no percentage.
- Request-based billing → `Monthly (Premium)` from `quota_snapshots.premium_interactions`:
  - `unlimited: true` → no percentage, `extra: "no personal limit"`. `entitlement`, `remaining`
    and `quota_remaining` are all 0 on such plans, so they must not be used for a percentage.
  - `unlimited: false` → `percentUsed = 100 - percent_remaining`,
    `extra = "<entitlement-remaining>/<entitlement>"` when `entitlement > 0`.
    **Not observed live** (no limited-plan account available).
- `resetsAt` = `quota_reset_date_utc` (ISO), falling back to `quota_reset_date` (YYYY-MM-DD, UTC).
- `organization_login_list` gives the orgs to try for the team pool.

## Team pool: org billing endpoints (verified live 2026-09-23, gh token, user is org admin)

`unlimited: true` only means *no personal cap*. With `token_based_billing: true` the real limit
is the org's pool of included AI credits. The org billing page showed
"Included credits 12,310 / 19,000 AI credits … Monthly limit resets … on October 1, 2026".

| Request | Status | Used for |
|---|---|---|
| `GET /organizations/{org}/settings/billing/usage/summary?year=2026&month=9` | 200 | Copilot `ai-units` grossQuantity: `copilot_ai_unit` 12310.50 + `coding_agent_ai_unit` 39.50 (all discounted, net $0) → used |
| `GET /orgs/{org}/copilot/billing` | 200 | `seat_breakdown.total` = 10 → pool = 10 × 1900 = 19,000 (per-seat figure derived from the web page, not from any API) |
| `GET /organizations/{org}/settings/billing/budgets` | 200 | `ai_credits` budget: `budget_amount: 0`, `prevent_further_usage: true` (hard stop, no overage) — informational |
| `GET /organizations/{org}/settings/billing/premium_request/usage` | 200 | `usageItems: []` — premium requests no longer used under token-based billing |
| `GET /users/{user}/settings/billing/premium_request/usage` | 404 | — |

Headers: `Authorization: token <gh token>`, `Accept: application/vnd.github+json`,
`X-GitHub-Api-Version: 2022-11-28`. Summary item fields: `product, sku, grossQuantity,
discountQuantity, netQuantity, grossAmount, discountAmount, netAmount, pricePerUnit (0.01), unitType`.
Masked samples: `test/fixtures/copilot-org-usage-summary.json`, `test/fixtures/copilot-org-billing.json`.
Open question: whether the web page's "consumed" figure includes `coding_agent_ai_unit`
(12,310 on the page vs 12,310 + 40 via API a few minutes later) — agentsctl includes it.

## Why `@napi-rs/keyring` must never be used

> `@napi-rs/keyring` 2.1.0 `Entry.withTarget(target, service, user).getPassword()`
> **overwrites the target credential with a 0-byte secret**. Reproduced on a dummy credential:
> blob 28 bytes → 0 bytes, LastWritten updated, after one `getPassword()` call.
> `git:https://github.com`, `gh:github.com:<login>` and `copilot-language-server/oauth-token-key`
> were all blanked at the same second (14:45:09) by the first probe, and
> `copilot-cli/...` was blanked again by the provider on every run until the fix.
>
> Fix: `@napi-rs/keyring` removed; `src/wincred.ts` reads via Win32 `CredReadW`
> (read-only, verified on a dummy: blob and LastWritten unchanged). Blobs may be UTF-8
> (gh/go-keyring) or UTF-16LE (cmdkey); both are decoded. After the fix, `gh auth status`
> stays valid across agentsctl runs. **Never use `@napi-rs/keyring` in this project.**
