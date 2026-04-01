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

// Optionally inline a local viewer build (for testing GraphViewer changes).
// Set VIEWER_PATH env var to the path of viewer-static.min.js (or a directory
// containing it plus GraphViewer.js). Example:
//   VIEWER_PATH=../drawio-dev/src/main/webapp/js npm start
var viewerJs = null;

if (process.env.VIEWER_PATH)
{
  const viewerPath = path.resolve(process.env.VIEWER_PATH);

  if (fs.statSync(viewerPath).isDirectory())
  {
    // Load the minified viewer + unminified GraphViewer.js on top
    const minJs = path.join(viewerPath, "viewer-static.min.js");
    const gvJs = path.join(viewerPath, "diagramly", "GraphViewer.js");
    viewerJs = fs.readFileSync(minJs, "utf-8");

    if (fs.existsSync(gvJs))
    {
      viewerJs += "\n" + fs.readFileSync(gvJs, "utf-8");
    }

    console.log("Using local viewer from", viewerPath);
  }
  else
  {
    viewerJs = fs.readFileSync(viewerPath, "utf-8");
    console.log("Using local viewer from", viewerPath);
  }
}

// Pre-build the HTML once
const html = buildHtml(appWithDepsJs, pakoDeflateJs, { viewerJs });

// --- Transport setup ---

async function startStreamableHTTPServer()
{
  const port = parseInt(process.env.PORT ?? "3001", 10);
  const host = process.env.LISTEN ?? "127.0.0.1";
  const allowedHosts = process.env.ALLOWED_HOSTS
    ? process.env.ALLOWED_HOSTS.split(",").map(function(h) { return h.trim(); })
    : undefined;
  const app = createMcpExpressApp({ host: "0.0.0.0", allowedHosts });

  app.all("/mcp", async function(req, res)
  {
    const method = req.body && req.body.method;
    const sessionId = (req.headers["mcp-session-id"] || "").slice(0, 8);
    const start = Date.now();
    console.log(`[req] ${req.method} method=${method || "(none)"} session=${sessionId} accept=${req.headers["accept"] || ""}`);

    if (req.body && Object.keys(req.body).length > 0)
    {
      console.log(`[req-body] ${JSON.stringify(req.body)}`);
    }

    const origWrite = res.write.bind(res);
    const origEnd = res.end.bind(res);
    var responseChunks = [];

    res.write = function(chunk)
    {
      if (chunk) { responseChunks.push(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk)); }
      return origWrite(chunk);
    };

    res.end = function(chunk)
    {
      if (chunk) { responseChunks.push(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk)); }
      const elapsed = Date.now() - start;
      console.log(`[res] method=${method || "(none)"} session=${sessionId} status=${res.statusCode} ${elapsed}ms`);

      if (responseChunks.length > 0)
      {
        const body = responseChunks.join("");
        console.log(`[res-body] ${body.slice(0, 2000)}`);
      }

      return origEnd(chunk);
    };

    const server = createServer(html, { domain: process.env.DOMAIN });

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
    setTimeout(function() { process.exit(0); }, 1000).unref();
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function startStdioServer()
{
  await createServer(html, { domain: process.env.DOMAIN }).connect(new StdioServerTransport());
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
