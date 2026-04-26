---
name: drawio
description: Always use when user asks to create, generate, draw, or design a diagram, flowchart, architecture diagram, ER diagram, sequence diagram, class diagram, network diagram, mockup, wireframe, or UI sketch, or mentions draw.io, drawio, .drawio files, diagram export to PNG/SVG/PDF, or requests editing/updating an existing diagram.
---

# Draw.io Diagram Skill (Unified)

Unified draw.io diagram skill that supports XML and Mermaid generation, interactive editing, shape search, and export. Automatically detects the best available backend.

## Quick decision guide

| Need | Use |
|------|-----|
| Flowchart, sequence, ER, class, state, Gantt, mindmap, timeline | **Mermaid** — concise syntax, reliable |
| Custom positioning, exact colors, containers, layers, multi-layout | **XML** — full control |
| AWS/Azure/GCP/network/electrical/P&ID diagrams | **XML + search_shapes** |
| Edit an existing diagram | **get_diagram → edit_diagram** (session mode) or rewrite file (file mode) |
| Export to PNG/SVG/PDF | draw.io CLI (file mode) or export_diagram (session mode) |

## References — read before generating

Before generating diagrams, read the appropriate reference files for complete syntax and style guidance. All paths are relative to this SKILL.md file.

- **XML diagrams**: `references/xml-reference.md`
- **Mermaid diagrams**: `references/mermaid-reference.md`
- **Style properties**: `references/style-reference.md`

## Backend detection (run once per conversation)

Check which tools are available and select the backend:

```
1. Session mode — next-ai-drawio MCP tools available (start_session, create_new_diagram, edit_diagram, get_diagram, export_diagram)
2. Inline mode — mcp-app-server create_diagram / search_shapes available
3. CLI mode — scripts/ available (search-shapes.js, open-drawio.js)
4. File mode — fallback, generate .drawio files via Write tool
```

If multiple backends are available, prefer **session mode** for interactive work, **inline mode** for quick previews, **CLI mode** for browser-based workflows, and **file mode** for persistent output.

## Creating a diagram

### Step 1: Choose format

- **Default to Mermaid** for standard diagram types (flowchart, sequence, ER, class, state, Gantt, mindmap, timeline, pie, quadrant, etc.)
- **Use XML** when the user needs precise layout, custom styles, containers/layers, industry-specific shapes, or when the user explicitly asks for XML
- If the user says "mermaid" or "xml" in the command, respect their choice

### Step 2: Generate content

#### Mermaid mode

Generate valid Mermaid syntax. Key rules:
- Pick the correct type keyword: `flowchart`, `sequenceDiagram`, `classDiagram`, `stateDiagram-v2`, `erDiagram`, `gantt`, `mindmap`, `timeline`, `pie`, `quadrantChart`, `sankey-beta`, `xychart-beta`, `block-beta`, `C4Context`/`C4Container`/`C4Component`, `architecture-beta`, `radar-beta`, `packet-beta`, `venn-beta`, `treemap-beta`, `treeView-beta`, `ishikawa-beta`, `kanban`, `zenuml`
- No trailing punctuation on node IDs. Use brackets for display text: `A["User's Account"]`
- One statement per line. Quote labels with special characters
- Match label language to user's language

#### XML mode

Generate mxGraphModel XML. Key rules:
- Every diagram needs cells `id="0"` and `id="1" parent="0"`
- Use the rigid grid: `x = col * 180 + 40`, `y = row * 120 + 40`
- Node sizes: rectangles 140x60, diamonds 140x80, circles 60x60, cylinders 100x70
- Every edge must have `<mxGeometry relative="1" as="geometry" />` child
- Edge routing is automatic — just declare `source` and `target`
- Use `html=1` in all cell styles
- No XML comments. Escape `&amp;`, `&lt;`, `&gt;`, `&quot;` in attributes

### Step 3: Render or save

#### Session mode (MCP)

1. Call `start_session` to open browser with draw.io
2. Call `create_new_diagram` with the XML
3. For Mermaid: convert to XML first, then create (session mode only accepts XML)
4. For editing later: call `get_diagram` to fetch current state, then `edit_diagram` with operations

#### Inline mode (MCP)

1. Call `create_diagram` with the XML (renders inline in chat)
2. For shape search: call `search_shapes` before `create_diagram` when industry icons are needed

#### CLI mode (scripts)

1. **Open in browser**: `node scripts/open-drawio.js --xml <file>` or `--mermaid <file>`
2. **Search shapes**: `node scripts/search-shapes.js "aws lambda" 10`
3. Use the returned `style` strings directly in XML cells

#### File mode (fallback)

1. If Mermaid: generate XML directly for the same diagram type
2. Write XML to a `.drawio` file using the Write tool
3. Post-process (optional): if `npx @drawio/postprocess` is available, run it on the .drawio file. Skip silently if unavailable
4. If export format requested (png, svg, pdf), use draw.io CLI to export
5. Open the result for viewing

