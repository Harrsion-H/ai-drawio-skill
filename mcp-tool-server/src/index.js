#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import pako from "pako";
import { exec } from "child_process";

const DRAWIO_BASE_URL = "https://app.diagrams.net/";

/**
 * Opens a URL in the default browser (cross-platform)
 */
function openBrowser(url)
{
  const platform = process.platform;
  let command;

  if (platform === "win32")
  {
    command = `start "" "${url}"`;
  }
  else if (platform === "darwin")
  {
    command = `open "${url}"`;
  }
  else
  {
    command = `xdg-open "${url}"`;
  }

  exec(command, (error) =>
  {
    if (error)
    {
      console.error(`Failed to open browser: ${error.message}`);
    }
  });
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
      "IMPORTANT: Do NOT use double hyphens (--) inside XML comments, as this is invalid XML and will break the parser. Use single hyphens or rephrase instead.",
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
