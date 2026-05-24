I want to build a simple MCP which Claude can use to retrieve it's current usage.
The idea behind is that we can use their API to retrieve data.
For that API, we need to have access token.
Here's how it works:

Mac:
```shell
security find-generic-password -s "Claude Code-credentials" -w
```

Linux/Windows: The token is typically located in `~/.claude/credentials.json`.

It returns structure like:

```json
{
  "claudeAiOauth": {
    "accessToken": "sk-ant-1234567890abcdefg",
  }
}
```

After that, we do curl to the API:

```shell
curl --request GET \
  --url https://api.anthropic.com/api/oauth/usage \
  --header "Authorization: Bearer $YOUR_OAUTH_ACCESS_TOKEN" \
  --header "anthropic-beta: oauth-2025-04-20" \
  --header "Content-Type: application/json"
```

Now, I want you to build mcp from that to retrieve the current usage for Claude. The MCP should be able to run on both Mac and Linux/Windows, and it should return the usage data from api. Please provide the code for the MCP, along with instructions on how to set it up and use it.

It should work both as `npx claude-usage` and as mcp in claude.  

Add detailed `README.md` about both solutions.

I believe we can use ts for that, just to launch it with `npx tsx` in mcp.
Correct me if I'm wrong.
