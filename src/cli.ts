#!/usr/bin/env node
import { runMcpServer } from "./mcp.js";
import { getClaudeUsage, UsageApiError } from "./usage.js";

interface CliOptions {
  mcp: boolean;
  credentialsPath?: string;
  help: boolean;
}

function printHelp(): void {
  process.stdout.write(`claude-status-mcp

Fetch current Claude OAuth usage or run as an MCP stdio server.

Usage:
  claude-status-mcp [--credentials-path <path>]
  claude-status-mcp --mcp
  claude-status-mcp --help

Options:
  --credentials-path <path>  Read Claude credentials from a custom JSON file.
  --mcp                      Run the MCP server over stdio.
  --help                     Show this help message.

Token lookup order:
  1. CLAUDE_OAUTH_ACCESS_TOKEN
  2. macOS Keychain service "Claude Code-credentials" on macOS
  3. ~/.claude/credentials.json
`);
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    mcp: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    switch (arg) {
      case "--mcp":
        options.mcp = true;
        break;
      case "--credentials-path":
        index += 1;
        if (!argv[index]) {
          throw new Error("--credentials-path requires a value.");
        }
        options.credentialsPath = argv[index];
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  return options;
}

function printError(error: unknown): void {
  if (error instanceof UsageApiError && error.responseBody) {
    process.stderr.write(`${error.message}\n${error.responseBody}\n`);
    return;
  }

  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    printHelp();
    return;
  }

  if (options.mcp) {
    await runMcpServer();
    return;
  }

  const usage = await getClaudeUsage({
    credentialsPath: options.credentialsPath,
  });

  process.stdout.write(`${JSON.stringify(usage, null, 2)}\n`);
}

main().catch((error) => {
  printError(error);
  process.exitCode = 1;
});
