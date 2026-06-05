# claude-status-mcp

Check your current Claude usage from the terminal, Claude Code, Codex, or any MCP client.

`claude-status-mcp` solves a small but annoying problem: Claude Code already has an OAuth session on your machine, but your current usage limits are not easy to query from a terminal or another agent. At the moment, Claude Code does not provide a native command for retrieving this usage data. For example, asking Claude with something like `claude -p /usage` will not return the structured usage information from Anthropic's usage endpoint.

```sh
claude mcp add --scope user claude-status-mcp -- npx -y claude-status-mcp --mcp
```

This package fills that gap. It finds the local Claude OAuth token, calls Anthropic's OAuth usage API, and returns the usage JSON directly.

## Demo

<img src="https://raw.githubusercontent.com/DrSmile444/claude-status-mcp/main/docs/claude-usage-demo.png" alt="Claude usage shown as a table in an MCP client" width="540">

## Features

- Reads Claude OAuth credentials from the places Claude Code already uses.
- Works on macOS, Linux, and Windows-style credential file setups.
- Exposes a single MCP tool: `get_claude_usage`.
- Runs without a daemon, database, or extra service.
- Does not store, log, or refresh your token.
- Supports explicit tokens through `CLAUDE_OAUTH_ACCESS_TOKEN`.

## Quick Start

Print your current usage in a terminal:

```sh
npx claude-status-mcp
```

Add it to Claude Code:

```sh
claude mcp add --scope user claude-status-mcp -- npx -y claude-status-mcp --mcp
```

Add it to Codex:

```sh
codex mcp add claude-status-mcp -- npx -y claude-status-mcp --mcp
```

After adding the MCP server, restart Claude Code or Codex. Most MCP clients load servers when a new session starts.

Then ask your MCP client something like:

```text
What is my current Claude usage?
```

## Requirements

- Node.js 18 or newer.
- Claude Code credentials on the machine, or a token provided through `CLAUDE_OAUTH_ACCESS_TOKEN`.

Token lookup order:

1. `CLAUDE_OAUTH_ACCESS_TOKEN`
2. macOS Keychain service `Claude Code-credentials`
3. `~/.claude/credentials.json`

The credentials file should contain:

```json
{
  "claudeAiOauth": {
    "accessToken": "sk-ant-..."
  }
}
```

## CLI Usage

Run once with `npx`:

```sh
npx claude-status-mcp
```

Example output:

```json
{
  "usage": {
    "five_hour": {
      "utilization": 42,
      "resets_at": "2026-05-19T12:30:00.000000+00:00"
    },
    "seven_day": {
      "utilization": 18,
      "resets_at": "2026-05-23T07:00:00.000000+00:00"
    }
  },
  "tokenSource": "macos-keychain"
}
```

Use a custom credentials file:

```sh
npx claude-status-mcp --credentials-path /path/to/credentials.json
```

Use an explicit token:

```sh
CLAUDE_OAUTH_ACCESS_TOKEN="sk-ant-..." npx claude-status-mcp
```

Show CLI help:

```sh
npx claude-status-mcp --help
```

## MCP Setup

The MCP server exposes one tool:

```text
get_claude_usage
```

It returns the same JSON as the CLI. The tool accepts one optional argument:

```json
{
  "credentialsPath": "/path/to/credentials.json"
}
```

### Claude Code

Add the published package:

```sh
claude mcp add --scope user claude-status-mcp -- npx -y claude-status-mcp --mcp
```

Verify:

```sh
claude mcp list
claude mcp get claude-status-mcp
```

Equivalent MCP JSON:

```json
{
  "mcpServers": {
    "claude-status-mcp": {
      "command": "npx",
      "args": ["-y", "claude-status-mcp", "--mcp"]
    }
  }
}
```

### Codex

Add the published package:

```sh
codex mcp add claude-status-mcp -- npx -y claude-status-mcp --mcp
```

Verify:

```sh
codex mcp list
codex mcp get claude-status-mcp --json
```

Codex writes this to `~/.codex/config.toml`:

```toml
[mcp_servers.claude-status-mcp]
command = "npx"
args = ["-y", "claude-status-mcp", "--mcp"]
```

### Other MCP Clients

Use the same stdio server command:

```json
{
  "mcpServers": {
    "claude-status-mcp": {
      "command": "npx",
      "args": ["-y", "claude-status-mcp", "--mcp"]
    }
  }
}
```

## How It Works

`claude-status-mcp` is a thin wrapper around Claude Code's existing OAuth session.

When you run the CLI or call the MCP tool, it finds an access token from your environment, the macOS Keychain, or a Claude credentials file. Then it sends one authenticated request to Anthropic's OAuth usage endpoint:

