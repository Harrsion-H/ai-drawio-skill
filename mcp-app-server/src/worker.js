/**
 * Cloudflare Workers entry point for the draw.io MCP App server.
 *
 * Uses a single Durable Object to manage all MCP sessions, keeping costs minimal.
 *
 * Pre-requisite: run `node src/build-html.js` to generate src/generated-html.js.
 * Wrangler's [build] command does this automatically before bundling.
 */

import { createServer } from "./shared.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { html } from "./generated-html.js";

const CORS_HEADERS =
{
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, mcp-session-id, mcp-protocol-version",
};

/** Add CORS headers to an existing Response. */
function withCors(response)
{
  const patched = new Response(response.body, response);

  for (const [k, v] of Object.entries(CORS_HEADERS))
  {
    patched.headers.set(k, v);
  }

  return patched;
}

/**
 * Single Durable Object that manages all MCP sessions.
 * Maintains a Map of session IDs to their server/transport instances.
 */
export class MCPSessionManager
{
  constructor(state, env)
  {
    this.state = state;
    this.sessions = new Map(); // sessionId -> { server, transport, lastAccess }
    this.lastCleanup = 0; // Timestamp of last cleanup
  }

  async fetch(request)
  {
    // CORS preflight
    if (request.method === "OPTIONS")
    {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // Extract or generate session ID
    const sessionId = request.headers.get("mcp-session-id") || crypto.randomUUID();

    // Get or create session
    let session = this.sessions.get(sessionId);

    if (!session)
    {
      const server = createServer(html);
      const transport = new WebStandardStreamableHTTPServerTransport(
      {
        sessionIdGenerator: function() { return sessionId; },
      });

      await server.connect(transport);

      session =
      {
        server,
        transport,
        lastAccess: Date.now(),
      };

      this.sessions.set(sessionId, session);
      console.log(`Created new session: ${sessionId}. Total sessions: ${this.sessions.size}`);
    }

    // Update last access time
    session.lastAccess = Date.now();

    // Periodic cleanup (throttled to once per 5 minutes)
    const now = Date.now();

    if (now - this.lastCleanup > 5 * 60 * 1000)
    {
      this.cleanupStaleSessions();
      this.lastCleanup = now;
    }

    // Handle the MCP request
    const response = await session.transport.handleRequest(request);

    return withCors(response);
  }

  /**
   * Remove sessions that haven't been accessed in the last 30 minutes.
   */
  cleanupStaleSessions()
  {
    const now = Date.now();
    const THIRTY_MINUTES = 30 * 60 * 1000;
    let cleaned = 0;

    for (const [id, session] of this.sessions.entries())
    {
      if (now - session.lastAccess > THIRTY_MINUTES)
      {
        this.sessions.delete(id);
        cleaned++;
      }
    }

    if (cleaned > 0)
    {
      console.log(`Cleaned up ${cleaned} stale sessions. Remaining: ${this.sessions.size}`);
    }
  }
}

/**
 * Main Worker: routes all /mcp requests to the single Durable Object.
 */
export default
{
  async fetch(request, env)
  {
    // CORS preflight
    if (request.method === "OPTIONS")
    {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // Only serve /mcp
    const url = new URL(request.url);

    if (url.pathname !== "/mcp")
    {
      return new Response("Not Found", { status: 404 });
    }

    // Route to the single global Durable Object
    const durableObjectId = env.MCP_SESSION_MANAGER.idFromName("global");
    const stub = env.MCP_SESSION_MANAGER.get(durableObjectId);

    return stub.fetch(request);
  },
};
