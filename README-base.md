# claude-usage-mcp

`claude-usage-mcp` is a small TypeScript CLI and MCP server that retrieves the current Claude OAuth usage from Anthropic's usage endpoint.

It can be used in three ways:

- `npx claude-usage-mcp` to print usage JSON in a terminal.
- `npx claude-usage-mcp --mcp` as a stdio MCP server.
- A local checkout, before the package is published.

## Requirements

- Node.js 18 or newer.
- Claude Code credentials already present on the machine, or an OAuth access token in `CLAUDE_OAUTH_ACCESS_TOKEN`.

Token lookup order:

1. `CLAUDE_OAUTH_ACCESS_TOKEN`
2. macOS Keychain service `Claude Code-credentials` on macOS
3. `~/.claude/credentials.json`

The credentials JSON is expected to contain:

```json
{
  "claudeAiOauth": {
    "accessToken": "sk-ant-..."
  }
}
```

## CLI Usage

After publishing to npm, run:

```sh
npx claude-usage-mcp
```

The command prints a JSON object:

```json
{
  "usage": {},
  "tokenSource": "credentials-file",
  "credentialsPath": "/Users/example/.claude/credentials.json"
}
```

Use a non-default credentials file:

```sh
npx claude-usage-mcp --credentials-path /path/to/credentials.json
```

Use an explicit token:

```sh
CLAUDE_OAUTH_ACCESS_TOKEN="sk-ant-..." npx claude-usage-mcp
```

## MCP Setup

The MCP server exposes one tool:

- `get_claude_usage`: retrieves the current usage data from `https://api.anthropic.com/api/oauth/usage`.

The tool accepts an optional `credentialsPath` argument:

```json
{
  "credentialsPath": "/path/to/credentials.json"
}
```

After adding the server, restart the MCP client if it was already running. Codex and Claude Code usually load MCP servers when a session starts.

### Claude Code, Published Package

After the package is published to npm:

```sh
claude mcp add --scope user claude-usage-mcp -- npx -y claude-usage-mcp --mcp
```

Equivalent JSON configuration:

```json
{
  "mcpServers": {
    "claude-usage-mcp": {
      "command": "npx",
      "args": ["-y", "claude-usage-mcp", "--mcp"]
    }
  }
}
```

### Codex, Published Package

After the package is published to npm:

```sh
codex mcp add claude-usage-mcp -- npx -y claude-usage-mcp --mcp
```

This writes an entry like this to `~/.codex/config.toml`:

```toml
[mcp_servers.claude-usage-mcp]
command = "npx"
args = ["-y", "claude-usage-mcp", "--mcp"]
```

### Manual MCP JSON

```json
{
  "mcpServers": {
    "claude-usage-mcp": {
      "command": "npx",
      "args": ["tsx", "/absolute/path/to/claude-usage-mcp/src/cli.ts", "--mcp"]
    }
  }
}
```

Use this form for MCP clients that accept raw JSON config rather than `claude mcp add` or `codex mcp add`.

## How It Works

`claude-usage-mcp` is just a small wrapper around Claude Code's existing OAuth session.

When you run the CLI or call the MCP tool, it first looks for an OAuth access token. It checks `CLAUDE_OAUTH_ACCESS_TOKEN`, then the macOS Keychain entry that Claude Code uses, then `~/.claude/credentials.json` for Linux and Windows-style setups.

After it has a token, it sends one authenticated request to Anthropic's usage endpoint:

```text
GET https://api.anthropic.com/api/oauth/usage
```

The response from Anthropic is returned as JSON. In CLI mode, it is printed to stdout. In MCP mode, the same data is returned from the `get_claude_usage` tool so Claude, Codex, or another MCP client can inspect it during a session.

The package does not store tokens, refresh credentials, or keep a background process running. Each call reads the token source available on your machine, calls the API, returns the result, and exits unless it is running as an MCP stdio server.

## Test With Raw Shell

You can test the same flow without this package.

On macOS, read the token from the Claude Code Keychain item:

```sh
export CLAUDE_OAUTH_ACCESS_TOKEN="$(
  security find-generic-password -s "Claude Code-credentials" -w \
    | node -e 'let input=""; process.stdin.on("data", c => input += c); process.stdin.on("end", () => console.log(JSON.parse(input).claudeAiOauth.accessToken));'
)"
```

On Linux or Windows, read the token from a credentials file:

```sh
export CLAUDE_OAUTH_ACCESS_TOKEN="$(
  node -e 'const fs = require("fs"); const path = require("os").homedir() + "/.claude/credentials.json"; console.log(JSON.parse(fs.readFileSync(path, "utf8")).claudeAiOauth.accessToken);'
)"
```

If you already have a token, set it directly:

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

## Local Checkout MCP Setup

Use these instructions before the package is published, or when you want Codex or Claude Code to run directly from your local clone.

### Claude Code, Local Checkout

Use the TypeScript entrypoint directly:

```sh
claude mcp add --scope user claude-usage-mcp -- npx tsx /absolute/path/to/claude-usage-mcp/src/cli.ts --mcp
```

Or build first and point Claude Code at the compiled entrypoint:

```sh
npm install
npm run build
claude mcp add --scope user claude-usage-mcp -- node /absolute/path/to/claude-usage-mcp/dist/cli.js --mcp
```

Equivalent local JSON configuration:

```json
{
  "mcpServers": {
    "claude-usage-mcp": {
      "command": "node",
      "args": ["/absolute/path/to/claude-usage-mcp/dist/cli.js", "--mcp"]
    }
  }
}
```

Verify in Claude Code:

```sh
claude mcp list
claude mcp get claude-usage-mcp
```

### Codex, Local Checkout

Build the project and point Codex at the compiled entrypoint:

```sh
npm install
npm run build
codex mcp add claude-usage-mcp -- node /absolute/path/to/claude-usage-mcp/dist/cli.js --mcp
```

This writes an entry like this to `~/.codex/config.toml`:

```toml
[mcp_servers.claude-usage-mcp]
command = "node"
args = ["/absolute/path/to/claude-usage-mcp/dist/cli.js", "--mcp"]
```

You can also use `tsx` directly for local development:

```sh
codex mcp add claude-usage-mcp -- npx tsx /absolute/path/to/claude-usage-mcp/src/cli.ts --mcp
```

Verify in Codex:

```sh
codex mcp list
codex mcp get claude-usage-mcp --json
```

## Local Development

Install dependencies:

```sh
npm install
```

Run the CLI from TypeScript:

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

Run the built CLI:

```sh
node dist/cli.js
```