```text
GET https://api.anthropic.com/api/oauth/usage
```

The API response is returned as JSON. In CLI mode, it is printed to stdout. In MCP mode, it is returned from `get_claude_usage` so Claude Code, Codex, or another MCP client can inspect it during a session.

There is no background process in CLI mode. The command reads credentials, calls the API, prints the result, and exits. In MCP mode, the process stays alive because the MCP client manages it over stdio.

## Test With Raw Shell

You can test the underlying API call without this package.

On macOS, read the token from Claude Code's Keychain item:

```sh
export CLAUDE_OAUTH_ACCESS_TOKEN="$(
  security find-generic-password -s "Claude Code-credentials" -w \
    | node -e 'let input=""; process.stdin.on("data", c => input += c); process.stdin.on("end", () => console.log(JSON.parse(input).claudeAiOauth.accessToken));'
)"
```

On Linux or Windows, read the token from the credentials file:

```sh
export CLAUDE_OAUTH_ACCESS_TOKEN="$(
  node -e 'const fs = require("fs"); const path = require("os").homedir() + "/.claude/credentials.json"; console.log(JSON.parse(fs.readFileSync(path, "utf8")).claudeAiOauth.accessToken);'
)"
```

Or set a token directly:

```sh
export CLAUDE_OAUTH_ACCESS_TOKEN="sk-ant-..."
```

Then call the usage API:

```sh
curl --request GET \
  --url https://api.anthropic.com/api/oauth/usage \
  --header "Authorization: Bearer $CLAUDE_OAUTH_ACCESS_TOKEN" \
  --header "anthropic-beta: oauth-2025-04-20" \
  --header "Content-Type: application/json"
```

## Local Checkout Setup

Use these commands when working from a cloned copy of this repository before publishing to npm.

Install and build:

```sh
npm install
npm run build
```

Run the local CLI:

```sh
node dist/cli.js
```

Run the local MCP server:

```sh
node dist/cli.js --mcp
```

### Claude Code From Local Checkout

Use the compiled entrypoint:

```sh
claude mcp add --scope user claude-status-mcp -- node /absolute/path/to/claude-status-mcp/dist/cli.js --mcp
```

Or run TypeScript directly with `tsx`:

```sh
claude mcp add --scope user claude-status-mcp -- npx tsx /absolute/path/to/claude-status-mcp/src/cli.ts --mcp
```

### Codex From Local Checkout

Use the compiled entrypoint:

```sh
codex mcp add claude-status-mcp -- node /absolute/path/to/claude-status-mcp/dist/cli.js --mcp
```

Or run TypeScript directly with `tsx`:

```sh
codex mcp add claude-status-mcp -- npx tsx /absolute/path/to/claude-status-mcp/src/cli.ts --mcp
```

## Development

Install dependencies:

```sh
npm install
```

Run from TypeScript:

```sh
npm run dev
```

Run the MCP server from TypeScript:

```sh
npm run dev -- --mcp
```

Build:

```sh
npm run build
```

Typecheck:

```sh
npm run typecheck
```

Preview the npm package:

```sh
npm pack --dry-run
```

## Troubleshooting

### Unable to Find a Claude OAuth Access Token

Make sure Claude Code is logged in on this machine, or pass a token explicitly:

```sh
CLAUDE_OAUTH_ACCESS_TOKEN="sk-ant-..." npx claude-status-mcp
```

You can also point the command or MCP tool at a credentials file:

```sh
npx claude-status-mcp --credentials-path /path/to/credentials.json
```

### MCP Tool Does Not Show Up

Restart Claude Code, Codex, or your MCP client after adding the server. Most MCP clients discover tools only when a new session starts.

### macOS Keychain Works in Terminal But Not in a Sandbox

Some sandboxed environments cannot access the macOS Keychain. In that case, run outside the sandbox or provide `CLAUDE_OAUTH_ACCESS_TOKEN` explicitly.

## Security Notes

This package reads an OAuth access token so it can call Anthropic's usage API. Treat that token like a secret.

- Do not commit credentials files.
- Do not paste tokens into shared logs.
- Prefer the macOS Keychain or environment variables over hardcoded config.
- The package returns token source metadata, not the token value.

## Related Packages

These packages are part of the same family of AI provider status tools:

- [codex-status-mcp](https://github.com/DrSmile444/codex-status-mcp) — Codex / ChatGPT rate-limit windows and credits
- [copilot-status-mcp](https://github.com/DrSmile444/copilot-status-mcp) — GitHub Copilot session, weekly, and monthly quota
- [provider-status-mcp](https://github.com/DrSmile444/provider-status-mcp) — Aggregates Claude, Codex, and Copilot status into a single view

## License

MIT

---

Made with ❤️ by Dmytro Vakulenko, 2026
