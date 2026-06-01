#!/usr/bin/env npx tsx
/**
 * POC: GitHub Copilot quota + short-term rate limit detection
 *
 * Two-token flow:
 *   1. Copilot OAuth token  → from ~/.config/github-copilot/apps.json (JetBrains/CLI)
 *                             or GITHUB_COPILOT_TOKEN env var
 *   2. Exchange → CAPI session token  via GET /copilot_internal/v2/token
 *   3. Probe CAPI  →  /chat/completions with max_tokens=1
 *      - 200: not rate limited  (may include x-usage-ratelimit-* headers when near limit)
 *      - 429: rate limited      retry-after header = seconds until reset
 *
 * Monthly quota comes from GET /copilot_internal/user (works with any gh token).
 */

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// ── Types ─────────────────────────────────────────────────────────────────────

interface CopilotTokenEnvelope {
  token: string;
  expires_at: number;
  refresh_in: number;
  sku?: string;
  endpoints?: { api?: string; proxy?: string };
  limited_user_quotas?: { chat?: number; completions?: number } | null;
  limited_user_reset_date?: number | string | null;
}

interface CopilotUserResponse {
  login?: string;
  access_type_sku?: string;
  copilot_plan?: string;
  chat_enabled?: boolean;
  quota_snapshots?: {
    chat?: { remaining?: number; entitlement?: number; percent_remaining?: number; unlimited?: boolean };
    completions?: { remaining?: number; entitlement?: number; percent_remaining?: number; unlimited?: boolean };
    premium_interactions?: { remaining?: number; entitlement?: number; percent_remaining?: number; unlimited?: boolean };
  };
  quota_reset_date_utc?: string;
  quota_reset_date?: string;
  limited_user_quotas?: { chat?: number; completions?: number } | null;
  limited_user_reset_date?: number | string | null;
}

interface RateLimitProbeResult {
  rateLimited: boolean;
  retryAfterSecs?: number;       // from retry-after header (429)
  resetsAt?: Date;
  weeklyLimitInfo?: string;      // from x-usage-ratelimit-weekly header (200)
  sessionLimitInfo?: string;     // from x-usage-ratelimit-session header (200)
  quotaSnapshots?: {             // from x-quota-snapshot-* headers (200)
    chat?: string;
    completions?: string;
  };
}

// ── Token resolution ──────────────────────────────────────────────────────────

interface CopilotOAuthToken {
  token: string;
  source: string;
  user?: string;
}

async function readAppsJson(): Promise<CopilotOAuthToken | undefined> {
  const path = resolve(homedir(), ".config/github-copilot/apps.json");
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as Record<string, { oauth_token?: string; user?: string }>;
    const entries = Object.values(parsed);
    if (entries.length === 0) return undefined;
    const entry = entries[0];
    if (!entry.oauth_token) return undefined;
    return { token: entry.oauth_token, source: path, user: entry.user };
  } catch {
    return undefined;
  }
}

