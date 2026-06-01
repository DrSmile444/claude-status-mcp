# GitHub Copilot Quota & Rate Limit Research

Research for building a `copilot-status-mcp` server analogous to `claude-status-mcp` and `codex-status-mcp`.

---

## TL;DR

There are **two separate limit systems** in GitHub Copilot, exposed through **different APIs requiring different tokens**:

| Limit type | When it applies | Source | Token needed |
|---|---|---|---|
| Monthly quota | Always (tracks entitlement) | `GET /copilot_internal/user` | Any GitHub OAuth token |
| Short-term rate limit | When window is exhausted | CAPI `429` response headers | Copilot-specific OAuth token |

---

## Endpoints

### 1. `GET https://api.github.com/copilot_internal/user`

Returns monthly quota and account info. Works with any GitHub OAuth token (standard `repo` scope, no special Copilot scope needed).

**Sample response (free tier):**
```json
{
  "login": "username",
  "access_type_sku": "free_limited_copilot",
  "copilot_plan": "individual",
  "chat_enabled": true,
  "token_based_billing": true,
  "quota_snapshots": {
    "chat":                { "remaining": 199, "entitlement": 200, "percent_remaining": 99.9, "unlimited": false, "quota_reset_at": 0 },
    "completions":         { "remaining": 2000, "entitlement": 2000, "percent_remaining": 100.0, "unlimited": false, "quota_reset_at": 0 },
    "premium_interactions":{ "remaining": 0, "entitlement": 0, "percent_remaining": 0.0, "unlimited": false, "quota_reset_at": 0 }
  },
  "quota_reset_date": "2026-07-01",
  "quota_reset_date_utc": "2026-06-30T21:00:00.000Z"
}
```

**What it contains:**
- `access_type_sku` — plan type: `free_limited_copilot`, `yearly_subscriber_quota`, `business`, `enterprise`
- `quota_snapshots.chat` — monthly chat quota (free: 200/month)
- `quota_snapshots.completions` — monthly code completion quota (free: 2000/month)
- `quota_snapshots.premium_interactions` — premium model usage (paid plans)
- `quota_reset_date_utc` — when monthly quota resets
- `quota_snapshots.*.quota_reset_at` — Unix timestamp (seconds); non-zero means this dimension has a rolling window limit active

**What it does NOT contain:**
- The short-term rate limit reset time (even when the user is actively rate limited)
- `limited_user_quotas` / `limited_user_reset_date` remain `null` in practice even during active rate limiting

> **Caveat:** The fields `limited_user_quotas`, `limited_user_reset_date`, and `monthly_quotas` exist in the SDK schema for this endpoint, and are used by some Copilot clients (JetBrains) to display monthly exhaustion state. However, in live testing they remained `null` even during an active rate limit — so **do not rely on them for rate limit detection**.

---

### 2. `GET https://api.github.com/copilot_internal/v2/token`

Returns a short-lived CAPI session token (~30 min) with a quota envelope. Requires a **Copilot-specific OAuth token** — tokens from `gh auth login` return `404`.

**Response fields of interest:**
```json
{
  "token": "tid=...",
  "expires_at": 1780308514,
  "refresh_in": 1500,
  "sku": "yearly_subscriber_quota",
  "endpoints": {
    "api": "https://api.individual.githubcopilot.com",
    "proxy": "https://proxy.individual.githubcopilot.com"
  },
  "limited_user_quotas": null,
  "limited_user_reset_date": null
}
```

`limited_user_quotas` is only non-null for free users who have exhausted their monthly quota (not the short-term window). For weekly/session rate limits (which is what most users hit in practice), this field stays `null`.

---

### 3. `POST https://api.individual.githubcopilot.com/chat/completions` (probe)

The only reliable way to detect and measure the short-term rate limit is to make a real CAPI request. Requires a Copilot session token (from `v2/token`), not a `gh` OAuth token.

**When rate limited → `HTTP 429`:**
```
retry-after: 6311
x-ratelimit-user-retry-after: 6311
x-ratelimit-exceeded: global-chat:global-usage-5-hour-key:userID:COPILOT_PLAN_INDIVIDUAL
```

- `retry-after` — seconds until rate limit resets
- `x-ratelimit-exceeded` — identifies the limit that was hit; the key name (`global-usage-5-hour-key`) reveals the window duration
- Body: `"Sorry, you've exceeded your 5 hour session limits."`

> **Important:** The rate limit window is **5 hours**, not 2 hours. A user seeing "resets in 2h 8m" is partway through their 5-hour window (2h52m elapsed when they hit it).

**When not rate limited → `HTTP 200`:**

Response headers contain window usage (only present with proper Copilot session auth, absent with `gh` tokens):

```
x-usage-ratelimit-session: ent=50&rem=67.5&rst=2026-06-01T14:00:00Z
x-usage-ratelimit-weekly:  ent=200&rem=89.0&rst=2026-06-07T00:00:00Z
x-quota-snapshot-chat:     ent=200&rem=99.9&rst=2026-06-30T21:00:00Z&ov=0&ovPerm=false
```

All use the same URL-params format:
- `ent` — total entitlement for the window
- `rem` — percent remaining (0–100)
- `rst` — ISO date when window resets
- `ov` — overage count (quota snapshots only)
- `ovPerm` — overage permitted (quota snapshots only)

`used % = 100 - rem`

---

## Authentication

### Token resolution chain (recommended order)

```
1. GITHUB_COPILOT_TOKEN env var           → full support
2. ~/.config/github-copilot/apps.json    → full support  
3. gh auth token / GITHUB_TOKEN env       → monthly quota only
```

### `~/.config/github-copilot/apps.json`

Written by:
- **JetBrains Copilot plugin** (IntelliJ, WebStorm, etc.)
- **GitHub Copilot CLI** (`npm install -g @github/copilot && copilot auth login`)

