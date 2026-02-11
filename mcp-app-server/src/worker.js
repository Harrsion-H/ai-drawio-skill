/**
 * Cloudflare Workers entry point for the draw.io MCP App server.
 *
 * Pre-requisite: run `node src/build-html.js` to generate src/generated-html.js.
 * Wrangler's [build] command does this automatically before bundling.
 */

import { createServer } from "./shared.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { html } from "./generated-html.js";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, mcp-session-id, mcp-protocol-version",
};

/** Add CORS headers to an existing Response. */
function withCors(response) {
  const patched = new Response(response.body, response);
  for (const [k, v] of Object.entries(CORS_HEADERS)) {
    patched.headers.set(k, v);
  }
  return patched;
}

export default {
  async fetch(request) {
    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // Only serve /mcp
    const url = new URL(request.url);
    if (url.pathname !== "/mcp") {
      return new Response("Not Found", { status: 404 });
    }

    const server = createServer(html);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    await server.connect(transport);

    const response = await transport.handleRequest(request);
    return withCors(response);
  },
};
