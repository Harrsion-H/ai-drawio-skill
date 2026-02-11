# Draw.io MCP Server

The official [draw.io](https://www.draw.io) MCP (Model Context Protocol) server that enables LLMs to create and open diagrams in the draw.io editor.

## Three Ways to Create Diagrams

This repository offers three approaches for integrating draw.io with AI assistants. Pick the one that fits your setup:

| | [MCP Tool Server](#mcp-tool-server) | [MCP App Server](#mcp-app-server) | [Project Instructions](#alternative-project-instructions-no-mcp-required) |
|---|---|---|---|
| **How it works** | Opens diagrams in your browser | Renders diagrams inline in chat | Claude generates draw.io URLs via Python |
| **Diagram output** | draw.io editor in a new tab | Interactive viewer embedded in conversation | Clickable link to draw.io |
| **Requires installation** | Yes (npm package) | Yes (Node.js server or CF Worker) | No — just paste instructions |
| **Supports XML, CSV, Mermaid** | ✅ All three | XML only | ✅ All three |
| **Editable in draw.io** | ✅ Directly | Via "Open in draw.io" button | Via link |
| **Works with** | Claude Desktop, any MCP client | Claude.ai, VS Code, any MCP Apps host | Claude.ai (with Projects) |
| **Best for** | Local desktop workflows | Inline previews in chat | Quick setup, no install needed |

---

## MCP Tool Server

The original MCP server that opens diagrams directly in the draw.io editor. Supports XML, CSV, and Mermaid.js formats with lightbox and dark mode options. Published as [`@drawio/mcp`](https://www.npmjs.com/package/@drawio/mcp) on npm.

Quick start: `npx @drawio/mcp`

**[Full documentation →](mcp-tool-server/README.md)**

---

## MCP App Server

The MCP App server renders draw.io diagrams **inline** in AI chat interfaces using the [MCP Apps](https://modelcontextprotocol.io/docs/extensions/apps) protocol. Instead of opening a browser tab, diagrams appear directly in the conversation as interactive iframes.

It can run locally via Node.js or be deployed to Cloudflare Workers for a public endpoint without tunnels.

**[Full documentation →](mcp-app-server/README.md)**

> **Note:** Inline diagram rendering requires an MCP host that supports the MCP Apps extension. In hosts without MCP Apps support, the tool still works but returns the XML as text.

---

## Alternative: Project Instructions (No MCP Required)

An alternative approach that works **without installing anything**. Add instructions to a Claude Project that teach Claude to generate draw.io URLs using Python code execution. No MCP server, no desktop app — just paste and go.

**[Full documentation →](project-instructions/README.md)**

---

## Development

```bash
# MCP Tool Server
cd mcp-tool-server
npm install
npm start

# MCP App Server
cd mcp-app-server
npm install
npm start
```

## Related Resources

- [draw.io](https://www.draw.io) - Free online diagram editor
- [draw.io Desktop](https://github.com/jgraph/drawio-desktop) - Desktop application
- [@drawio/mcp on npm](https://www.npmjs.com/package/@drawio/mcp) - This package on npm
- [drawio-mcp on GitHub](https://github.com/jgraph/drawio-mcp) - Source code repository
- [Mermaid.js Documentation](https://mermaid.js.org/intro/)
- [MCP Specification](https://modelcontextprotocol.io/)
- [MCP Apps Extension](https://modelcontextprotocol.io/docs/extensions/apps)