async function getGhToken(): Promise<string | undefined> {
  const env = process.env.GITHUB_TOKEN?.trim();
  if (env) return env;
  try {
    const { stdout } = await execFileAsync("gh", ["auth", "token"], { timeout: 10_000 });
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

async function getCopilotOAuthToken(): Promise<CopilotOAuthToken> {
  const envToken = process.env.GITHUB_COPILOT_TOKEN?.trim();
  if (envToken) {
    return { token: envToken, source: "GITHUB_COPILOT_TOKEN env" };
  }

  const fromApps = await readAppsJson();
  if (fromApps) return fromApps;

  throw new Error(
    "No Copilot OAuth token found.\n" +
    "  Option 1: Set GITHUB_COPILOT_TOKEN env var\n" +
    "  Option 2: Install JetBrains Copilot plugin (creates ~/.config/github-copilot/apps.json)\n" +
    "  Option 3: Install GitHub Copilot CLI and authenticate"
  );
}

// ── Get CAPI session token ────────────────────────────────────────────────────

async function getCAPISessionToken(oauthToken: string): Promise<CopilotTokenEnvelope> {
  const resp = await fetch("https://api.github.com/copilot_internal/v2/token", {
    headers: {
      Authorization: `token ${oauthToken}`,
      "Editor-Version": "JetBrains-IC/2025.2.0",
      "Editor-Plugin-Version": "copilot/1.5.37.8720",
      "User-Agent": "GithubCopilot/1.5.37.8720",
    },
  });

  if (!resp.ok) {
    throw new Error(`Failed to get CAPI session token: HTTP ${resp.status}`);
  }

  return resp.json() as Promise<CopilotTokenEnvelope>;
}

// ── Probe CAPI for rate limit ─────────────────────────────────────────────────

async function probeCAPIRateLimit(
  sessionToken: string,
  apiBase: string,
): Promise<RateLimitProbeResult> {
  const resp = await fetch(`${apiBase}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${sessionToken}`,
      "Content-Type": "application/json",
      "Copilot-Integration-Id": "vscode-chat",
      "Editor-Version": "vscode/1.95.0",
      "Editor-Plugin-Version": "copilot-chat/0.48.1",
    },
    body: JSON.stringify({
      model: "gpt-5-mini",
      messages: [{ role: "user", content: "." }],
      max_tokens: 1,
      stream: false,
    }),
  });

  if (resp.status === 429) {
    const retryAfterSecs = Number(resp.headers.get("retry-after") ?? resp.headers.get("x-ratelimit-user-retry-after") ?? "0");
    const resetsAt = retryAfterSecs > 0 ? new Date(Date.now() + retryAfterSecs * 1000) : undefined;
    return { rateLimited: true, retryAfterSecs, resetsAt };
  }

  // 200 — check for soft-limit warning headers
  return {
    rateLimited: false,
    weeklyLimitInfo: resp.headers.get("x-usage-ratelimit-weekly") ?? undefined,
    sessionLimitInfo: resp.headers.get("x-usage-ratelimit-session") ?? undefined,
    quotaSnapshots: {
      chat: resp.headers.get("x-quota-snapshot-chat") ?? undefined,
      completions: resp.headers.get("x-quota-snapshot-completions") ?? undefined,
    },
  };
}

// ── Get monthly quota ─────────────────────────────────────────────────────────

