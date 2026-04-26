# Skill Drawio

Unified draw.io diagram skill for Claude Code. Integrates MCP session interaction, inline rendering, CLI scripts, file-based generation, Mermaid support, and shape search into a single `/drawio` command.

## Directory Structure

```
skill-drawio/
├── CLAUDE.md                 # This file — developer notes
├── SKILL.md                  # Claude Code skill definition (entry point)
├── references/               # Auto-synced from shared/ via GitHub Action
│   ├── xml-reference.md
│   ├── mermaid-reference.md
│   ├── style-reference.md
│   └── mxfile.xsd            # XSD schema for draw.io files
└── scripts/
    ├── search-shapes.js      # CLI shape search (replicates search_shapes MCP tool)
    ├── open-drawio.js        # Opens draw.io in browser with XML/Mermaid/CSV content
    └── validate-mxfile.js    # Structural XML validation (no external deps)
```

## Installation

Copy the entire `skill-drawio/` directory to one of:
- `~/.claude/skills/drawio/` (personal, all projects)
- `.claude/skills/drawio/` (per-project)

Or use `npx skills add Harrsion-H/ai-drawio-skill` (vercel-labs/agent-skills format).

## Reference Sync

GitHub Action (`.github/workflows/skill-sync-references.yml`) auto-syncs `shared/` → `skill-drawio/references/` on push to main.

## Architecture

### Backend priority

```
User invokes /drawio
  ├─ Session mode (next-ai-drawio MCP) — interactive, browser preview, incremental editing
  ├─ Inline mode (mcp-app-server) — renders diagram inline in chat
  ├─ CLI mode (scripts/) — browser-based via URL generation
  └─ File mode (fallback) — writes .drawio file, optional PNG/SVG/PDF export
```

### Capability matrix

| Capability | Session (MCP) | Inline (MCP) | CLI (scripts) | File mode |
|-----------|---------------|--------------|---------------|-----------|
| Create diagram | create_new_diagram | create_diagram | open cmd | Write .drawio |
| Edit diagram | edit_diagram | — | — | Read + Write |
| Export | export_diagram | — | — | draw.io CLI |
| Shape search | — | search_shapes | search cmd | — |
| Open in browser | start_session | — | open cmd | — |

## Dependencies

Scripts use only Node.js built-ins (zlib for compression). pako is optional — scripts auto-detect and fall back to zlib.

## Compatibility notes

- Additive only — no modifications to existing modules
- All new files under `skill-drawio/`

## Coding Conventions

- **Allman brace style**: Opening braces on their own line
- Prefer `function()` expressions over arrow functions for callbacks
- See root `CLAUDE.md` for examples