**Not** written by VS Code Copilot extension (VS Code uses its own encrypted secret storage).

File format:
```json
{
  "github.com:Ov23liV9UpD7Rnfnskm3": {
    "user": "username",
    "oauth_token": "gho_...",
    "githubAppId": "Ov23liV9UpD7Rnfnskm3"
  }
}
```

The token is a standard GitHub OAuth token issued by the Copilot app (app ID `Ov23liV9UpD7Rnfnskm3`). This is what unlocks `copilot_internal/v2/token`.

---

## The Two-Step Flow (for short-term rate limit)

```
apps.json OAuth token
       │
       ▼
GET /copilot_internal/v2/token
       │
       ├─ token:      "tid=..."   (CAPI session token)
       ├─ expires_at: <unix ts>
       └─ endpoints.api: "https://api.individual.githubcopilot.com"
              │
              ▼
POST {endpoints.api}/chat/completions
  body: { model: "gpt-5-mini", messages: [{"role":"user","content":"."}], max_tokens: 1 }
              │
              ├─ 200 → not rate limited
              │        check x-quota-snapshot-* and x-usage-ratelimit-* headers
              │
              └─ 429 → rate limited
                       retry-after: <seconds until reset>
```

---

## Quota Dimensions by Plan

| Dimension | Free tier | Individual paid | Business/Enterprise |
|---|---|---|---|
| `chat` | 200 / month | Unlimited | Unlimited |
| `completions` | 2000 / month | Unlimited | Unlimited |
| `premium_interactions` | 0 | ~300 / month | Varies |

Free tier uses `token_based_billing: true` — quota is measured in AIU (AI Units), not raw message count. The `remaining` field in `quota_snapshots` is the count in the relevant unit.

---

## Window Usage % — What's Actually Knowable

A common question: "how much of my 5-hour window have I used?" The answer is: **it depends on how much you've used.**

The CAPI does not have a dedicated `/quota` or `/rate_limits` status endpoint. Window usage info is only sent **reactively**, embedded in other responses:

| Usage level | What the API sends | % knowable? |
|---|---|---|
| < 50% of window used | No quota headers | ❌ Not available |
| ≥ 50% / ≥ 75% / ≥ 90% used | `x-usage-ratelimit-session` header on next 200 response | ✅ Available |
| 100% used (exhausted) | `429` with `retry-after` | ✅ 0% + reset time |

This is because the JetBrains/VS Code clients use these headers for **threshold warnings** ("You've used 50% of your session limit"), not continuous tracking. The server only injects them when a threshold is crossed:

```js
// JetBrains agent — checkThreshold fires at 50%, 75%, 90%
checkThreshold(this._sessionRateLimit, this._shownSessionThresholds, "session")
```

When headers ARE present, they use the URL-params format: `ent=N&rem=67.5&rst=<date>`.

**Practical implication for the MCP tool:** Show "✅ Not rate limited" below 50% usage, show `X% remaining` when the server volunteers it (≥50% usage), show `⛔ RATE LIMITED — resets in Xm` on 429.

## Caveats

1. **`copilot_internal/*` endpoints are not officially documented.** They're used internally by the official Copilot CLI SDK (`@github/copilot@1.0.37`), so they're stable relative to the product — but could change without notice.

2. **The short-term rate limit probe makes a real request.** A `429` costs nothing (immediate rejection), but a `200` consumes a minimal amount of quota (~0.001 AIU for a 1-token response). This is negligible in practice.

3. **`gh auth token` / `GITHUB_TOKEN` bypasses rate limiting.** The `gh` CLI's OAuth token is not issued by the Copilot app, so CAPI doesn't enforce Copilot rate limits on it. This means you can't detect rate limit status using the `gh` token — the CAPI probe always returns `200` regardless of the user's actual rate limit state.

4. **VS Code users are partially unsupported.** VS Code's Copilot extension stores its token in VS Code's encrypted secret storage, not in `apps.json`. Workaround: install the Copilot CLI (`npm install -g @github/copilot && copilot auth login`) which creates `apps.json`.

5. **`limited_user_quotas` in `/copilot_internal/user` is unreliable for rate limit detection.** In live testing with an actively rate-limited account, this field was `null`. Use the CAPI `429` probe instead.

6. **`quota_reset_at` in `quota_snapshots` was always `0` in testing.** The JetBrains agent uses it to show a per-snapshot rolling window reset time, but it didn't populate during our live rate limit session. May be model-specific or require certain conditions.

7. **Multiple accounts.** `apps.json` only stores one entry per GitHub host. If the user has multiple Copilot accounts (e.g. personal free + work enterprise), the tool reads whichever was last authenticated.

---

## Comparison to claude-status-mcp and codex-status-mcp

| | `claude-status-mcp` | `codex-status-mcp` | `copilot-status-mcp` |
|---|---|---|---|
| Token source | macOS keychain / `~/.claude/credentials.json` | N/A (spawns subprocess) | `apps.json` / `GITHUB_COPILOT_TOKEN` |
| Rate limit source | REST API | JSON-RPC over stdio | CAPI `429` probe |
| Needs running process | No | Yes (spawns `codex app-server`) | No |
| Short-term limit | N/A (monthly only) | Yes (primary + secondary windows) | Yes (via `retry-after`) |
| Monthly limit | Yes | N/A | Yes (via `/copilot_internal/user`) |

---

## POC

`copilot-quota-poc.ts` in the repo root. Run with:

```bash
npx tsx copilot-quota-poc.ts              # live check
npx tsx copilot-quota-poc.ts --raw        # include raw API responses
npx tsx copilot-quota-poc.ts --mock-rate-limited  # simulate exhausted state
```