async function getCopilotUserInfo(oauthToken: string): Promise<CopilotUserResponse> {
  const resp = await fetch("https://api.github.com/copilot_internal/user", {
    headers: {
      Authorization: `Bearer ${oauthToken}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!resp.ok) throw new Error(`/copilot_internal/user returned HTTP ${resp.status}`);
  return resp.json() as Promise<CopilotUserResponse>;
}

// ── Formatting helpers ────────────────────────────────────────────────────────

function humanDiff(date: Date): string {
  const diffSecs = Math.round((date.getTime() - Date.now()) / 1000);
  if (diffSecs <= 0) return "already passed";
  const h = Math.floor(diffSecs / 3600);
  const m = Math.floor((diffSecs % 3600) / 60);
  const s = diffSecs % 60;
  return h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function fmt(remaining: number | undefined, entitlement: number | undefined): string {
  if (remaining == null) return "N/A";
  return entitlement != null ? `${remaining} / ${entitlement}` : String(remaining);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const isMock = process.argv.includes("--mock-rate-limited");
  const showRaw = process.argv.includes("--raw");

  // ── Step 1: get tokens ────────────────────────────────────────────────────

  let copilotOAuth: CopilotOAuthToken;
  let sessionEnvelope: CopilotTokenEnvelope | undefined;
  let ghToken: string | undefined;

  try {
    copilotOAuth = await getCopilotOAuthToken();
    console.log(`\n🔑 Copilot OAuth token: ${copilotOAuth.source} (user: ${copilotOAuth.user ?? "unknown"})`);
    sessionEnvelope = await getCAPISessionToken(copilotOAuth.token);
    ghToken = copilotOAuth.token;
  } catch (e) {
    console.log(`\n⚠  No Copilot OAuth token: ${(e as Error).message}`);
    ghToken = await getGhToken();
    if (!ghToken) throw new Error("No GitHub token found at all.");
    console.log("🔑 Falling back to gh auth token (short-term rate limit unavailable)");
  }

  // ── Step 2: monthly quota (always available) ──────────────────────────────

  const userInfo = ghToken ? await getCopilotUserInfo(ghToken) : null;

  // ── Step 3: rate limit probe (requires CAPI session token) ────────────────

  let probe: RateLimitProbeResult | undefined;

  if (sessionEnvelope) {
    const apiBase = sessionEnvelope.endpoints?.api ?? "https://api.individual.githubcopilot.com";

    if (isMock) {
      // Simulate a live rate limit
      probe = {
        rateLimited: true,
        retryAfterSecs: 2 * 3600 + 8 * 60,
        resetsAt: new Date(Date.now() + (2 * 3600 + 8 * 60) * 1000),
      };
    } else {
      console.log("⏳ Probing CAPI for rate limit status...");
      probe = await probeCAPIRateLimit(sessionEnvelope.token, apiBase);
    }
  }

  // ── Display ───────────────────────────────────────────────────────────────

  const u = userInfo;
  const isFree = u?.access_type_sku === "free_limited_copilot";

  console.log("\n━━━ Account ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(`  Login:  ${u?.login ?? sessionEnvelope?.sku ?? "N/A"}`);
  console.log(`  Plan:   ${u?.copilot_plan ?? "N/A"}`);
  console.log(`  SKU:    ${u?.access_type_sku ?? sessionEnvelope?.sku ?? "N/A"} ${isFree ? "(free tier)" : ""}`);

  // ── Short-term rate limit ─────────────────────────────────────────────────

  console.log("\n━━━ Short-Term Rate Limit ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  if (!probe) {
    console.log("  ⚠  Could not probe (no Copilot session token — install JetBrains Copilot or set GITHUB_COPILOT_TOKEN)");
  } else if (probe.rateLimited) {
    const resetStr = probe.resetsAt ? probe.resetsAt.toISOString() : "unknown";
    const diffStr = probe.resetsAt ? humanDiff(probe.resetsAt) : "unknown";
    console.log(`  ⛔  RATE LIMITED`);
    console.log(`  Resets at:  ${resetStr}`);
    console.log(`  Resets in:  ${diffStr}`);
    if (probe.retryAfterSecs) {
      console.log(`  retry-after: ${probe.retryAfterSecs}s`);
    }
  } else {
    console.log("  ✅  Not rate limited");
    if (probe.weeklyLimitInfo) {
      console.log(`  Weekly limit header:  ${probe.weeklyLimitInfo}`);
    }
    if (probe.sessionLimitInfo) {
      console.log(`  Session limit header: ${probe.sessionLimitInfo}`);
    }
    if (probe.quotaSnapshots?.chat) {
      console.log(`  x-quota-snapshot-chat: ${probe.quotaSnapshots.chat}`);
    }
  }

  // ── Monthly quota ─────────────────────────────────────────────────────────

  console.log("\n━━━ Monthly Quota ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  if (!u) {
    console.log("  (no user info available)");
  } else {
    const snaps = u.quota_snapshots;
    const resetUtc = u.quota_reset_date_utc ?? u.quota_reset_date;

    if (snaps?.chat) {
      const c = snaps.chat;
      console.log(`  Chat:               ${fmt(c.remaining, c.entitlement)} (${c.percent_remaining?.toFixed(1) ?? "?"}% remaining${c.unlimited ? ", unlimited" : ""})`);
    }
    if (snaps?.completions) {
      const c = snaps.completions;
      console.log(`  Completions:        ${fmt(c.remaining, c.entitlement)} (${c.percent_remaining?.toFixed(1) ?? "?"}% remaining${c.unlimited ? ", unlimited" : ""})`);
    }
    if (snaps?.premium_interactions) {
      const c = snaps.premium_interactions;
      console.log(`  Premium models:     ${fmt(c.remaining, c.entitlement)} (${c.percent_remaining?.toFixed(1) ?? "?"}% remaining${c.unlimited ? ", unlimited" : ""})`);
    }
    console.log(`  Monthly resets at:  ${resetUtc ?? "N/A"}`);
    if (resetUtc) {
      const d = new Date(resetUtc);
      console.log(`  Monthly resets in:  ${humanDiff(d)}`);
    }

    // Also check limited_user_quotas from user endpoint (free-user monthly exhaustion path)
    if (u.limited_user_quotas != null) {
      console.log("\n  (limited_user_quotas from /user endpoint — free-tier monthly exhaustion)");
      console.log(`  Chat remaining:  ${u.limited_user_quotas.chat ?? "N/A"}`);
      console.log(`  Compl remaining: ${u.limited_user_quotas.completions ?? "N/A"}`);
      if (u.limited_user_reset_date) {
        const resetDate = typeof u.limited_user_reset_date === "number"
          ? new Date(u.limited_user_reset_date * 1000)
          : new Date(u.limited_user_reset_date);
        console.log(`  Resets at:       ${resetDate.toISOString()} (in ${humanDiff(resetDate)})`);
      }
    }
  }

  if (showRaw) {
    console.log("\n━━━ Raw session envelope ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    if (sessionEnvelope) {
      const { token: _, ...rest } = sessionEnvelope;
      console.log(JSON.stringify(rest, null, 2));
    }
    console.log("\n━━━ Raw user info ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log(JSON.stringify(u, null, 2));
  }

  console.log();
}

main().catch((err: unknown) => {
  console.error("Error:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
