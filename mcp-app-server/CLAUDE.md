# MCP App Server

Renders draw.io diagrams inline in AI chat interfaces using the MCP Apps protocol.

## Key Files

| File | Purpose |
|------|---------|
| `src/shared.js` | Shared logic: `buildHtml()`, `processAppBundle()`, `createServer()` |
| `src/index.js` | Node.js entry (Express + stdio transports) |
| `src/worker.js` | Cloudflare Workers entry (Web Standard fetch handler) |
| `src/build-html.js` | Build script: generates `generated-html.js` for the Worker |

## Architecture

### How the HTML is built

At startup (Node.js) or build time (Workers), two bundles are read from `node_modules` and inlined into a self-contained HTML string:

- **`app-with-deps.js`** (~319 KB) — MCP Apps SDK browser bundle from `@modelcontextprotocol/ext-apps`. The bundle is ESM (ends with `export { ... as App }`), so `processAppBundle()` strips the export statement and creates a local `var App = <minifiedName>` alias. This makes it safe to inline in a plain `<script>` tag inside the sandboxed iframe.
- **`pako_deflate.min.js`** (~28 KB) — for compressing XML into the `#create=` URL format.

The draw.io viewer (`viewer-static.min.js`) is loaded from CDN at runtime.

### Sandbox constraints

- The MCP Apps sandbox uses `sandbox="allow-scripts"` but **not** `allow-same-origin` — Blob URL module imports fail silently. That's why we strip the ESM export and use a plain `var` alias.
- `app.openLink({ url })` must be used instead of `<a target="_blank">` — no `allow-popups`.
- `GraphViewer.processElements()` requires nonzero `offsetWidth` on the container — hence `min-width: 200px` on `#diagram-container`.

### Node.js vs Workers

| | Node.js (`src/index.js`) | Worker (`src/worker.js`) |
|---|---|---|
| **Transport** | `StreamableHTTPServerTransport` (Express) | `WebStandardStreamableHTTPServerTransport` |
| **HTML build** | Reads bundles from `node_modules` at startup | Pre-built via `build-html.js` → `generated-html.js` |

## MCP Apps SDK Patterns

- `registerAppTool` `inputSchema` uses Zod shapes (`{ key: z.string() }`), not JSON Schema objects
- CSP config goes on the **resource contents** `_meta.ui.csp`, not on the tool's `_meta.ui`
- TypeScript narrowing: use `if (block.type === "text")` before accessing `.text` on content blocks

## Scripts

```bash
npm start              # Node.js server on port 3001
npm run build:worker   # Generate generated-html.js
npm run dev:worker     # Wrangler local dev (port 8787)
npm run deploy         # Build + deploy to Cloudflare Workers
```
