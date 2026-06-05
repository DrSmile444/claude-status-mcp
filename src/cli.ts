#!/usr/bin/env node
import { runMcpServer } from "./mcp.js";
import { getClaudeUsage, UsageApiError } from "./usage.js";

interface CliOptions {
  mcp: boolean;
  credentialsPath?: string;
  help: boolean;
  pretty: boolean;
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
  --pretty                   Render usage as a human-readable summary with progress bars.
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
    pretty: false,
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
      case "--pretty":
        options.pretty = true;
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

function humanDiff(isoDate: string): string {
  const diffSecs = Math.round((new Date(isoDate).getTime() - Date.now()) / 1000);
  if (diffSecs <= 0) return "already passed";
  const h = Math.floor(diffSecs / 3600);
  const m = Math.floor((diffSecs % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function progressBar(utilization: number, width = 20): string {
  const filled = Math.round((Math.min(Math.max(utilization, 0), 100) / 100) * width);
  return `[${"█".repeat(filled)}${"░".repeat(width - filled)}]`;
}

function printPretty(data: { usage: Record<string, unknown>; tokenSource: string }): void {
  const divider = "━".repeat(40);
  let out = "";

  out += `${divider}\n`;
  out += ` Claude Usage\n`;
  out += `${divider}\n`;
  out += ` Token source : ${data.tokenSource}\n`;
  out += `${divider}\n`;

  const { five_hour, seven_day, seven_day_sonnet, extra_usage } = data.usage as {
    five_hour?: { utilization: number | null; resets_at: string };
    seven_day?: { utilization: number | null; resets_at: string };
    seven_day_sonnet?: { utilization: number | null; resets_at: string };
    extra_usage?: { is_enabled: boolean; monthly_limit: number | null; used_credits: number | null; utilization: number | null };
  };

  if (five_hour != null && five_hour.utilization != null) {
    const pct = five_hour.utilization;
    out += ` 5h window\n`;
    out += `   ${progressBar(pct)} ${pct}%\n`;
    out += `   Resets in ${humanDiff(five_hour.resets_at)} (${five_hour.resets_at})\n`;
    out += `${divider}\n`;
  }

  if (seven_day != null && seven_day.utilization != null) {
    const pct = seven_day.utilization;
    out += ` 7d window\n`;
    out += `   ${progressBar(pct)} ${pct}%\n`;
    out += `   Resets in ${humanDiff(seven_day.resets_at)} (${seven_day.resets_at})\n`;
    out += `${divider}\n`;
  }

  if (seven_day_sonnet != null && seven_day_sonnet.utilization != null) {
    const pct = seven_day_sonnet.utilization;
    out += ` 7d Sonnet window\n`;
    out += `   ${progressBar(pct)} ${pct}%\n`;
    out += `   Resets in ${humanDiff(seven_day_sonnet.resets_at)} (${seven_day_sonnet.resets_at})\n`;
    out += `${divider}\n`;
  }

  if (extra_usage != null && extra_usage.is_enabled) {
    out += ` Extra usage\n`;
    if (extra_usage.used_credits != null) {
      out += `   Credits used : ${extra_usage.used_credits}`;
      if (extra_usage.monthly_limit != null) {
        out += ` / ${extra_usage.monthly_limit}`;
      }
      out += "\n";
    }
    if (extra_usage.utilization != null) {
      out += `   ${progressBar(extra_usage.utilization)} ${extra_usage.utilization}%\n`;
    }
    out += `${divider}\n`;
  }

  process.stdout.write(out);
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

  if (options.pretty) {
    printPretty(usage as { usage: Record<string, unknown>; tokenSource: string });
  } else {
    process.stdout.write(`${JSON.stringify(usage, null, 2)}\n`);
  }

  process.exit(0);
}

main().catch((error) => {
  printError(error);
  process.exitCode = 1;
});
