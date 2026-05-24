import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { getClaudeUsage } from "./usage.js";

const GET_USAGE_TOOL = "get_claude_usage";

interface GetUsageArguments {
  credentialsPath?: string;
}

function isGetUsageArguments(value: unknown): value is GetUsageArguments {
  if (!value || typeof value !== "object") {
    return true;
  }

  const credentialsPath = (value as Record<string, unknown>).credentialsPath;
  return credentialsPath === undefined || typeof credentialsPath === "string";
}

export async function runMcpServer(): Promise<void> {
  const server = new Server(
    {
      name: "claude-usage-mcp",
      version: "0.1.0",
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: GET_USAGE_TOOL,
        description: "Retrieve current Claude OAuth usage from Anthropic's usage API.",
        inputSchema: {
          type: "object",
          properties: {
            credentialsPath: {
              type: "string",
              description:
                "Optional path to Claude credentials.json. Defaults to ~/.claude/credentials.json after env/keychain lookup.",
            },
          },
          additionalProperties: false,
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name !== GET_USAGE_TOOL) {
      return {
        content: [
          {
            type: "text",
            text: `Unknown tool: ${request.params.name}`,
          },
        ],
        isError: true,
      };
    }

    const args = request.params.arguments;
    if (!isGetUsageArguments(args)) {
      return {
        content: [
          {
            type: "text",
            text: "Invalid arguments. credentialsPath must be a string when provided.",
          },
        ],
        isError: true,
      };
    }

    try {
      const result = await getClaudeUsage({
        credentialsPath: args?.credentialsPath,
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: error instanceof Error ? error.message : String(error),
          },
        ],
        isError: true,
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
