# Draw.io MCP Server

The official draw.io MCP (Model Context Protocol) server that enables LLMs to open and create diagrams in the draw.io editor.

## Repository Structure

- **`mcp-tool-server/`** — Original MCP tool server (stdio-based, opens browser). Published as `@drawio/mcp` on npm.
- **`mcp-app-server/`** — MCP App server (renders diagrams inline in chat via iframe). Runs on Node.js or Cloudflare Workers.
- **`project-instructions/`** — Claude Project instructions (no MCP required, no install).

Each subdirectory has its own `CLAUDE.md` with implementation details.

## MCP Tool Server Tools

### `open_drawio_xml`

Opens the draw.io editor with XML content.

**Parameters:**
- `content` (required): Draw.io XML content or URL to XML file
- `lightbox` (optional): Open in read-only lightbox mode (default: false)
- `dark` (optional): Dark mode - "true" or "false" (default: false)

**Example XML:**
```xml
<mxGraphModel>
  <root>
    <mxCell id="0"/>
    <mxCell id="1" parent="0"/>
    <mxCell id="2" value="Hello" style="rounded=1;" vertex="1" parent="1">
      <mxGeometry x="100" y="100" width="120" height="60" as="geometry"/>
    </mxCell>
  </root>
</mxGraphModel>
```

### `open_drawio_csv`

Opens the draw.io editor with CSV data that gets converted to a diagram.

**⚠️ Note:** CSV relies on draw.io's server-side processing and may occasionally fail or be unavailable. Consider using Mermaid for org charts when possible.

**Parameters:**
- `content` (required): CSV content or URL to CSV file
- `lightbox` (optional): Open in read-only lightbox mode (default: false)
- `dark` (optional): Dark mode - "true" or "false" (default: false)

**⚠️ Avoid** using `%column%` placeholders in style attributes (like `fillColor=%color%`) - this can cause "URI malformed" errors.

### `open_drawio_mermaid`

Opens the draw.io editor with a Mermaid.js diagram definition.

**Parameters:**
- `content` (required): Mermaid.js syntax or URL to Mermaid file
- `lightbox` (optional): Open in read-only lightbox mode (default: false)
- `dark` (optional): Dark mode - "true" or "false" (default: false)

## MCP App Server Tool

### `create_diagram`

- **Input**: `{ xml: string }` - draw.io XML in mxGraphModel format
- **Output**: Interactive diagram rendered inline via the draw.io viewer library
- **Features**: Zoom, pan, layers, fullscreen, "Open in draw.io" button

## Quick Decision Guide

| Need | Use | Reliability |
|------|-----|-------------|
| Flowchart, sequence, ER diagram | `open_drawio_mermaid` | High |
| Custom styling, precise positioning | `open_drawio_xml` | High |
| Org chart from data | `open_drawio_csv` | Medium |

**Default to Mermaid** — it handles most diagram types reliably.

## Best Practices for LLMs

1. **Default to Mermaid**: It handles flowcharts, sequences, ER diagrams, Gantt charts, and more — all reliably
2. **Use XML for precision**: When you need exact positioning, custom colors, or complex layouts
3. **Avoid CSV for critical diagrams**: CSV processing can fail; prefer Mermaid for org charts when possible
4. **Validate syntax**: Ensure Mermaid/CSV/XML syntax is correct before sending
5. **Use URLs for large content**: For very large diagrams, consider hosting the content and passing a URL
6. **Return the URL to users**: Always provide the generated URL so users can open the diagram in their browser

## Troubleshooting

| Error | Cause | Solution |
|-------|-------|----------|
| "URI malformed" | Special characters in CSV style attributes | Use hardcoded colors instead of `%column%` placeholders |
| "Service nicht verfügbar" | draw.io CSV server unavailable | Retry later or use Mermaid instead |
| Blank diagram | Invalid Mermaid/XML syntax | Check syntax, ensure proper escaping |
| Diagram doesn't match expected | Mermaid version differences | Simplify syntax, avoid edge cases |