## Editing an existing diagram

### Session mode (preferred)

1. Call `get_diagram` to fetch current XML including any manual edits
2. Analyze current cell IDs and structure
3. Call `edit_diagram` with operations:
   - `add`: new cell with unique `cell_id` and complete `new_xml`
   - `update`: replace existing cell by `cell_id` with updated `new_xml`
   - `delete`: remove cell by `cell_id`
4. Repeat as needed — the browser updates in real-time

### File mode

1. Read the existing .drawio file
2. Modify the XML as needed (add/update/remove cells)
3. Write the updated XML back to the file
4. Re-open if needed

## Shape search

**When to search:**
- Cloud architecture (AWS, Azure, GCP)
- Network topology (Cisco, rack equipment)
- P&ID (valves, instruments, vessels)
- Electrical/circuit diagrams
- Kubernetes resources
- BPMN with specific task types

**When NOT to search:**
- Standard diagrams using basic shapes (flowcharts, UML, ERD, org charts, mind maps, wireframes)
- User explicitly asks for basic/simple shapes

**How to use:**

MCP: Call `search_shapes` with `{ query: "keywords", limit: 10 }`

CLI: `node scripts/search-shapes.js "aws lambda" 10`

Use the returned `style` string directly in the mxCell `style` attribute. Set appropriate `w` and `h` from search results.

## Export

### Session mode (MCP)

Call `export_diagram` with `path` (e.g., `./diagram.drawio`, `./diagram.png`, `./diagram.svg`).

### File mode (draw.io CLI)

Locate the CLI:

| Environment | Path |
|-------------|------|
| macOS | `/Applications/draw.io.app/Contents/MacOS/draw.io` |
| Linux | `drawio` (on PATH) |
| Windows | `"C:\Program Files\draw.io\draw.io.exe"` |
| WSL2 | `` `/mnt/c/Program Files/draw.io/draw.io.exe` `` |

Detect WSL2: `grep -qi microsoft /proc/version 2>/dev/null`

Export command:
```bash
drawio -x -f <format> -e -b 10 -o <output> <input.drawio>
```

Key flags: `-x` export, `-f` format (png/svg/pdf), `-e` embed diagram XML, `-b 10` border

After successful export, delete the intermediate `.drawio` file — the exported file contains the full diagram.

### Opening the result

| Environment | Command |
|-------------|---------|
| macOS | `open <file>` |
| Linux | `xdg-open <file>` |
| WSL2 | `cmd.exe /c start "" "$(wslpath -w <file>)"` |
| Windows | `start <file>` |

## File naming

- Descriptive name based on diagram content: `login-flow`, `database-schema`
- Lowercase with hyphens for multi-word names
- Export uses double extension: `name.drawio.png`, `name.drawio.svg`, `name.drawio.pdf`

## XML format (basic structure)

Every diagram must have:

```xml
<mxGraphModel adaptiveColors="auto">
  <root>
    <mxCell id="0"/>
    <mxCell id="1" parent="0"/>
  </root>
</mxGraphModel>
```

Common shapes:
- Rectangle: `rounded=1;whiteSpace=wrap;html=1;`
- Diamond: `rhombus;whiteSpace=wrap;html=1;`
- Cylinder (DB): `shape=cylinder3;whiteSpace=wrap;html=1;`
- Edge: `edgeStyle=orthogonalEdgeStyle;rounded=1;html=1;`

## Mermaid format (quick reference)

Flowchart: `flowchart TD/LR`, edges `-->`, shapes `[rect]`, `{diamond}`, `((circle))`, `[(cylinder)]`
Sequence: `sequenceDiagram`, arrows `->>`, `-->>`, activate/deactivate, alt/loop/opt blocks
Class: `classDiagram`, relations `<|--`, `*--`, `o--`, `-->`
ER: `erDiagram`, cardinality `||--o{`, entity blocks
State: `stateDiagram-v2`, `[*]` start/end, nested `state X {}`

For complete Mermaid syntax and all 26 diagram types, read `references/mermaid-reference.md`.

## CRITICAL: XML well-formedness

- **NEVER include XML comments (`<!-- -->`)** in output
- Escape special characters: `&amp;`, `&lt;`, `&gt;`, `&quot;`
- Use unique `id` values for each `mxCell`
- Every edge must have `<mxGeometry relative="1" as="geometry" />` child element

## Troubleshooting

| Problem | Solution |
|---------|----------|
| draw.io CLI not found | Keep .drawio file, tell user to install draw.io desktop app |
| Export empty/corrupt | Validate XML well-formedness, check for unescaped characters |
| Blank diagram | Ensure root cells `id="0"` and `id="1"` exist |
| Edges not rendering | Add `<mxGeometry relative="1" as="geometry" />` to every edge |
| Mermaid blank | Check type keyword spelling, verify node ID format |
| Session not available | Fall back to CLI or file mode |
| search-index.json not found | Run `cd shape-search && npm run generate`, or install from GitHub |
