# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# Draw.io MCP Server

Fork of `jgraph/drawio-mcp` at `Harrsion-H/ai-drawio-skill`. The upstream merge compatibility constraint means: **additive only** — new files in new directories, no modifications to existing modules.

## Repository Structure

- **`shared/`** — Single source of truth for all LLM prompts. `xml-reference.md`, `mermaid-reference.md`, `style-reference.md`. MCP servers and skills all consume from here.
- **`mcp-app-server/`** — MCP App server (inline rendering via iframe). Hosted at `https://mcp.draw.io/mcp`. Node.js + Cloudflare Workers.
- **`mcp-tool-server/`** — MCP tool server (stdio, opens browser). Published as `@drawio/mcp` on npm.
- **`skill-cli/`** — Claude Code skill (generates `.drawio` files, opens in desktop app).
- **`skill-drawio/`** — Unified Claude Code skill (XML + Mermaid, CLI scripts, shape search, export). Self-contained skill directory.
- **`shape-search/`** — Generates `search-index.json` (~10K shapes) from draw.io's `app.min.js` via jsdom.
- **`project-instructions/`** — Claude Project instructions (no MCP, no install).
- **`postprocessor/`** — Post-processing for `.drawio` files.

Each subdirectory has its own `CLAUDE.md`.

## Development Commands

```bash
# MCP App Server
cd mcp-app-server && npm install && npm start                    # Node.js on port 3001
npm run build:worker                                              # Generate generated-html.js for Workers
npm run deploy                                                    # Build + deploy to Cloudflare

# MCP Tool Server
cd mcp-tool-server && npm install && npm start                    # stdio transport

# Shape Search Index (requires ../../drawio-dev checkout)
cd shape-search && npm install
DRAWIO_DEV_PATH=../../drawio-dev node generate-index.js

# Skill CLI scripts (no install needed, uses Node.js built-ins)
node skill-drawio/scripts/search-shapes.js "aws lambda" 10
node skill-drawio/scripts/open-drawio.js --xml diagram.drawio
```

## Architecture: Reference Propagation

`shared/` is the canonical source. Changes propagate automatically:

| Consumer | How it gets references |
|----------|----------------------|
| MCP App Server | Reads `shared/` at startup / build time |
| MCP Tool Server | Copies via `prepack` script before npm publish |
| skill-drawio | GitHub Action syncs `shared/` → `skill-drawio/references/` on push to main |
| Project instructions | Users manually copy |

**When updating diagram guidance, edit only `shared/` files.**

## Architecture: MCP App Server Internals

Three bundles are inlined into a self-contained HTML string for the MCP Apps iframe sandbox:
- `app-with-deps.js` (MCP Apps SDK) — ESM export stripped, replaced with `var` alias (sandbox has no `allow-same-origin`)
- `pako_deflate.min.js` — URL compression
- `drawio-mermaid/dist/mermaid.bundled.js` — native Mermaid→draw.io parser (26 diagram types + ELK layout)

Cloudflare Worker uses 4 sharded Durable Objects for session management (routing by `sessionId.charAt(0) % 4`). Sessions expire after 5 minutes idle.

## Architecture: skill-drawio

Self-contained Claude Code skill. Users copy the entire `skill-drawio/` directory to `~/.claude/skills/drawio/`. SKILL.md uses relative paths (`references/`, `scripts/`) — all paths resolve from SKILL.md's location.

Backend priority: session mode (MCP) → inline mode (MCP) → CLI mode (scripts) → file mode (Write tool).

## Coding Conventions

- **Allman brace style**: Opening braces on their own line for all control structures, functions, objects, and callbacks
- Prefer `function()` expressions over arrow functions for callbacks
- Vanilla JS throughout — no TypeScript, no build steps (except mcp-app-server Worker bundle)

## GitHub Actions

| Workflow | Trigger | Purpose |
|----------|---------|---------|
| `update-search-index.yml` | `repository_dispatch` (drawio release) or manual | Regenerates `shape-search/search-index.json` |
| `skill-sync-references.yml` | Push to main touching `shared/**` or manual | Syncs `shared/` → `skill-drawio/references/` via PR |

## Key Gotchas

- **XML comments are allowed** in draw.io output — `<!-- -->` is valid per XSD and renders correctly
- **CSV `%column%` placeholders** in style attributes cause "URI malformed" errors — use hardcoded values
- **Mermaid version differences** can cause blank diagrams — simplify syntax when in doubt
- **`shared/style-reference.md`** exists but is separate from `xml-reference.md` — keep them in sync when adding new style properties
