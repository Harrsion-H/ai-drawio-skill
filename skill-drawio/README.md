# draw.io Skill for Claude Code

Unified draw.io diagram skill for Claude Code. Supports XML and Mermaid generation, interactive editing, shape search, and export.

## Install

### Option 1: One-click install (recommended)

```bash
npx skills add Harrsion-H/ai-drawio-skill
```

Requires [vercel-labs/agent-skills](https://github.com/vercel-labs/agent-skills).

### Option 2: Global install (all projects)

```bash
# Clone or download the repo
git clone https://github.com/Harrsion-H/ai-drawio-skill.git
# Copy skill directory to Claude Code skills
cp -r ai-drawio-skill/skill-drawio ~/.claude/skills/drawio
```

### Option 3: Per-project install

```bash
# From your project root
cp -r /path/to/ai-drawio-skill/skill-drawio .claude/skills/drawio
```

## Verify

After installing, restart Claude Code and run:

```
/drawio create a flowchart for user login
```

## What's included

```
skill-drawio/
├── SKILL.md              # Skill definition (auto-loaded by Claude Code)
├── references/           # XML, Mermaid, and style references
│   ├── xml-reference.md
│   ├── mermaid-reference.md
│   └── style-reference.md
└── scripts/              # CLI tools (work without MCP server)
    ├── search-shapes.js  # Shape search (10,000+ shapes)
    └── open-drawio.js    # Open diagram in browser
```

## CLI Scripts

The scripts work standalone with Node.js (no dependencies required).

```bash
# Search shapes for cloud/network/P&ID diagrams
node scripts/search-shapes.js "aws lambda" 10

# Open a .drawio file in browser
node scripts/open-drawio.js --xml diagram.drawio

# Open Mermaid from stdin
echo 'flowchart TD
  A-->B' | node scripts/open-drawio.js --mermaid -

# Generate URL only (no browser)
node scripts/open-drawio.js --url --mermaid diagram.mmd
```

## Backends

The skill automatically detects the best available backend:

| Priority | Backend | How it works |
|----------|---------|-------------|
| 1 | Session mode (MCP) | Interactive editing via `next-ai-drawio` MCP server |
| 2 | Inline mode (MCP) | Renders inline in chat via `mcp-app-server` |
| 3 | CLI mode | Opens in browser via `scripts/open-drawio.js` |
| 4 | File mode | Writes `.drawio` file, optional PNG/SVG/PDF export |

## Uninstall

```bash
rm -rf ~/.claude/skills/drawio        # Global
rm -rf .claude/skills/drawio          # Per-project
```
