#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildHtml, processAppBundle, createServer } from "./shared.js";

// Read the browser bundles once at startup and inline them into the HTML
const extAppsEntry = fileURLToPath(import.meta.resolve("@modelcontextprotocol/ext-apps/app-with-deps"));
const appWithDepsRaw = fs.readFileSync(extAppsEntry, "utf-8");

// The bundle is ESM: ends with export{..., oc as App, ...}.
// We can't use <script type="module"> (export aliases aren't local vars)
// and Blob URL import() fails in sandboxed iframes without allow-same-origin.
// Fix: strip the export statement and create a local `App` alias.
const appWithDepsJs = processAppBundle(appWithDepsRaw);

const pakoEntry = fileURLToPath(import.meta.resolve("pako"));
const pakoDeflateJs = fs.readFileSync(
  path.join(path.dirname(pakoEntry), "..", "dist", "pako_deflate.min.js"),
  "utf-8"
);

// Pre-build the HTML once
const html = buildHtml(appWithDepsJs, pakoDeflateJs);

// --- Transport setup ---

async function startStreamableHTTPServer()
{
  const port = parseInt(process.env.PORT ?? "3001", 10);
  const host = process.env.LISTEN ?? "127.0.0.1";
  const app = createMcpExpressApp({ host: host });

  app.all("/mcp", async function(req, res)
  {
    const server = createServer(html);
    const transport = new StreamableHTTPServerTransport(
    {
      sessionIdGenerator: undefined,
    });

    res.on("close", function()
    {
      transport.close().catch(function() {});
      server.close().catch(function() {});
    });

    try
    {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    }
    catch (error)
    {
      console.error("MCP error:", error);

      if (!res.headersSent)
      {
        res.status(500).json(
        {
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  });

  const httpServer = app.listen(port, function()
  {
    console.log(`MCP App server listening on http://${host}:${port}/mcp`);
  });

  const shutdown = function()
  {
    console.log("\nShutting down...");
    httpServer.close(function() { process.exit(0); });
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function startStdioServer()
{
  await createServer(html).connect(new StdioServerTransport());
}

async function main()
{
  if (process.argv.includes("--stdio"))
  {
    await startStdioServer();
  }
  else
  {
    await startStreamableHTTPServer();
  }
}

main().catch(function(e)
{
  console.error(e);
  process.exit(1);
});
