# Draw.io MCP Tool Server

The original MCP server that opens diagrams directly in the draw.io editor. Published as [`@drawio/mcp`](https://www.npmjs.com/package/@drawio/mcp) on npm.

## Features

- **Open XML diagrams**: Load native draw.io/mxGraph XML format
- **Import CSV data**: Convert tabular data to diagrams (org charts, flowcharts, etc.)
- **Render Mermaid.js**: Transform Mermaid syntax into editable draw.io diagrams
- **URL support**: Fetch content from URLs automatically
- **Customizable display**: Lightbox mode, dark mode, and more

## Installation

### Using npx (recommended)

```bash
npx @drawio/mcp
```

### Global installation

```bash
npm install -g @drawio/mcp
drawio-mcp
```

### From source

```bash
git clone https://github.com/jgraph/drawio-mcp.git
cd drawio-mcp/mcp-tool-server
npm install
npm start
```

## Configuration

### Claude Desktop

Add to your Claude Desktop configuration file:

**macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
**Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "drawio": {
      "command": "npx",
      "args": ["@drawio/mcp"]
    }
  }
}
```

### Other MCP Clients

Configure your MCP client to run the server via stdio:

```bash
npx @drawio/mcp
```

## Tools

### `open_drawio_xml`

Opens the draw.io editor with XML content.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `content` | string | Yes | Draw.io XML or URL to XML |
| `lightbox` | boolean | No | Read-only view mode (default: false) |
| `dark` | string | No | "auto", "true", or "false" (default: "auto") |

### `open_drawio_csv`

Opens the draw.io editor with CSV data converted to a diagram.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `content` | string | Yes | CSV content or URL to CSV |
| `lightbox` | boolean | No | Read-only view mode (default: false) |
| `dark` | string | No | "auto", "true", or "false" (default: "auto") |

### `open_drawio_mermaid`

Opens the draw.io editor with a Mermaid.js diagram.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `content` | string | Yes | Mermaid syntax or URL |
| `lightbox` | boolean | No | Read-only view mode (default: false) |
| `dark` | string | No | "auto", "true", or "false" (default: "auto") |

## Example Prompts

- "Use `open_drawio_mermaid` to create a sequence diagram showing OAuth2 authentication flow"
- "Use `open_drawio_csv` to create an org chart: CEO → CTO, CFO; CTO → 3 Engineers"
- "Use `open_drawio_xml` to create a detailed AWS architecture diagram with VPC, subnets, and security groups"

> **Tip:** Claude Desktop may have multiple ways to create diagrams. To ensure it uses the draw.io MCP, mention the tool name explicitly or add a system instruction:
> *"Always use the draw.io MCP tools to create diagrams."*

## How It Works

1. The MCP server receives diagram content (XML, CSV, or Mermaid)
2. Content is compressed using pako deflateRaw and encoded as base64
3. A draw.io URL is generated with the `#create` hash parameter
4. The URL is returned to the LLM, which can present it to the user
5. Opening the URL loads draw.io with the diagram ready to view/edit
