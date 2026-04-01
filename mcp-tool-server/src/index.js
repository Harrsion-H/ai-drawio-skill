#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import pako from "pako";
import { spawn } from "child_process";
import { writeFileSync, unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const DRAWIO_BASE_URL = "https://app.diagrams.net/";

/**
 * Opens a URL in the default browser (cross-platform)
 */
function openBrowser(url)
{
  let child;

  if (process.platform === "win32")
  {
    // cmd.exe's "start" command treats & as a command separator and
    // drops everything after # in URLs, so the #create=... fragment
    // (which carries the entire diagram payload) is silently lost.
    // Writing a temporary .url file preserves the full URL intact.
    const tmpFile = join(tmpdir(), "drawio-mcp-" + Date.now() + ".url");
    writeFileSync(tmpFile, "[InternetShortcut]\r\nURL=" + url + "\r\n");
    child = spawn("cmd", ["/c", "start", "", tmpFile], { shell: false, stdio: "ignore" });

    setTimeout(function()
    {
      try { unlinkSync(tmpFile); } catch (e) { /* ignore */ }
    }, 10000);
  }
  else if (process.platform === "darwin")
  {
    child = spawn("open", [url], { shell: false, stdio: "ignore" });
  }
  else
  {
    child = spawn("xdg-open", [url], { shell: false, stdio: "ignore" });
  }

  child.on("error", function(error)
  {
    console.error(`Failed to open browser: ${error.message}`);
  });

  child.unref();
}

/**
 * Compresses data using pako deflateRaw and encodes as base64
 * This matches the compression used by draw.io tools
 */
function compressData(data)
{
  if (!data || data.length === 0)
  {
    return data;
  }
  const encoded = encodeURIComponent(data);
  const compressed = pako.deflateRaw(encoded);
  return Buffer.from(compressed).toString("base64");
}

/**
 * Generates a draw.io URL with the #create hash parameter
 */
function generateDrawioUrl(data, type, options = {})
{
  const {
    lightbox = false,
    border = 10,
    dark = false,
    edit = "_blank",
  } = options;

  const compressedData = compressData(data);

  const createObj = {
    type: type,
    compressed: true,
    data: compressedData,
  };

  const params = new URLSearchParams();

  if (lightbox)
  {
    params.set("lightbox", "1");
    params.set("edit", "_blank");
    params.set("border", "10");
  }
  else
  {
    params.set("grid", "0");
    params.set("pv", "0");
  }

  if (dark === true)
  {
    params.set("dark", "1");
  }

  params.set("border", border.toString());
  params.set("edit", edit);

  const createHash = "#create=" + encodeURIComponent(JSON.stringify(createObj));
  const paramsStr = params.toString();

  return DRAWIO_BASE_URL + (paramsStr ? "?" + paramsStr : "") + createHash;
}

// Define the tools
const tools =
[
  {
    name: "open_drawio_xml",
    description:
      "Opens the draw.io editor with a diagram from XML content. " +
      "Use this to view, edit, or create diagrams in draw.io format. " +
      "The XML should be valid draw.io/mxGraph XML format. " +
      "IMPORTANT: Do NOT use double hyphens (--) inside XML comments, as this is invalid XML and will break the parser. Use single hyphens or rephrase instead. " +
      "EDGE GEOMETRY: Every edge mxCell MUST contain a <mxGeometry relative=\"1\" as=\"geometry\" /> child element, even when there are no waypoints. Self-closing edge cells (<mxCell ... edge=\"1\" ... />) are invalid and will not render correctly. " +
      "EDGE ROUTING: Use edgeStyle=orthogonalEdgeStyle for right-angle connectors. " +
      "Space nodes at least 60px apart to avoid overlapping edges. " +
      "Use exitX/exitY/entryX/entryY (0-1) to control which side of a node an edge connects to, spreading connections across different sides. " +
      "Add explicit waypoints via <Array as=\"points\"><mxPoint x=\"...\" y=\"...\"/></Array> inside mxGeometry when edges would overlap. " +
      "ARROWHEAD CLEARANCE: The final straight segment of an edge (between the last bend and the target, or source and first bend) must be long enough to fit the arrowhead (default size 6, configurable via startSize/endSize). If too short, the arrowhead overlaps the bend. Ensure at least 20px of straight segment. The orthogonal auto-router can place bends too close to shapes when nodes are nearly aligned - fix by increasing spacing or adding explicit waypoints. " +
      "CONTAINERS: For architecture diagrams and any diagram with nested elements, use proper parent-child containment (set parent=\"containerId\" on children, use relative coordinates). " +
      "Container types: (1) group style (style=\"group;\") for invisible containers with no connections - includes pointerEvents=0 so child connections are not captured by the container; " +
      "(2) swimlane style (style=\"swimlane;startSize=30;\") for labeled containers with a title bar - use when the container needs visual borders/headers or when the container itself has connections; " +
      "(3) any shape can be a container by adding container=1 to its style, but also add pointerEvents=0 unless the container itself needs to be connectable. " +
      "Always use pointerEvents=0 on container styles that should not capture connections being rewired between children. " +
      "EDGE LABELS: Do NOT wrap edge labels in HTML markup to reduce font size. The default font size for edge labels is already 11px (vs 12px for vertices), so they are already smaller. Just set the value attribute directly. " +
      "LAYOUT: Align nodes to a grid (multiples of 10). Use consistent spacing (e.g., 200px horizontal, 120px vertical between nodes). " +
      "DARK MODE COLORS: To enable dark mode color adaptation, the mxGraphModel element must include adaptiveColors=\"auto\". " +
      "strokeColor, fillColor, and fontColor default to 'default', which renders as black in light theme and white in dark theme. " +
      "Explicit colors (e.g. fillColor=#DAE8FC) specify the light-mode color; the dark-mode color is computed automatically by inverting RGB values and rotating the hue 180 degrees. " +
      "To specify both colors explicitly, use light-dark(lightColor,darkColor) in the style string, e.g. fontColor=light-dark(#7EA6E0,#FF0000). " +
      "See https://www.drawio.com/doc/faq/drawio-style-reference.html for the complete style reference.",
    inputSchema:
    {
      type: "object",
      properties:
      {
        content:
        {
          type: "string",
          description:
            "The draw.io XML content in mxGraphModel format.",
        },
        lightbox:
        {
          type: "boolean",
          description: "Open in lightbox mode (read-only view). Default: false",
        },
        dark:
        {
          type: "string",
          enum: ["auto", "true", "false"],
          description: "Dark mode setting. Default: auto",
        },
      },
      required: ["content"],
    },
  },
  {
    name: "open_drawio_csv",
    description:
      "Opens the draw.io editor with a diagram generated from CSV data. " +
      "The CSV format should follow draw.io's CSV import specification which allows " +
      "creating org charts, flowcharts, and other diagrams from tabular data.",
    inputSchema:
    {
      type: "object",
      properties:
      {
        content:
        {
          type: "string",
          description:
            "The CSV content following draw.io's CSV import format.",
        },
        lightbox:
        {
          type: "boolean",
          description: "Open in lightbox mode (read-only view). Default: false",
        },
        dark:
        {
          type: "string",
          enum: ["auto", "true", "false"],
          description: "Dark mode setting. Default: auto",
        },
      },
      required: ["content"],
    },
  },
  {
    name: "open_drawio_mermaid",
    description:
      "Opens the draw.io editor with a diagram generated from Mermaid.js syntax. " +
      "Supports flowcharts, sequence diagrams, class diagrams, state diagrams, " +
      "entity relationship diagrams, and more using Mermaid.js syntax.",
    inputSchema:
    {
      type: "object",
      properties:
      {
        content:
        {
          type: "string",
          description:
            "The Mermaid.js diagram definition. " +
            "Example: 'graph TD; A-->B; B-->C;'",
        },
        lightbox:
        {
          type: "boolean",
          description: "Open in lightbox mode (read-only view). Default: false",
        },
        dark:
        {
          type: "string",
          enum: ["auto", "true", "false"],
          description: "Dark mode setting. Default: auto",
        },
      },
      required: ["content"],
    },
  },
];

// Create the MCP server
const server = new Server(
  {
    name: "drawio-mcp",
    version: "1.0.0",
  },
  {
    capabilities:
    {
      tools: {},
    },
  }
);

// Handle tool listing
server.setRequestHandler(ListToolsRequestSchema, async () =>
{
  return { tools };
});

// Handle tool execution
server.setRequestHandler(CallToolRequestSchema, async (request) =>
{
  const { name, arguments: args } = request.params;

  try
  {
    let content;
    let type;
    const lightbox = args?.lightbox === true;
    const darkArg = args?.dark;
    const dark = darkArg === "true" ? true : darkArg === "false" ? false : "auto";

    const inputContent = args?.content;

    if (!inputContent)
    {
      return {
        content:
        [
          {
            type: "text",
            text: "Error: content parameter is required",
          },
        ],
        isError: true,
      };
    }

    content = inputContent;

    switch (name)
    {
      case "open_drawio_xml":
        type = "xml";
        break;
      case "open_drawio_csv":
        type = "csv";
        break;
      case "open_drawio_mermaid":
        type = "mermaid";
        break;
      default:
        return {
          content:
          [
            {
              type: "text",
              text: `Error: Unknown tool "${name}"`,
            },
          ],
          isError: true,
        };
    }

    const url = generateDrawioUrl(content, type, { lightbox, dark });

    // Open the URL in the default browser
    openBrowser(url);

    return {
      content:
      [
        {
          type: "text",
          text: `Draw.io Editor URL:\n${url}\n\nThe diagram has been opened in your default browser.`,
        },
      ],
    };
  }
  catch (error)
  {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      content:
      [
        {
          type: "text",
          text: `Error: ${errorMessage}`,
        },
      ],
      isError: true,
    };
  }
});

// Start the server
async function main()
{
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Draw.io MCP server running on stdio");
}

main().catch((error) =>
{
  console.error("Fatal error:", error);
  process.exit(1);
});
