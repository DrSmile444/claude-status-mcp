import { execFile } from "node:child_process";
import { homedir, platform } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";

const execFileAsync = promisify(execFile);

const MACOS_KEYCHAIN_SERVICE = "Claude Code-credentials";
const DEFAULT_CREDENTIALS_PATH = "~/.claude/credentials.json";

export class CredentialError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CredentialError";
  }
}

export type TokenSource = "environment" | "macos-keychain" | "credentials-file";

export interface AccessTokenResult {
  accessToken: string;
  source: TokenSource;
  credentialsPath?: string;
}

export interface AccessTokenOptions {
  credentialsPath?: string;
}

function expandHome(path: string): string {
  if (path === "~") {
    return homedir();
  }

  if (path.startsWith("~/") || path.startsWith("~\\")) {
    return resolve(homedir(), path.slice(2));
  }

  return path;
}

function getDefaultCredentialsPath(): string {
  return expandHome(DEFAULT_CREDENTIALS_PATH);
}

function readNestedAccessToken(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const root = value as Record<string, unknown>;
  const candidates = [
    root.claudeAiOauth,
    root.claude_ai_oauth,
    root.oauth,
    root,
  ];

  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") {
      continue;
    }

    const accessToken = (candidate as Record<string, unknown>).accessToken;
    if (typeof accessToken === "string" && accessToken.trim().length > 0) {
      return accessToken.trim();
    }
  }

  return undefined;
}

async function readTokenFromEnvironment(): Promise<AccessTokenResult | undefined> {
  const accessToken = process.env.CLAUDE_OAUTH_ACCESS_TOKEN?.trim();
  if (!accessToken) {
    return undefined;
  }

  return {
    accessToken,
    source: "environment",
  };
}

async function readTokenFromMacosKeychain(): Promise<AccessTokenResult | undefined> {
  if (platform() !== "darwin") {
    return undefined;
  }

  try {
    const { stdout } = await execFileAsync("security", [
      "find-generic-password",
      "-s",
      MACOS_KEYCHAIN_SERVICE,
      "-w",
    ]);

    const raw = stdout.trim();
    if (!raw) {
      return undefined;
    }

    const parsed = JSON.parse(raw) as unknown;
    const accessToken = readNestedAccessToken(parsed);
    if (!accessToken) {
      throw new CredentialError(
        `macOS keychain item "${MACOS_KEYCHAIN_SERVICE}" did not contain claudeAiOauth.accessToken.`,
      );
    }

    return {
      accessToken,
      source: "macos-keychain",
    };
  } catch (error) {
    if (error instanceof CredentialError) {
      throw error;
    }

    return undefined;
  }
}

async function readTokenFromCredentialsFile(path: string): Promise<AccessTokenResult | undefined> {
  const credentialsPath = expandHome(path);

  try {
    const contents = await readFile(credentialsPath, "utf8");
    const parsed = JSON.parse(contents) as unknown;
    const accessToken = readNestedAccessToken(parsed);
    if (!accessToken) {
      throw new CredentialError(
        `${credentialsPath} did not contain claudeAiOauth.accessToken.`,
      );
    }

    return {
      accessToken,
      source: "credentials-file",
      credentialsPath,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }

    if (error instanceof SyntaxError) {
      throw new CredentialError(`${credentialsPath} is not valid JSON.`, { cause: error });
    }

    if (error instanceof CredentialError) {
      throw error;
    }

    throw new CredentialError(`Unable to read ${credentialsPath}.`, { cause: error });
  }
}

export async function getAccessToken(options: AccessTokenOptions = {}): Promise<AccessTokenResult> {
  const credentialsPath = options.credentialsPath ?? getDefaultCredentialsPath();
  const readers = [
    readTokenFromEnvironment,
    readTokenFromMacosKeychain,
    () => readTokenFromCredentialsFile(credentialsPath),
  ];

  for (const reader of readers) {
    const result = await reader();
    if (result) {
      return result;
    }
  }

  throw new CredentialError(
    [
      "Unable to find a Claude OAuth access token.",
      "Set CLAUDE_OAUTH_ACCESS_TOKEN, add the macOS Claude Code keychain item,",
      `or create ${credentialsPath}.`,
    ].join(" "),
  );
}
