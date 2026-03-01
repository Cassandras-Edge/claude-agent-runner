#!/usr/bin/env node
/**
 * Minimal MCP server over stdio with a single slow tool for testing
 * mcp-background patch. Sleeps 5 seconds then returns a result.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server = new Server({ name: "test-slow", version: "1.0.0" }, {
  capabilities: { tools: {} }
});

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{
    name: "slow_lookup",
    description: "A deliberately slow tool that takes 5 seconds to respond. Use this to test background execution.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to look up" }
      },
      required: ["query"]
    }
  }]
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  if (name === "slow_lookup") {
    const start = Date.now();
    await new Promise(r => setTimeout(r, 5000));
    return {
      content: [{
        type: "text",
        text: `Slow lookup result for "${args?.query}": completed after ${Date.now() - start}ms. The answer is 42.`
      }]
    };
  }
  return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
});

const transport = new StdioServerTransport();
await server.connect(transport);
