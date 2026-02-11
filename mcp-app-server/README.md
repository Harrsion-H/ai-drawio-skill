# Draw.io MCP App Server

The MCP App server renders draw.io diagrams **inline** in AI chat interfaces using the [MCP Apps](https://modelcontextprotocol.io/docs/extensions/apps) protocol. Instead of opening a browser tab, diagrams appear directly in the conversation as interactive iframes.

## How It Works

1. The LLM calls the `create_diagram` tool with draw.io XML
2. The host fetches the UI resource and renders it in a sandboxed iframe
3. The diagram is rendered using the official [draw.io viewer](https://viewer.diagrams.net)
4. The user sees an interactive diagram inline with zoom, pan, and layers support

## Tool: `create_diagram`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `xml` | string | Yes | draw.io XML in mxGraphModel format |

The rendered diagram includes:
- Interactive zoom, pan, and navigation
- Layer toggling and lightbox mode
- "Open in draw.io" button to edit the diagram in the full editor
- Fullscreen mode

## Installation

```bash
cd mcp-app-server
npm install
```

## Running (Node.js)

Start the HTTP server (for Claude.ai and other web-based hosts):

```bash
npm start
```

The server listens on `http://localhost:3001/mcp` by default. Set the `PORT` environment variable to change the port.

### Connecting to Claude.ai

Since Claude.ai needs a public URL, use a tunnel:

```bash
npx cloudflared tunnel --url http://localhost:3001
```

Then add the tunnel URL (with `/mcp` appended) as a custom connector in Claude.ai settings.

### Using with Claude Desktop (stdio)

Add to your Claude Desktop config:

```json
{
  "mcpServers": {
    "drawio-app": {
      "command": "node",
      "args": ["path/to/mcp-app-server/src/index.js", "--stdio"]
    }
  }
}
```

> **Note:** Inline diagram rendering requires an MCP host that supports the MCP Apps extension. In hosts without MCP Apps support, the tool still works but returns the XML as text.

## Deploying to Cloudflare Workers

The server can be deployed to Cloudflare Workers for a public endpoint without tunnels.

### Prerequisites

- A [Cloudflare account](https://dash.cloudflare.com/sign-up)
- Node.js 18+

### Deploy

```bash
npm install
npx wrangler login        # One-time: authenticate with Cloudflare
npm run deploy             # Build + deploy to Workers
```

The deploy script runs `node src/build-html.js` (pre-inlines the SDK bundles into the HTML) then `wrangler deploy`.

### Local development with Wrangler

```bash
npm run dev:worker
```

This starts a local Workers dev server at `http://localhost:8787/mcp`.

### How the Worker entry differs from Node.js

| | Node.js (`src/index.js`) | Worker (`src/worker.js`) |
|---|---|---|
| **Transport** | `StreamableHTTPServerTransport` (Express) | `WebStandardStreamableHTTPServerTransport` (Web Standard `Request`/`Response`) |
| **HTML build** | Reads bundles from `node_modules` at startup | Pre-built at deploy time via `src/build-html.js` → `src/generated-html.js` |
| **Schema validation** | Default (Zod-based) | Uses `@cfworker/json-schema` (Workers-compatible) |

## Architecture

### File layout

```
src/
  shared.js          Shared logic: buildHtml(), processAppBundle(), createServer()
  index.js           Node.js entry (Express + stdio transports)
  worker.js          Cloudflare Workers entry (Web Standard fetch handler)
  build-html.js      Build script: generates generated-html.js
  generated-html.js  (gitignored) Pre-built HTML string for the Worker
wrangler.toml        Wrangler configuration
```

### How the HTML is built

The server inlines two bundles into a self-contained HTML string:

- **`app-with-deps.js`** (~319 KB) — MCP Apps SDK browser bundle from `@modelcontextprotocol/ext-apps`. The bundle is ESM (ends with `export { ... as App }`), so the server strips the export statement and creates a local `var App = <minifiedName>` alias. This makes it safe to inline in a plain `<script>` tag inside the sandboxed iframe.
- **`pako_deflate.min.js`** (~28 KB) — for compressing XML into the `#create=` URL format.

Both are inlined into the HTML served via `registerAppResource`. The draw.io viewer (`viewer-static.min.js`) is loaded from CDN at runtime.

For **Node.js**, this happens at startup (bundles read from `node_modules` via `fs`). For **Workers**, the `build-html.js` script does this at build time and writes `generated-html.js`.

### Key constraints

- The MCP Apps sandbox uses `sandbox="allow-scripts"` but **not** `allow-same-origin`, so Blob URL module imports fail silently. That's why the ESM export statement is stripped and a plain `var` alias is created.
- `app.openLink()` must be used instead of `<a target="_blank">` since the sandbox doesn't have `allow-popups`.
- `GraphViewer.processElements()` requires the container to have a nonzero `offsetWidth`, hence the `min-width: 200px` on `#diagram-container`.
