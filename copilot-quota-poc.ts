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

interface WindowQuota {
  entitlement: number;       // total limit for the window
  percentRemaining: number;  // 0–100
  percentUsed: number;
  resetDate: string;         // ISO string or empty
  resetsAt?: Date;
}

interface RateLimitProbeResult {
  rateLimited: boolean;
  retryAfterSecs?: number;        // from retry-after header (429)
  resetsAt?: Date;
  limitKey?: string;              // from x-ratelimit-exceeded (429), e.g. "global-usage-5-hour-key"
  // 200-response window quota (only present with proper Copilot session auth):
  sessionQuota?: WindowQuota;     // from x-usage-ratelimit-session
  weeklyQuota?: WindowQuota;      // from x-usage-ratelimit-weekly
  chatSnapshotQuota?: WindowQuota; // from x-quota-snapshot-chat
}

// ── Header parsers ────────────────────────────────────────────────────────────

// Parses "ent=200&rem=67.5&rst=2026-06-01T14:00:00Z" format
// Used by: x-usage-ratelimit-session, x-usage-ratelimit-weekly, x-quota-snapshot-chat
function parseWindowHeader(raw: string | null): WindowQuota | undefined {
  if (!raw) return undefined;
  try {
    const p = new URLSearchParams(raw);
    const ent = Number.parseInt(p.get("ent") ?? "0", 10);
    const rem = Number.parseFloat(p.get("rem") ?? "100");
    const rst = p.get("rst") ?? "";
    const resetsAt = rst ? new Date(rst) : undefined;
    return {
      entitlement: ent,
      percentRemaining: rem,
      percentUsed: Math.max(0, 100 - rem),
      resetDate: rst,
      resetsAt,
    };
  } catch {
    return undefined;
  }
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
  const interactionId = crypto.randomUUID();
  const resp = await fetch(`${apiBase}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${sessionToken}`,
      "Content-Type": "application/json",
      "Copilot-Integration-Id": "vscode-chat",
      "Editor-Version": "vscode/1.95.0",
      "Editor-Plugin-Version": "copilot-chat/0.48.1",
      "X-GitHub-Api-Version": "2025-05-01",
      "X-Interaction-Id": interactionId,
      "X-Initiator": "user",
      "OpenAI-Intent": "conversation-panel",
    },
    body: JSON.stringify({
      model: "gpt-5-mini",
      messages: [{ role: "user", content: "." }],
      max_tokens: 1,
      stream: false,
    }),
  });

  if (resp.status === 429) {
    const retryAfterSecs = Number(
      resp.headers.get("retry-after") ??
      resp.headers.get("x-ratelimit-user-retry-after") ??
      "0"
    );
    const resetsAt = retryAfterSecs > 0 ? new Date(Date.now() + retryAfterSecs * 1000) : undefined;
    // x-ratelimit-exceeded: "global-chat:global-usage-5-hour-key:userID:COPILOT_PLAN_INDIVIDUAL"
    const exceeded = resp.headers.get("x-ratelimit-exceeded") ?? undefined;
    const limitKey = exceeded?.split(":")?.[1]; // e.g. "global-usage-5-hour-key"
    return { rateLimited: true, retryAfterSecs, resetsAt, limitKey };
  }

  // 200 — parse window quota headers (% used in current window)
  // These only appear with proper Copilot session auth, not with gh/OAuth tokens
  const sessionQuota = parseWindowHeader(resp.headers.get("x-usage-ratelimit-session"));
  const weeklyQuota  = parseWindowHeader(resp.headers.get("x-usage-ratelimit-weekly"));
  const chatSnapshotQuota = parseWindowHeader(
    resp.headers.get("x-quota-snapshot-chat") ??
    resp.headers.get("x-quota-snapshot-premium_interactions")
  );
  return { rateLimited: false, sessionQuota, weeklyQuota, chatSnapshotQuota };
}

// Returns the next Monday 00:00 UTC — the weekly quota reset boundary
function nextWeeklyReset(): Date {
  const now = new Date();
  const day = now.getUTCDay(); // 0=Sun, 1=Mon, ..., 6=Sat
  const daysUntilMonday = day === 1 ? 7 : (8 - day) % 7;
  const reset = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + daysUntilMonday));
  return reset;
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

function buildBar(usedPercent: number, width = 20): string {
  const filled = Math.round((usedPercent / 100) * width);
  return `[${"█".repeat(filled)}${"░".repeat(width - filled)}]`;
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

    const isMockNotLimited = process.argv.includes("--mock-not-limited");

    if (isMock) {
      probe = {
        rateLimited: true,
        retryAfterSecs: 2 * 3600 + 8 * 60,
        resetsAt: new Date(Date.now() + (2 * 3600 + 8 * 60) * 1000),
        limitKey: "global-usage-5-hour-key",
      };
    } else if (isMockNotLimited) {
      // Simulate a 200 response at 50% through the window
      const windowResetsIn = 2.5 * 3600; // 2.5 hours left in 5h window
      probe = {
        rateLimited: false,
        sessionQuota: {
          entitlement: 0,
          percentRemaining: 50.0,
          percentUsed: 50.0,
          resetDate: new Date(Date.now() + windowResetsIn * 1000).toISOString(),
          resetsAt: new Date(Date.now() + windowResetsIn * 1000),
        },
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
    const weeklyReset = nextWeeklyReset();
    console.log(`  ⛔  RATE LIMITED — 0% remaining`);
    console.log(`  5h session resets at: ${resetStr} (in ${diffStr})`);
    if (probe.retryAfterSecs) console.log(`  retry-after:          ${probe.retryAfterSecs}s`);
    if (probe.limitKey)       console.log(`  Limit key:            ${probe.limitKey}`);
    console.log(`  Weekly resets at:     ${weeklyReset.toISOString()} (in ${humanDiff(weeklyReset)}) — usage % unavailable while rate limited`);
  } else {
    // Pick the most informative window quota available
    const wq = probe.sessionQuota ?? probe.weeklyQuota ?? probe.chatSnapshotQuota;
    if (wq) {
      console.log(`  ✅  Not rate limited`);
      if (wq.entitlement > 0) console.log(`  Window limit:      ${wq.entitlement}`);
      if (probe.sessionQuota) {
        const s = probe.sessionQuota;
        const bar = buildBar(s.percentUsed);
        console.log(`  5h session:        ${s.percentUsed.toFixed(1)}% used  ${bar}  ${s.percentRemaining.toFixed(1)}% remaining`);
        if (s.resetsAt) console.log(`  Session resets at: ${s.resetsAt.toISOString()} (in ${humanDiff(s.resetsAt)})`);
      }
      if (probe.weeklyQuota) {
        const w = probe.weeklyQuota;
        const bar = buildBar(w.percentUsed);
        console.log(`  Weekly:            ${w.percentUsed.toFixed(1)}% used  ${bar}  ${w.percentRemaining.toFixed(1)}% remaining`);
        if (w.resetsAt) console.log(`  Weekly resets at:  ${w.resetsAt.toISOString()} (in ${humanDiff(w.resetsAt)})`);
      }
      if (!probe.sessionQuota && !probe.weeklyQuota && wq.resetsAt) {
        console.log(`  Window resets at:  ${wq.resetsAt.toISOString()} (in ${humanDiff(wq.resetsAt)})`);
      }
    } else {
      console.log("  ✅  Not rate limited");
      console.log("  Window usage:  unavailable (quota headers absent — gh token bypasses Copilot rate limiting)");
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
