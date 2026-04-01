import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { normalizeDiagramXml, INVALID_DIAGRAM_XML_MESSAGE } from "./normalize-diagram-xml.js";

/**
 * Build the self-contained HTML string that renders diagrams.
 * All dependencies (ext-apps App class, pako deflate) are inlined
 * so the HTML works in a sandboxed iframe with no extra fetches.
 *
 * @param {string} appWithDepsJs - The processed MCP Apps SDK bundle (exports stripped, App alias added).
 * @param {string} pakoDeflateJs - The pako deflate browser bundle.
 * @param {object} [options] - Optional configuration.
 * @param {string} [options.viewerJs] - If provided, inlines this JS instead of loading viewer-static.min.js from CDN.
 * @returns {string} Self-contained HTML string.
 */
export function buildHtml(appWithDepsJs, pakoDeflateJs, options)
{
  var viewerJs = (options && options.viewerJs) || null;
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>draw.io Diagram</title>
    <style>
      * { margin: 0; padding: 0; box-sizing: border-box; }

      html {
        color-scheme: light dark;
      }

      body {
        font-family: var(--font-sans, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif);
      }

      #loading {
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 24px;
        font-size: 14px;
        color: var(--color-text-secondary, #666);
      }

      .spinner {
        width: 20px; height: 20px;
        border: 2px solid var(--color-border, #e0e0e0);
        border-top-color: var(--color-text-primary, #1a1a1a);
        border-radius: 50%;
        animation: spin 0.8s linear infinite;
        margin-right: 8px;
      }
      @keyframes spin { to { transform: rotate(360deg); } }

      #diagram-container {
        display: none;
        min-width: 200px;
      }
      #diagram-container .mxgraph { width: 100%; max-width: 100%; color-scheme: light dark !important; }

      #toolbar {
        display: none;
        padding: 8px;
        gap: 6px;
      }
      #toolbar button, #toolbar a {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        padding: 6px 12px;
        font-size: 12px;
        font-family: inherit;
        border: 1px solid;
        border-radius: 6px;
        background: transparent;
        cursor: pointer;
        text-decoration: none;
        transition: background 0.15s;
      }

      #error {
        display: none;
        padding: 16px; margin: 16px;
        border: 1px solid #e74c3c;
        border-radius: 8px;
        background: #fdf0ef;
        color: #c0392b;
        font-size: 13px;
      }
    </style>
  </head>
  <body>
    <div id="loading"><div class="spinner"></div>Creating diagram...</div>
    <div id="error"></div>
    <div id="diagram-container"></div>
    <div id="toolbar">
      <button id="open-drawio">Open in draw.io</button>
      <button id="copy-xml-btn">Copy to Clipboard</button>
      <button id="fullscreen-btn">Fullscreen</button>
    </div>

    <!-- draw.io viewer -->
    ${viewerJs
      ? '<script>' + viewerJs + '<\/script>'
      : '<script src="https://viewer.diagrams.net/js/viewer-static.min.js" async><\/script>'
    }

    <!-- pako deflate (inlined, for #create URL generation) -->
    <script>${pakoDeflateJs}</script>

    <!-- MCP Apps SDK (inlined, exports stripped, App alias added) -->
    <script>
${appWithDepsJs}
${normalizeDiagramXml.toString()}

// --- XML healing for partial/streaming XML ---

/**
 * Heals a truncated XML string so it can be parsed. Removes incomplete
 * tags at the end and closes any open container tags.
 *
 * @param {string} partialXml - Potentially truncated XML string.
 * @returns {string|null} - Valid XML string, or null if too incomplete.
 */
function healPartialXml(partialXml)
{
  if (partialXml == null || typeof partialXml !== 'string')
  {
    return null;
  }

  // Must have at least <mxGraphModel and <root to be useful
  if (partialXml.indexOf('<root') === -1)
  {
    return null;
  }

  // Truncate at the last complete '>' to remove any half-written tag
  var lastClose = partialXml.lastIndexOf('>');

  if (lastClose === -1)
  {
    return null;
  }

  var xml = partialXml.substring(0, lastClose + 1);

  // Strip XML comments to avoid confusing the tag scanner.
  // Comments may span multiple lines and contain '<' or '>'.
  // Also remove any incomplete comment at the end (opened but not closed).
  var stripped = xml.replace(/<!--[\s\S]*?-->/g, '').replace(/<!--[\s\S]*$/, '');

  // Track open tags using a simple stack-based approach.
  // We scan for opening and closing tags, ignoring self-closing ones.
  var tagStack = [];
  var tagRegex = /<(\/?[a-zA-Z][a-zA-Z0-9]*)[^>]*?(\/?)>/g;
  var match;

  while ((match = tagRegex.exec(stripped)) !== null)
  {
    var nameOrClose = match[1];
    var selfClose = match[2];

    // Skip processing instructions (<?xml ...?>)
    if (match[0].charAt(1) === '?')
    {
      continue;
    }

    if (selfClose === '/')
    {
      // Self-closing tag, ignore
      continue;
    }

    if (nameOrClose.charAt(0) === '/')
    {
      // Closing tag - pop from stack if matching
      var closeName = nameOrClose.substring(1);

      if (tagStack.length > 0 && tagStack[tagStack.length - 1] === closeName)
      {
        tagStack.pop();
      }
    }
    else
    {
      // Opening tag
      tagStack.push(nameOrClose);
    }
  }

  // Close all remaining open tags in reverse order
  for (var i = tagStack.length - 1; i >= 0; i--)
  {
    xml += '</' + tagStack[i] + '>';
  }

  return xml;
}

// --- Client-side app logic ---

const loadingEl  = document.getElementById("loading");
const errorEl    = document.getElementById("error");
const containerEl = document.getElementById("diagram-container");
const toolbarEl  = document.getElementById("toolbar");
const openDrawioBtn  = document.getElementById("open-drawio");
const fullscreenBtn  = document.getElementById("fullscreen-btn");
const copyXmlBtn     = document.getElementById("copy-xml-btn");
var drawioEditUrl = null;
var currentXml = null;
var invalidDiagramXmlMessage = ${JSON.stringify(INVALID_DIAGRAM_XML_MESSAGE)};

// --- Streaming state ---
var graphViewer = null;
var streamingInitialized = false;

var app = new App({ name: "draw.io Diagram Viewer", version: "1.0.0" });

function showError(message)
{
  loadingEl.style.display = "none";
  errorEl.style.display = "block";
  errorEl.textContent = message;
}

function waitForGraphViewer()
{
  return new Promise(function(resolve, reject)
  {
    if (typeof GraphViewer !== "undefined") { resolve(); return; }

    var attempts = 0;
    var maxAttempts = 100; // 10 s
    var interval = setInterval(function()
    {
      attempts++;

      if (typeof GraphViewer !== "undefined")
      {
        clearInterval(interval);
        resolve();
      }
      else if (attempts >= maxAttempts)
      {
        clearInterval(interval);
        reject(new Error("draw.io viewer failed to load"));
      }
    }, 100);
  });
}

function generateDrawioEditUrl(xml)
{
  var encoded = encodeURIComponent(xml);
  var compressed = pako.deflateRaw(encoded);
  var base64 = btoa(Array.from(compressed, function(b) { return String.fromCharCode(b); }).join(""));
  var createObj = { type: "xml", compressed: true, data: base64 };

  return "https://app.diagrams.net/?pv=0&grid=0#create=" + encodeURIComponent(JSON.stringify(createObj));
}

async function renderDiagram(xml)
{
  try
  {
    await waitForGraphViewer();
  }
  catch(e)
  {
    showError("Failed to load the draw.io viewer. Check your network connection.");
    return;
  }

  containerEl.innerHTML = "";

  var config = {
    highlight: "#0000ff",
    "dark-mode": "auto",
    nav: true,
    resize: true,
    toolbar: "zoom layers tags",
    xml: xml
  };

  var graphDiv = document.createElement("div");
  graphDiv.className = "mxgraph";
  graphDiv.setAttribute("data-mxgraph", JSON.stringify(config));
  containerEl.appendChild(graphDiv);

  loadingEl.style.display = "none";
  containerEl.style.display = "block";
  toolbarEl.style.display = "flex";
  drawioEditUrl = generateDrawioEditUrl(xml);
  currentXml = xml;

  var bg = getComputedStyle(document.body).backgroundColor;
  GraphViewer.darkBackgroundColor = bg;

  // Use createViewerForElement with callback to capture the viewer instance
  var graphDiv2 = containerEl.querySelector('.mxgraph');

  if (graphDiv2 != null)
  {
    GraphViewer.createViewerForElement(graphDiv2, function(viewer)
    {
      graphViewer = viewer;
      notifySize();
    });
  }
  else
  {
    GraphViewer.processElements();
    notifySize();
  }
}

function notifySize()
{
  // GraphViewer renders asynchronously; nudge the SDK's ResizeObserver
  // by explicitly sending size after the SVG is in the DOM.
  requestAnimationFrame(function()
  {
    var el = document.documentElement;
    var w = Math.ceil(el.scrollWidth);
    var h = Math.ceil(el.scrollHeight);

    if (app.sendSizeChanged)
    {
      app.sendSizeChanged({ width: w, height: h });
    }
  });
}

// --- Streaming: incremental rendering as the LLM generates XML ---

app.ontoolinputpartial = function(params)
{
  var partialXml = params.arguments && params.arguments.xml;

  if (partialXml == null || typeof partialXml !== 'string')
  {
    return;
  }

  var healedXml = healPartialXml(partialXml);

  if (healedXml == null)
  {
    return;
  }

  // Update loading text during streaming
  if (loadingEl.style.display !== 'none')
  {
    loadingEl.querySelector('.spinner') && (loadingEl.innerHTML =
      '<div class="spinner"></div>Streaming diagram...');
  }

  if (typeof GraphViewer === 'undefined')
  {
    // Viewer not loaded yet, skip this partial update
    return;
  }

  try
  {
    var xmlDoc = mxUtils.parseXml(healedXml);
    var xmlNode = xmlDoc.documentElement;

    if (!streamingInitialized)
    {
      // First usable partial: do initial render
      streamingInitialized = true;
      containerEl.innerHTML = "";

      var graphDiv = document.createElement("div");
      containerEl.appendChild(graphDiv);

      loadingEl.style.display = "none";
      containerEl.style.display = "block";

      var bg = getComputedStyle(document.body).backgroundColor;
      GraphViewer.darkBackgroundColor = bg;

      var config = {
        highlight: "#0000ff",
        "dark-mode": "auto",
        nav: true,
        resize: true,
        toolbar: "zoom layers tags",
      };

      graphViewer = new GraphViewer(graphDiv, xmlNode, config);
      notifySize();
    }
    else if (graphViewer != null)
    {
      // Subsequent partials: merge delta
      graphViewer.mergeXmlDelta(xmlNode);
      notifySize();
    }
  }
  catch (e)
  {
    // Ignore parse errors from partial XML - next partial may fix it
    if (typeof console !== 'undefined')
    {
      console.debug('Partial XML parse/merge error:', e.message);
    }
  }
};

app.ontoolinput = function(params)
{
  var xml = params.arguments && params.arguments.xml;

  if (xml == null || typeof xml !== 'string')
  {
    return;
  }

  if (typeof GraphViewer === 'undefined')
  {
    return;
  }

  try
  {
    if (graphViewer != null)
    {
      // Final complete input: do a full setXmlNode to ensure accuracy
      var xmlDoc = mxUtils.parseXml(xml);
      graphViewer.pendingEdges = null;
      graphViewer.setXmlNode(xmlDoc.documentElement);
      currentXml = xml;
      drawioEditUrl = generateDrawioEditUrl(xml);
      toolbarEl.style.display = "flex";
      notifySize();
    }
    else
    {
      // No streaming happened, render normally
      renderDiagram(xml);
    }
  }
  catch (e)
  {
    if (typeof console !== 'undefined')
    {
      console.error('Final input render error:', e.message);
    }
  }
};

app.ontoolresult = function(result)
{
  var textBlock = result.content && result.content.find(function(c) { return c.type === "text"; });

  if (textBlock && textBlock.type === "text")
  {
    var normalizedXml = normalizeDiagramXml(textBlock.text);

    if (normalizedXml)
    {
      if (graphViewer != null)
      {
        // Final authoritative render from server
        try
        {
          var xmlDoc = mxUtils.parseXml(normalizedXml);
          graphViewer.pendingEdges = null;
          graphViewer.setXmlNode(xmlDoc.documentElement);
          currentXml = normalizedXml;
          drawioEditUrl = generateDrawioEditUrl(normalizedXml);
          toolbarEl.style.display = "flex";
          notifySize();
        }
        catch (e)
        {
          // Fallback to full re-render
          renderDiagram(normalizedXml);
        }
      }
      else
      {
        renderDiagram(normalizedXml);
      }
    }
    else
    {
      showError(invalidDiagramXmlMessage);
    }
  }
  else
  {
    showError(invalidDiagramXmlMessage);
  }
};

openDrawioBtn.addEventListener("click", function()
{
  if (drawioEditUrl)
  {
    app.openLink({ url: drawioEditUrl });
  }
});

copyXmlBtn.addEventListener("click", function()
{
  if (!currentXml) return;

  var ta = document.createElement("textarea");
  ta.value = currentXml;
  ta.style.position = "fixed";
  ta.style.left = "-9999px";
  document.body.appendChild(ta);
  ta.select();
  document.execCommand("copy");
  document.body.removeChild(ta);
  copyXmlBtn.textContent = "Copied!";
  setTimeout(function() { copyXmlBtn.textContent = "Copy to Clipboard"; }, 2000);
});

fullscreenBtn.addEventListener("click", function()
{
  app.requestDisplayMode({ mode: "fullscreen" });
});

app.connect();
    </script>
  </body>
</html>`;
}

/**
 * Read the app-with-deps.js bundle, strip ESM exports, and create a local App alias.
 *
 * @param {string} raw - The raw content of app-with-deps.js.
 * @returns {string} The processed bundle with exports stripped and App alias added.
 */
export function processAppBundle(raw)
{
  const exportMatch = raw.match(/export\s*\{([^}]+)\}\s*;?\s*$/);

  if (!exportMatch)
  {
    throw new Error("Could not find export statement in app-with-deps.js");
  }

  const exportEntries = exportMatch[1].split(",").map(function(e)
  {
    const parts = e.trim().split(/\s+as\s+/);
    return { local: parts[0], exported: parts[1] || parts[0] };
  });

  const appEntry = exportEntries.find(function(e) { return e.exported === "App"; });

  if (!appEntry)
  {
    throw new Error("Could not find App export in app-with-deps.js");
  }

  return raw.slice(0, exportMatch.index) + `\nvar App = ${appEntry.local};\n`;
}

/**
 * Create a new MCP server instance with the create_diagram tool + UI resource.
 *
 * @param {string} html - The pre-built, self-contained HTML string.
 * @param {object} [options] - Options.
 * @param {string} [options.domain] - Widget domain for ChatGPT sandbox rendering (e.g. "https://mcp.draw.io").
 * @param {object} [options.serverOptions] - Optional McpServer constructor options (e.g. jsonSchemaValidator).
 * @returns {McpServer}
 */
export function createServer(html, options = {})
{
  const { domain, serverOptions = {} } = typeof options === "object" && options !== null
    ? options
    : { serverOptions: options };
  const server = new McpServer(
    { name: "drawio-mcp-app", version: "1.0.0" },
    serverOptions,
  );

  const resourceUri = "ui://drawio/mcp-app.html";

  registerAppTool(
    server,
    "create_diagram",
    {
      title: "Create Diagram",
      description:
        "Creates and displays an interactive draw.io diagram. Pass draw.io XML (mxGraphModel format) to render it inline. " +
        "IMPORTANT: The XML must be well-formed. Do NOT use double hyphens (--) inside XML comments, as this is invalid XML and will break the parser. Use single hyphens or rephrase instead (e.g. <!-- Order 1 to OrderItem --> not <!-- Order 1 --- OrderItem -->). " +
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
        xml: z
          .string()
          .describe(
            "The draw.io XML content in mxGraphModel format to render as a diagram. Must be well-formed XML: no double hyphens (--) inside comments, no unescaped special characters in attribute values."
          ),
      },
      annotations:
      {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      _meta:
      {
        ui: { resourceUri },
        "openai/toolInvocation/invoking": "Creating diagram...",
        "openai/toolInvocation/invoked": "Diagram ready.",
      },
    },
    async function({ xml })
    {
      var normalizedXml = normalizeDiagramXml(xml) || xml;

      return {
        structuredContent: { type: "diagram", format: "drawio-xml" },
        content: [{ type: "text", text: normalizedXml }],
      };
    }
  );

  registerAppResource(
    server,
    "Draw.io Diagram Viewer",
    resourceUri,
    { mimeType: RESOURCE_MIME_TYPE },
    async function()
    {
      return {
        contents:
        [
          {
            uri: resourceUri,
            mimeType: RESOURCE_MIME_TYPE,
            text: html,
            _meta:
            {
              ui:
              {
                ...(domain ? { domain } : {}),
                csp:
                {
                  resourceDomains: ["https://viewer.diagrams.net"],
                  connectDomains: ["https://viewer.diagrams.net"],
                },
              },
            },
          },
        ],
      };
    }
  );

  return server;
}
