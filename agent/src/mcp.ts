/**
 * CARSEM as an MCP server (Streamable HTTP, stateless). Connect it from:
 *   Hermes          mcp_servers.carsem: { url: <gateway>/mcp, headers: { Authorization: "Bearer csm_…" } }
 *   Claude Code     claude mcp add --transport http carsem <gateway>/mcp --header "Authorization: Bearer csm_…"
 *   ChatGPT/Claude  add a custom connector with the personal URL <gateway>/mcp/k/<csm_…>
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Request, Response } from "express";
import { TOOLS, WORKFLOW } from "./toolDefs.js";
import type { UserAgent } from "./tools.js";

function buildServer(agent: UserAgent) {
  const server = new McpServer({ name: "carsem", version: "0.2.0" }, { instructions: WORKFLOW });
  for (const tool of TOOLS) {
    server.registerTool(tool.name, { title: tool.title, description: tool.description, inputSchema: tool.input.shape }, async (input: unknown) => {
      const result = await tool.run(agent, tool.input.parse(input ?? {}));
      const failed = !!result && typeof result === "object" && "error" in result;
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }], isError: failed };
    });
  }
  return server;
}

/** Handles one MCP HTTP request for an already-authenticated user's agent. */
export async function handleMcp(req: Request, res: Response, agent: UserAgent) {
  if (req.method !== "POST") {
    res.status(405).set("Allow", "POST").json({ jsonrpc: "2.0", error: { code: -32000, message: "This CARSEM MCP server is stateless: use POST" }, id: null });
    return;
  }
  const server = buildServer(agent);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => { void transport.close(); void server.close(); });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}
