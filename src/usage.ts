import { getAccessToken, type AccessTokenOptions, type TokenSource } from "./credentials.js";

const DEFAULT_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const DEFAULT_OAUTH_BETA = "oauth-2025-04-20";

export class UsageApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly responseBody?: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "UsageApiError";
  }
}

export interface ClaudeUsageOptions extends AccessTokenOptions {
  usageUrl?: string;
}

export interface ClaudeUsageResult {
  usage: unknown;
  tokenSource: TokenSource;
  credentialsPath?: string;
}

export async function getClaudeUsage(options: ClaudeUsageOptions = {}): Promise<ClaudeUsageResult> {
  const token = await getAccessToken(options);
  const usageUrl = options.usageUrl ?? process.env.CLAUDE_USAGE_API_URL ?? DEFAULT_USAGE_URL;

  const response = await fetch(usageUrl, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token.accessToken}`,
      "anthropic-beta": DEFAULT_OAUTH_BETA,
      "Content-Type": "application/json",
    },
  });

  const responseBody = await response.text();
  if (!response.ok) {
    throw new UsageApiError(
      `Claude usage API returned HTTP ${response.status}.`,
      response.status,
      responseBody,
    );
  }

  let usage: unknown;
  try {
    usage = responseBody.length > 0 ? JSON.parse(responseBody) : null;
  } catch (error) {
    throw new UsageApiError("Claude usage API returned invalid JSON.", response.status, responseBody, {
      cause: error,
    });
  }

  return {
    usage,
    tokenSource: token.source,
    credentialsPath: token.credentialsPath,
  };
}
