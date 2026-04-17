import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { normalizeDiagramXml, INVALID_DIAGRAM_XML_MESSAGE } from "./normalize-diagram-xml.js";
import postprocessModule from "../../postprocessor/postprocess.js";
var postprocessDiagramXml = postprocessModule.postprocess;

// Cloudflare Workers don't give you wall-clock time at module-init —
// new Date() at top-level returns epoch (1970). We lazy-initialize
// the version string on first request (which has real wall-clock),
// and cache it. Value will be close to "first request after the
// worker cold-started" which is a few ms after deploy rollout.
var _buildVersion = null;
function getBuildVersion()
{
  if (_buildVersion == null)
  {
    _buildVersion = "drawio-mcp-" + new Date().toISOString();
  }
  return _buildVersion;
}

/**
 * Build the self-contained HTML string that renders diagrams.
 * All dependencies (ext-apps App class, pako deflate, drawio-mermaid)
 * are inlined so the HTML works in a sandboxed iframe with no extra
 * fetches.
 *
 * @param {string} appWithDepsJs - The processed MCP Apps SDK bundle (exports stripped, App alias added).
 * @param {string} pakoDeflateJs - The pako deflate browser bundle.
 * @param {string} mermaidJs - The drawio-mermaid IIFE bundle (dist/mermaid.bundled.js). Exposes `mxMermaidToDrawio.parseText(text, config)`.
 * @param {object} [options] - Optional configuration.
 * @param {string} [options.viewerJs] - If provided, inlines this JS instead of loading viewer-static.min.js from CDN.
 * @returns {string} Self-contained HTML string.
 */
export function buildHtml(appWithDepsJs, pakoDeflateJs, mermaidJs, options)
{
  var viewerJs = (options && options.viewerJs) || null;
  var mxElkLayoutJs = (options && options.mxElkLayoutJs) || null;
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <base href="https://app.diagrams.net/" />
    <title>draw.io Diagram</title>
    <link rel="icon" href="/favicon.png" type="image/png" />
    <style>
      * { margin: 0; padding: 0; box-sizing: border-box; }

      html {
        color-scheme: light dark;
        overflow: hidden;
      }

      body {
        font-family: var(--font-sans, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif);
        overflow: hidden;
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
        max-width: 100%;
        overflow: hidden;
      }
      #diagram-container.streaming {
        min-height: 320px;
        max-height: 650px;
        position: relative;
      }
      #diagram-container.streaming > div {
        width: 100% !important;
        height: 100% !important;
        overflow: hidden !important;
      }
      /* GraphViewer sets inline width on its wrappers based on the
         diagram's natural width, which can exceed the iframe width and
         create a horizontal scrollbar between the SVG and the toolbar.
         !important + descendant rules force everything to fit. */
      #diagram-container .mxgraph,
      #diagram-container .mxgraph > div,
      #diagram-container .mxgraph > div > div {
        max-width: 100% !important;
        overflow: hidden !important;
      }
      #diagram-container .mxgraph {
        width: 100% !important;
        color-scheme: light dark !important;
      }
      #diagram-container .mxgraph > svg,
      #diagram-container .mxgraph svg {
        max-width: 100% !important;
        height: auto;
      }

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

      #mermaid-preview {
        display: none;
        padding: 16px;
        font-family: 'SF Mono', 'Menlo', 'Monaco', 'Consolas', monospace;
        font-size: 13px;
        line-height: 1.5;
        white-space: pre-wrap;
        word-break: break-word;
        overflow-y: auto;
        max-height: 500px;
        background: var(--color-bg-secondary, #f5f5f5);
        border-radius: 8px;
        margin: 8px;
        color: var(--color-text-primary, #1a1a1a);
      }
    </style>
  </head>
  <body>
    <div id="loading"><div class="spinner"></div>Creating diagram...</div>
    <div id="error"></div>
    <pre id="mermaid-preview"></pre>
    <div id="diagram-container"></div>
    <div id="toolbar">
      <button id="open-drawio">Open in draw.io</button>
      <button id="copy-xml-btn">Copy to Clipboard</button>
      <button id="fullscreen-btn">Fullscreen</button>
    </div>

    <!-- draw.io viewer -->
    <script>window.DRAWIO_BASE_URL = "https://app.diagrams.net";<\/script>
    ${viewerJs
      ? '<script>' + viewerJs + '<\/script>'
      : '<script src="https://viewer.diagrams.net/js/viewer-static.min.js"><\/script>'
    }

    <!-- pako deflate (inlined, for #create URL generation) -->
    <script>${pakoDeflateJs}</script>

    <!-- drawio-mermaid (inlined). Exposes mxMermaidToDrawio.parseText(text, config).
         Loaded after the viewer so mermaidShapes.js can see mxCellRenderer/mxActor. -->
    <script>
      // mxMermaidToDrawio.parseText() reads EditorUi.prototype.emptyDiagramXml
      // as a fallback when a diagram type isn't supported. Stub it defensively
      // — the real value comes from the viewer, but parseText can be called
      // before that's wired up in some error paths.
      if (typeof EditorUi !== 'undefined' && EditorUi.prototype.emptyDiagramXml == null)
      {
        EditorUi.prototype.emptyDiagramXml = '<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel>';
      }
    </script>
    <script>${mermaidJs}</script>

    ${mxElkLayoutJs
      ? '<!-- mxElkLayout wrapper: buildElkGraph, applyElkLayout, executeAsync. Depends on mxGraph (viewer) + ELK (published on window by drawio-mermaid above). -->\n    <script>' + mxElkLayoutJs + '<\/script>'
      : ''
    }

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
  var tagRegex = new RegExp('\\x3c(\\/?[a-zA-Z][a-zA-Z0-9]*)[^>]*?(\\/?)\x3e', 'g');
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

// --- Mermaid streaming: heal partial text + content-address cell IDs ---

// De-dupe: last healed+parsed text we merged. Reset on endStreaming.
var lastMergedMermaidText = null;

/**
 * Keeps only cell IDs whose parent is the default root ('1') — i.e.,
 * top-level cells, not nested children. Used to skip per-cell pop
 * animations on nested structures (ER table rows, flowchart subgraph
 * contents) so pops happen at the container level only.
 */
function filterTopLevelCellIds(graph, ids)
{
  if (graph == null || ids == null) return [];
  var model = graph.getModel();
  var out = [];

  for (var i = 0; i < ids.length; i++)
  {
    var cell = model.getCell(ids[i]);
    if (cell == null) continue;
    var p = cell.parent;
    if (p == null) continue;
    if (p.id === '1') out.push(ids[i]);
  }

  return out;
}

/**
 * Keeps only IDs whose cell is a vertex. Used to feed the smart-camera
 * focus tracker — edges can span the full diagram and would bloat the
 * "hot region" bbox, defeating the close-up focus on new content.
 */
function filterVertexCellIds(graph, ids)
{
  if (graph == null || ids == null) return [];
  var model = graph.getModel();
  var out = [];

  for (var i = 0; i < ids.length; i++)
  {
    var cell = model.getCell(ids[i]);
    if (cell != null && cell.vertex) out.push(ids[i]);
  }

  return out;
}

/**
 * Trims a partial mermaid string so the parser doesn't choke on a
 * half-typed last line. Returns null when there isn't enough content
 * to attempt a parse yet (no complete line, or no body after the type
 * declaration).
 *
 * @param {string} partialText
 * @returns {string|null}
 */
function healMermaidText(partialText)
{
  if (partialText == null || typeof partialText !== 'string') return null;

  var lastNewline = partialText.lastIndexOf('\\n');
  if (lastNewline < 0) return null; // single line, possibly incomplete

  var trimmed = partialText.substring(0, lastNewline);
  // Need at least a type declaration and one body line — i.e. another newline
  // somewhere in the trimmed prefix.
  if (trimmed.indexOf('\\n') < 0) return null;

  return trimmed;
}

/**
 * 32-bit FNV-1a hash, hex string. Stable across runs and across browsers.
 * Used to derive content-addressed cell IDs.
 */
function hashString32(s)
{
  var h = 0x811c9dc5;
  for (var i = 0; i < s.length; i++)
  {
    h ^= s.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return ('00000000' + h.toString(16)).slice(-8);
}

/**
 * Rewrites every cell ID in a mermaid-emitted mxGraphModel XML string to
 * a deterministic content-addressed value, so prefix re-parses produce
 * stable IDs for shared cells. Internal ID references (parent, source,
 * target) are rewritten consistently.
 *
 * The hash key for each cell is built from properties that don't change
 * across prefix parses: parent's stable ID, value, style, and (for edges)
 * the source/target stable IDs. Collisions on identical content are
 * disambiguated with a #1, #2, ... suffix preserved by document order.
 *
 * Roots '0' and '1' are passed through verbatim — streamInsertCell
 * special-cases them.
 *
 * @param {string} xml - mxGraphModel XML returned by mxMermaidToDrawio.parseText
 * @returns {string} XML with stabilized IDs (or the original on error)
 */
function stabilizeMermaidIds(xml)
{
  if (xml == null || typeof xml !== 'string') return xml;
  if (typeof mxUtils === 'undefined' || typeof mxUtils.parseXml !== 'function') return xml;

  var doc;
  try { doc = mxUtils.parseXml(xml); }
  catch (e) { return xml; }

  var top = doc.documentElement;
  var rootEl = null;

  if (top.nodeName === 'root') rootEl = top;
  else if (top.nodeName === 'mxGraphModel')
  {
    var rs = top.getElementsByTagName('root');
    if (rs.length > 0) rootEl = rs[0];
  }

  if (rootEl == null) return xml;

  var idMap = { '0': '0', '1': '1' };
  var collisionCount = {};

  function makeStableId(prefix, contentKey)
  {
    var base = prefix + '_' + hashString32(contentKey);
    var n = collisionCount[base];

    if (n == null)
    {
      collisionCount[base] = 0;
      return base;
    }

    n += 1;
    collisionCount[base] = n;
    return base + '_' + n;
  }

  var children = rootEl.childNodes;

  // Resolve the (carrier, attrSrc) pair for a child node. UserObject /
  // object wrappers carry the id externally and everything else on an
  // inner <mxCell>; plain <mxCell> cells carry both on themselves.
  function pair(node)
  {
    var inner = null;

    if (node.nodeName === 'UserObject' || node.nodeName === 'object')
    {
      var innerCells = node.getElementsByTagName('mxCell');
      if (innerCells.length > 0) inner = innerCells[0];
    }

    return { carrier: node, attrSrc: (inner != null) ? inner : node };
  }

  // Two-pass rename. The gitgraph cell factory (and possibly others in
  // the future) re-orders cells after creation so edges can land before
  // the vertices they reference in document order. A single-pass rename
  // that processes cells in document order would hit each edge with an
  // empty idMap and silently skip the source/target rewrite, orphaning
  // the edge. Pass 1 populates idMap for every non-edge cell so pass 2
  // can always resolve source/target stable IDs — and so the edge's own
  // content key (which incorporates the stable source/target) remains
  // deterministic regardless of sibling order.
  for (var i = 0; i < children.length; i++)
  {
    var node = children[i];
    if (node.nodeType !== 1) continue;

    var p = pair(node);
    var oldId = p.carrier.getAttribute('id');

    if (oldId == null || oldId === '0' || oldId === '1') continue;
    if (p.attrSrc.getAttribute('edge') === '1') continue;

    var value = p.carrier.getAttribute('value') || p.attrSrc.getAttribute('value') || '';
    var isVertex = p.attrSrc.getAttribute('vertex') === '1';
    var parentId = p.attrSrc.getAttribute('parent');

    var stableParent = (parentId != null && idMap[parentId] != null)
      ? idMap[parentId] : (parentId || '1');

    // NB: 'style' is intentionally NOT in the content key — mermaid
    // mutates a cell's style as more context arrives (classDef applied
    // later, theme adjustments) which would otherwise re-hash the cell
    // to a new ID and orphan the original in the model. Style changes
    // are still applied on each merge via the existing-cell update path.
    idMap[oldId] = makeStableId(isVertex ? 'v' : 'c', stableParent + '|' + value);
  }

  // Pass 2: rewrite IDs and references. Edges now see a complete idMap
  // and get deterministic source/target-derived content keys.
  for (var i = 0; i < children.length; i++)
  {
    var node = children[i];
    if (node.nodeType !== 1) continue;

    var p = pair(node);
    var oldId = p.carrier.getAttribute('id');

    if (oldId == null || oldId === '0' || oldId === '1') continue;

    var parentId = p.attrSrc.getAttribute('parent');
    var sourceId = p.attrSrc.getAttribute('source');
    var targetId = p.attrSrc.getAttribute('target');
    var isEdge = p.attrSrc.getAttribute('edge') === '1';

    var stableParent = (parentId != null && idMap[parentId] != null)
      ? idMap[parentId] : (parentId || '1');

    if (isEdge)
    {
      var value = p.carrier.getAttribute('value') || p.attrSrc.getAttribute('value') || '';
      var stableSrc = (sourceId != null && idMap[sourceId] != null) ? idMap[sourceId] : (sourceId || '');
      var stableTgt = (targetId != null && idMap[targetId] != null) ? idMap[targetId] : (targetId || '');
      idMap[oldId] = makeStableId('e', stableSrc + '|' + stableTgt + '|' + value);
    }

    p.carrier.setAttribute('id', idMap[oldId]);

    if (parentId != null) p.attrSrc.setAttribute('parent', stableParent);
    if (sourceId != null && idMap[sourceId] != null) p.attrSrc.setAttribute('source', idMap[sourceId]);
    if (targetId != null && idMap[targetId] != null) p.attrSrc.setAttribute('target', idMap[targetId]);
  }

  return mxUtils.getXml(top);
}

// --- Client-side app logic ---

const loadingEl  = document.getElementById("loading");
const errorEl    = document.getElementById("error");
const containerEl = document.getElementById("diagram-container");
const toolbarEl  = document.getElementById("toolbar");
const mermaidPreviewEl = document.getElementById("mermaid-preview");
const openDrawioBtn  = document.getElementById("open-drawio");
const fullscreenBtn  = document.getElementById("fullscreen-btn");
const copyXmlBtn     = document.getElementById("copy-xml-btn");
var drawioEditUrl = null;
var currentXml = null;
var invalidDiagramXmlMessage = ${JSON.stringify(INVALID_DIAGRAM_XML_MESSAGE)};

// --- State ---
var graphViewer = null;
var streamingInitialized = false;

var app = new App({ name: "draw.io Diagram Viewer", version: "1.0.0" });

function showError(message, err)
{
  loadingEl.style.display = "none";
  errorEl.style.display = "block";
  errorEl.textContent = message;

  // Also surface to the iframe's devtools console with a stack trace,
  // so bugs that manifest as a red box in the viewer are diagnosable
  // without instrumenting every catch block by hand.
  if (typeof console !== 'undefined' && console.error)
  {
    var stack = (err && err.stack) ? err.stack : new Error(message).stack;
    console.error('[drawio-viewer] ' + message + '\\n' + stack);
  }
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

function convertMermaidToXml(mermaidText)
{
  // The drawio-mermaid bundle (inlined at load time) exposes
  // mxMermaidToDrawio.parseText(text, config), which runs the full
  // parse + layout pipeline synchronously and returns draw.io XML.
  // No upstream mermaid runtime, no listener plumbing, no timeout.
  if (typeof mxMermaidToDrawio === 'undefined' ||
      typeof mxMermaidToDrawio.parseText !== 'function')
  {
    return Promise.reject(new Error("drawio-mermaid bundle not loaded"));
  }

  var config = {
    theme: (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'default'
  };

  try
  {
    var xml = mxMermaidToDrawio.parseText(mermaidText, config);

    if (xml == null)
    {
      return Promise.reject(new Error("Unsupported Mermaid diagram type"));
    }

    // Stabilize cell IDs so the streaming preview and the final render
    // share identity for the same cells. parseText auto-assigns sequential
    // IDs that shift across prefix re-parses; stabilizeMermaidIds rewrites
    // them to deterministic content-addressed values.
    return Promise.resolve(stabilizeMermaidIds(xml));
  }
  catch (e)
  {
    return Promise.reject(e);
  }
}

function generateDrawioEditUrl(xml)
{
  var encoded = encodeURIComponent(xml);
  var compressed = pako.deflateRaw(encoded);
  var base64 = btoa(Array.from(compressed, function(b) { return String.fromCharCode(b); }).join(""));
  var createObj = { type: "xml", compressed: true, data: base64, effect: "pop" };

  return "https://app.diagrams.net/?pv=0&grid=0#create=" + encodeURIComponent(JSON.stringify(createObj));
}

/**
 * Intro animation for the final GraphViewer: pop-bounces all vertices
 * and wipe-fades all edges. Called once after the viewer renders.
 */
var introAnimPlayed = false;

function playViewerIntroAnimation(graph)
{
  if (graph == null || introAnimPlayed) return;
  introAnimPlayed = true;

  var model = graph.getModel();
  var vertices = [];
  var edges = [];

  // Collect all visible vertices and edges (skip root cells 0, 1)
  for (var id in model.cells)
  {
    if (id === '0' || id === '1') continue;

    var cell = model.cells[id];

    if (cell.edge) edges.push(cell);
    else if (cell.vertex) vertices.push(cell);
  }

  graph.view.validate();

  // Hide all cells initially
  var allCells = vertices.concat(edges);

  for (var i = 0; i < allCells.length; i++)
  {
    var state = graph.view.getState(allCells[i]);

    if (state != null && state.shape != null && state.shape.node != null)
    {
      state.shape.node.style.opacity = '0';
    }

    if (state != null && state.text != null && state.text.node != null)
    {
      state.text.node.style.opacity = '0';
    }
  }

  // Pop animation for vertices
  if (vertices.length > 0 && typeof graph.createPopAnimations === 'function')
  {
    var popAnims = graph.createPopAnimations(vertices, true);

    if (popAnims.length > 0)
    {
      graph.executeAnimations(popAnims, function()
      {
        // Ensure all vertices visible after pop
        for (var m = 0; m < vertices.length; m++)
        {
          var vs = graph.view.getState(vertices[m]);

          if (vs != null && vs.shape != null && vs.shape.node != null)
          {
            vs.shape.node.style.opacity = '1';
            vs.shape.node.style.visibility = 'visible';
          }

          if (vs != null && vs.text != null && vs.text.node != null)
          {
            vs.text.node.style.opacity = '1';
            vs.text.node.style.visibility = 'visible';
          }
        }

        // After vertices pop, fade in edges
        fadeInEdges(graph, edges);
      }, 20, 20);
    }
    else
    {
      // Fallback: just show everything
      showAllCells(graph, allCells);
    }
  }
  else
  {
    // Fallback: just show everything
    showAllCells(graph, allCells);
  }
}

function fadeInEdges(graph, edges)
{
  for (var n = 0; n < edges.length; n++)
  {
    var es = graph.view.getState(edges[n]);

    if (es != null && es.shape != null && es.shape.node != null)
    {
      es.shape.node.style.transition = 'opacity 0.4s ease-out';
      es.shape.node.style.opacity = '1';
      es.shape.node.style.visibility = 'visible';
    }

    if (es != null && es.text != null && es.text.node != null)
    {
      es.text.node.style.transition = 'opacity 0.4s ease-out';
      es.text.node.style.opacity = '1';
      es.text.node.style.visibility = 'visible';
    }
  }

  // Clean up transitions
  setTimeout(function()
  {
    for (var p = 0; p < edges.length; p++)
    {
      var es2 = graph.view.getState(edges[p]);

      if (es2 != null && es2.shape != null && es2.shape.node != null)
      {
        es2.shape.node.style.transition = '';
      }

      if (es2 != null && es2.text != null && es2.text.node != null)
      {
        es2.text.node.style.transition = '';
      }
    }
  }, 450);
}

function showAllCells(graph, cells)
{
  for (var i = 0; i < cells.length; i++)
  {
    var state = graph.view.getState(cells[i]);

    if (state != null && state.shape != null && state.shape.node != null)
    {
      state.shape.node.style.opacity = '1';
      state.shape.node.style.visibility = 'visible';
    }

    if (state != null && state.text != null && state.text.node != null)
    {
      state.text.node.style.opacity = '1';
      state.text.node.style.visibility = 'visible';
    }
  }
}

/**
 * Serialize the current graph model to draw.io XML. Used after a post-
 * layout pass so currentXml and drawioEditUrl reflect what the user
 * sees in the viewer — not the pre-pass XML from the server.
 */
function serializeGraphXml(graph)
{
  try
  {
    var codec = new mxCodec();
    var node = codec.encode(graph.getModel());
    return mxUtils.getXml(node);
  }
  catch (e)
  {
    return null;
  }
}

/**
 * Configure an mxElkLayout instance for the requested algorithm.
 * Returns null if the algorithm is unknown or the ELK bundle failed
 * to load. All options map to ELK's layered/mrtree/force/stress/radial
 * algorithms — direction only applies to 'layered'.
 */
function createPostLayout(graph, algorithm)
{
  if (algorithm == null || algorithm === 'none') return null;
  if (typeof mxElkLayout === 'undefined' || typeof ELK === 'undefined') return null;

  // Algorithm presets mirror drawio-dev's ElkLayout.DEFAULTS so the
  // viewer's layout output matches the editor's Arrange > Layout
  // menu (Layered / Tree / Force / Stress / Radial).
  // Ref: drawio-dev/src/main/webapp/js/diagramly/ElkLayout.js
  var options = null;

  switch (algorithm)
  {
    case 'verticalFlow':
    case 'horizontalFlow':
      options = {
        'elk.algorithm': 'layered',
        'elk.direction': algorithm === 'verticalFlow' ? 'DOWN' : 'RIGHT',
        'elk.edgeRouting': 'ORTHOGONAL',
        'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
        'elk.spacing.nodeNode': '30',
        'elk.layered.spacing.nodeNodeBetweenLayers': '30',
        // Reserve space in the layer gap for edge labels so long labels
        // don't overlap nodes on the next layer.
        'elk.edgeLabels.inline': 'true',
        'elk.spacing.edgeLabel': '5',
        // Keep within-layer Y ordering aligned with child-declaration
        // order in the model (what mermaid imports and hand-written
        // XML both rely on).
        'elk.layered.considerModelOrder.strategy': 'NODES',
        'elk.layered.crossingMinimization.forceNodeModelOrder': 'true'
      };
      break;
    case 'tree':
      options = {
        'elk.algorithm': 'mrtree',
        'elk.direction': 'DOWN',
        'elk.spacing.nodeNode': '20',
        'elk.mrtree.weighting': 'MODEL_ORDER'
      };
      break;
    case 'force':
      options = {
        'elk.algorithm': 'force',
        'elk.spacing.nodeNode': '80',
        'elk.force.iterations': '300',
        'elk.force.repulsivePower': '0'
      };
      break;
    case 'stress':
      options = {
        'elk.algorithm': 'stress',
        'elk.spacing.nodeNode': '80',
        'elk.stress.desiredEdgeLength': '100'
      };
      break;
    case 'radial':
      options = {
        'elk.algorithm': 'radial',
        'elk.spacing.nodeNode': '20'
      };
      break;
    default:
      return null;
  }

  var layout = new mxElkLayout(graph, options);
  layout.algorithm = options['elk.algorithm'];
  if (options['elk.direction'] != null) layout.direction = options['elk.direction'];
  return layout;
}

/**
 * Apply a post-render layout to the given graph and animate the
 * vertices morphing from their original positions to the new ones.
 *
 * ELK runs async. We snapshot the current model into an ELK graph
 * synchronously, then when ELK returns we wrap applyElkLayout in a
 * beginUpdate block deferred by mxMorphing — mirroring the drawio
 * EditorUi.executeLayout pattern so the view stays on pre-layout
 * positions during the morph.
 *
 * @param {Graph} graph
 * @param {string} algorithm - Enum value from the postLayout schema.
 * @param {object} [hints] - Optional layout hints.
 * @param {string[]} [hints.startNodeIds] - Cell IDs pinned to the first layer.
 * @param {string[]} [hints.endNodeIds]   - Cell IDs pinned to the last layer.
 * @param {function(boolean)} [onDone] - Called with true when the
 *   layout was applied, false when it was skipped or ELK errored.
 */
function applyPostLayout(graph, algorithm, hints, onDone)
{
  // Backwards-compatible arg shuffle: allow applyPostLayout(graph, alg, cb).
  if (typeof hints === 'function')
  {
    onDone = hints;
    hints = null;
  }

  hints = hints || {};

  var done = function(applied)
  {
    if (typeof onDone === 'function') onDone(applied);
  };

  if (graph == null) { done(false); return; }

  var layout = createPostLayout(graph, algorithm);
  if (layout == null) { done(false); return; }

  var model = graph.getModel();
  var parent = graph.getDefaultParent();

  var elkGraph;
  try
  {
    elkGraph = layout.buildElkGraph(parent);
  }
  catch (e)
  {
    done(false);
    return;
  }

  if (!elkGraph.children || elkGraph.children.length === 0)
  {
    done(false);
    return;
  }

  // For layered layouts (verticalFlow / horizontalFlow), pin Start/End
  // nodes to the first/last layer. When the LLM gave explicit ID lists
  // via startNodeIds / endNodeIds, use those verbatim — they reflect
  // intent. Otherwise fall back to topological detection (sources =
  // nodes with 0 incoming edges → FIRST, sinks = 0 outgoing → LAST),
  // which handles well-formed acyclic flows but mispicks when a
  // feedback edge (e.g. error → retry) makes a mid-graph node look
  // like a source.
  if (layout.algorithm === 'layered')
  {
    var firstIds = null;
    var lastIds = null;

    if (Array.isArray(hints.startNodeIds) && hints.startNodeIds.length > 0)
    {
      firstIds = {};
      for (var i = 0; i < hints.startNodeIds.length; i++) firstIds[hints.startNodeIds[i]] = true;
    }

    if (Array.isArray(hints.endNodeIds) && hints.endNodeIds.length > 0)
    {
      lastIds = {};
      for (var i = 0; i < hints.endNodeIds.length; i++) lastIds[hints.endNodeIds[i]] = true;
    }

    if (firstIds == null && lastIds == null)
    {
      // Fallback: topological source/sink detection.
      var incomingCount = {};
      var outgoingCount = {};

      for (var i = 0; i < elkGraph.children.length; i++)
      {
        incomingCount[elkGraph.children[i].id] = 0;
        outgoingCount[elkGraph.children[i].id] = 0;
      }

      if (elkGraph.edges != null)
      {
        for (var i = 0; i < elkGraph.edges.length; i++)
        {
          var edge = elkGraph.edges[i];

          if (edge.sources != null)
          {
            for (var s = 0; s < edge.sources.length; s++)
            {
              if (outgoingCount[edge.sources[s]] != null) outgoingCount[edge.sources[s]]++;
            }
          }

          if (edge.targets != null)
          {
            for (var t = 0; t < edge.targets.length; t++)
            {
              if (incomingCount[edge.targets[t]] != null) incomingCount[edge.targets[t]]++;
            }
          }
        }
      }

      firstIds = {};
      lastIds = {};

      for (var i = 0; i < elkGraph.children.length; i++)
      {
        var nid = elkGraph.children[i].id;
        if (incomingCount[nid] === 0 && outgoingCount[nid] > 0) firstIds[nid] = true;
        else if (outgoingCount[nid] === 0 && incomingCount[nid] > 0) lastIds[nid] = true;
      }
    }

    for (var i = 0; i < elkGraph.children.length; i++)
    {
      var node = elkGraph.children[i];

      if (firstIds != null && firstIds[node.id])
      {
        if (node.layoutOptions == null) node.layoutOptions = {};
        node.layoutOptions['elk.layered.layering.layerConstraint'] = 'FIRST';
      }
      else if (lastIds != null && lastIds[node.id])
      {
        if (node.layoutOptions == null) node.layoutOptions = {};
        node.layoutOptions['elk.layered.layering.layerConstraint'] = 'LAST';
      }
    }
  }

  new ELK().layout(elkGraph).then(function(result)
  {
    model.beginUpdate();

    var committed = false;

    try
    {
      layout.applyElkLayout(result);
      committed = true;
    }
    catch (e)
    {
      // ELK application failed; model.endUpdate() in finally will
      // unwind the partial changes cleanly.
    }
    finally
    {
      if (committed)
      {
        // Commit with morph animation — morph captures the current
        // view state (pre-ELK positions) and animates to the new
        // model state, calling endUpdate on DONE. On DONE we re-fit
        // so the viewer's scale/translate match the new bounds;
        // without this, a layered layout that grew taller than the
        // original viewport clips on the sides.
        var refit = function()
        {
          try
          {
            graph.fit(20);
            graph.sizeDidChange();
          }
          catch (_) {}
        };

        try
        {
          var morph = new mxMorphing(graph);
          morph.addListener(mxEvent.DONE, function()
          {
            model.endUpdate();
            refit();
            notifySize('postLayout');
            done(true);
          });
          morph.startAnimation();
        }
        catch (e)
        {
          model.endUpdate();
          refit();
          notifySize('postLayout');
          done(true);
        }
      }
      else
      {
        model.endUpdate();
        done(false);
      }
    }
  }).catch(function(e)
  {
    done(false);
  });
}

async function renderDiagram(xml, opts)
{
  opts = opts || {};

  try
  {
    await waitForGraphViewer();
  }
  catch(e)
  {
    showError("Failed to load the draw.io viewer. Check your network connection.");
    return;
  }

  try
  {
    containerEl.innerHTML = "";

    var config = {
      highlight: "#0000ff",
      "dark-mode": "auto",
      nav: true,
      resize: true,
      fit: true,
      "max-width": "100%",
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
      // For post-stream renders, fade the viewer in instead of popping
      // each cell (the stream already animated them).
      if (opts.fadeIn)
      {
        graphDiv2.style.opacity = '0';
      }

      GraphViewer.createViewerForElement(graphDiv2, function(viewer)
      {
        graphViewer = viewer;

        if (opts.skipIntroAnim)
        {
          // Mark intro as played so playViewerIntroAnimation is a no-op.
          introAnimPlayed = true;
        }
        else if (viewer != null && viewer.graph != null)
        {
          // Intro animation: bounce vertices, wipe edges
          playViewerIntroAnimation(viewer.graph);
        }

        if (opts.fadeIn)
        {
          // Whole-viewer fade-in to handoff cleanly from the stream.
          graphDiv2.style.transition = 'opacity 0.35s ease-out';
          requestAnimationFrame(function()
          {
            graphDiv2.style.opacity = '1';
            setTimeout(function()
            {
              graphDiv2.style.transition = '';
            }, 400);
          });
        }

        // Post-layout pass: the AI opts into a specific algorithm via
        // the postLayout tool parameter (verticalFlow, horizontalFlow,
        // tree, force, …) and we run that full re-layout. Otherwise
        // the diagram renders as-is.
        var autoAlgorithm = opts.postLayout || null;

        if (autoAlgorithm && viewer != null && viewer.graph != null)
        {
          var delay = opts.fadeIn ? 450 : 50;
          var layoutHints = { startNodeIds: opts.startNodeIds || null, endNodeIds: opts.endNodeIds || null };
          setTimeout(function()
          {
            try
            {
              applyPostLayout(viewer.graph, autoAlgorithm, layoutHints, function(applied)
              {
                try
                {
                  if (applied)
                  {
                    var newXml = serializeGraphXml(viewer.graph);

                    if (newXml != null)
                    {
                      currentXml = newXml;
                      drawioEditUrl = generateDrawioEditUrl(newXml);
                    }
                  }
                }
                catch (e)
                {
                  // Keep the original on serialization failure.
                }
              });
            }
            catch (e)
            {
              if (typeof console !== 'undefined' && console.warn)
              {
                console.warn('[post-layout] error:', e);
              }
            }
          }, delay);
        }

        notifySize('viewer-callback');
      });
    }
    else
    {
      GraphViewer.processElements();
      notifySize('processElements');
    }
  }
  catch (e)
  {
    showError("Failed to render diagram: " + e.message, e);
  }
}

function notifySize(tag)
{
  // GraphViewer renders asynchronously; nudge the SDK's ResizeObserver
  // by explicitly sending size after the SVG is in the DOM.
  requestAnimationFrame(function()
  {
    var el = document.documentElement;
    var w = Math.ceil(el.scrollWidth);
    var h = Math.ceil(el.scrollHeight);
    var containerH = containerEl.clientHeight;
    var containerStyle = containerEl.style.height;
    var containerDisplay = containerEl.style.display;
    var svgEl = containerEl.querySelector('svg');
    var svgH = svgEl ? svgEl.getBoundingClientRect().height : 0;

    if (app.sendSizeChanged)
    {
      app.sendSizeChanged({ width: w, height: h });
    }
  });
}

// --- Streaming: raw Graph + standalone merge (no GraphViewer) ---

var streamGraph = null;
var streamPendingEdges = null;
var streamFitRaf = null;
var pendingToolInputTimer = null;

/**
 * Standalone merge: inserts or updates cells from xmlNode into the graph
 * model without any GraphViewer viewport side effects. Returns updated
 * pendingEdges array. Ported from GraphViewer.prototype.mergeXmlDelta.
 */
function streamMergeXmlDelta(graph, pendingEdges, xmlNode)
{
  if (graph == null || xmlNode == null) return pendingEdges;

  var modelNode = xmlNode;

  if (modelNode.nodeName !== 'mxGraphModel') return pendingEdges;

  var model = graph.getModel();
  var codec = new mxCodec(modelNode.ownerDocument);

  codec.lookup = function(id) { return model.getCell(id); };
  codec.updateElements = function() {};

  if (pendingEdges == null) pendingEdges = [];

  var rootNode = modelNode.getElementsByTagName('root')[0];

  if (rootNode == null) return pendingEdges;

  var cellNodes = rootNode.childNodes;

  model.beginUpdate();
  try
  {
    for (var i = 0; i < cellNodes.length; i++)
    {
      var cellNode = cellNodes[i];

      if (cellNode.nodeType !== 1) continue;

      var actualCellNode = cellNode;

      if (cellNode.nodeName === 'UserObject' || cellNode.nodeName === 'object')
      {
        var inner = cellNode.getElementsByTagName('mxCell');

        if (inner.length > 0)
        {
          actualCellNode = inner[0];

          if (actualCellNode.getAttribute('id') == null &&
            cellNode.getAttribute('id') != null)
          {
            actualCellNode.setAttribute('id', cellNode.getAttribute('id'));
          }
        }
      }

      var id = actualCellNode.getAttribute('id');

      if (id == null) continue;

      var existing = model.getCell(id);

      if (existing != null)
      {
        // Update existing cell
        var style = actualCellNode.getAttribute('style');
        if (style != null && style !== existing.style) model.setStyle(existing, style);

        var value = actualCellNode.getAttribute('value');
        if (value != null && value !== existing.value) model.setValue(existing, value);

        var geoNodes = actualCellNode.getElementsByTagName('mxGeometry');
        if (geoNodes.length > 0)
        {
          var geo = codec.decode(geoNodes[0]);

          if (geo != null)
          {
            var hadZeroBounds = existing.geometry == null ||
              (existing.geometry.width === 0 && existing.geometry.height === 0);
            var hasNonZeroBounds = (geo.width > 0 || geo.height > 0);

            model.setGeometry(existing, geo);

            // If geometry went from 0x0 to non-zero and cell hasn't been
            // animated yet, queue it for deferred pop animation
            if (hadZeroBounds && hasNonZeroBounds && !animatedCellIds[id])
            {
              // Make cell visible in model (was hidden in streamInsertCell)
              if (!existing.visible)
              {
                model.setVisible(existing, true);
              }

              var dIdx = deferredAnimCellIds.indexOf(id);

              if (dIdx >= 0)
              {
                deferredAnimCellIds.splice(dIdx, 1);
              }

              // Avoid duplicate: only queue if not already pending
              if (pendingAnimCellIds.indexOf(id) === -1)
              {
                pendingAnimCellIds.push(id);
              }
            }
          }
        }
      }
      else
      {
        // Insert new cell
        streamInsertCell(model, codec, actualCellNode, pendingEdges);
      }
    }

    // Resolve pending edges
    var stillPending = [];
    for (var j = 0; j < pendingEdges.length; j++)
    {
      var entry = pendingEdges[j];

      if (!model.contains(entry.cell)) continue;

      var resolved = true;

      if (entry.sourceId != null && entry.cell.source == null)
      {
        var src = model.getCell(entry.sourceId);
        if (src != null) model.setTerminal(entry.cell, src, true);
        else resolved = false;
      }

      if (entry.targetId != null && entry.cell.target == null)
      {
        var tgt = model.getCell(entry.targetId);
        if (tgt != null) model.setTerminal(entry.cell, tgt, false);
        else resolved = false;
      }

      if (resolved) model.setVisible(entry.cell, true);
      else stillPending.push(entry);
    }

    pendingEdges = stillPending;
  }
  finally
  {
    model.endUpdate();
  }

  // Pre-hide cells that just got geometry to prevent flash before pop animation.
  // endUpdate() triggers view revalidation which renders them visible — we must
  // hide synchronously before the browser paints.
  if (pendingAnimCellIds.length > 0)
  {
    graph.view.validate();

    for (var ph = 0; ph < pendingAnimCellIds.length; ph++)
    {
      var phCell = model.getCell(pendingAnimCellIds[ph]);

      if (phCell != null)
      {
        var phState = graph.view.getState(phCell);

        if (phState != null && phState.shape != null && phState.shape.node != null)
        {
          phState.shape.node.style.opacity = '0';
        }

        if (phState != null && phState.text != null && phState.text.node != null)
        {
          phState.text.node.style.opacity = '0';
        }
      }
    }
  }

  // No positionGraph()/sizeDidChange() — we control the viewport ourselves.
  return pendingEdges;
}

function streamInsertCell(model, codec, cellNode, pendingEdges)
{
  var id = cellNode.getAttribute('id');
  var parentId = cellNode.getAttribute('parent');
  var sourceId = cellNode.getAttribute('source');
  var targetId = cellNode.getAttribute('target');
  var value = cellNode.getAttribute('value');
  var style = cellNode.getAttribute('style');
  var isVertex = cellNode.getAttribute('vertex') === '1';
  var isEdge = cellNode.getAttribute('edge') === '1';
  var isConnectable = cellNode.getAttribute('connectable');
  var isVisible = cellNode.getAttribute('visible');

  var cell = new mxCell(value, null, style);
  cell.id = id;
  cell.vertex = isVertex;
  cell.edge = isEdge;

  if (isConnectable === '0') cell.connectable = false;
  if (isVisible === '0') cell.visible = false;

  var geoNodes = cellNode.getElementsByTagName('mxGeometry');
  var hasGeo = false;

  if (geoNodes.length > 0)
  {
    var geo = codec.decode(geoNodes[0]);

    if (geo != null)
    {
      cell.geometry = geo;
      hasGeo = (geo.width > 0 || geo.height > 0) || geo.relative;
    }
  }

  // Hide vertices without geometry to prevent label flash at (0,0).
  // They become visible when geometry arrives via the update path.
  if (isVertex && !hasGeo)
  {
    cell.visible = false;
  }

  var parent = (parentId != null) ? model.getCell(parentId) : null;
  if (parent == null && model.root != null)
  {
    if (id === '0') return;
    else if (id === '1')
    {
      if (model.getCell('1') != null) return;
      parent = model.root;
    }
    else
    {
      parent = model.getCell('1') || model.root;
    }
  }

  if (parent == null) return;

  model.add(parent, cell);

  if (isEdge)
  {
    var source = (sourceId != null) ? model.getCell(sourceId) : null;
    var target = (targetId != null) ? model.getCell(targetId) : null;
    var hasMissing = false;

    if (source != null) model.setTerminal(cell, source, true);
    else if (sourceId != null) hasMissing = true;

    if (target != null) model.setTerminal(cell, target, false);
    else if (targetId != null) hasMissing = true;

    if (hasMissing)
    {
      model.setVisible(cell, false);
      pendingEdges.push({ cell: cell, sourceId: sourceId, targetId: targetId });
    }
  }
}

/**
 * Returns set of cell IDs in the model (excluding root cells 0 and 1).
 */
function getModelCellIds(model)
{
  var ids = {};

  if (model.cells != null)
  {
    for (var id in model.cells)
    {
      if (id !== '0' && id !== '1') ids[id] = true;
    }
  }

  return ids;
}

/**
 * Returns array of cell IDs that are in the model but not in prevIds.
 */
function findNewCellIds(model, prevIds)
{
  var result = [];

  if (model.cells != null)
  {
    for (var id in model.cells)
    {
      if (id !== '0' && id !== '1' && !prevIds[id]) result.push(id);
    }
  }

  return result;
}

/**
 * Animate newly added cells with wipe-in/pop-in animation.
 * Uses Graph's createPopAnimations and executeAnimations.
 */
var pendingAnimCellIds = [];
var animDebounceTimer = null;
var deferredAnimCellIds = [];
var deferredAnimTimer = null;
var animatedCellIds = {};

/**
 * Queue cell IDs for animation. Actual animation fires after a
 * 200ms pause in merging, so rapid consecutive merges get batched.
 */
function queueCellAnimation(graph, cellIds)
{
  for (var i = 0; i < cellIds.length; i++)
  {
    pendingAnimCellIds.push(cellIds[i]);
  }

  if (animDebounceTimer != null)
  {
    clearTimeout(animDebounceTimer);
  }

  animDebounceTimer = setTimeout(function()
  {
    animDebounceTimer = null;
    flushCellAnimations(graph);
  }, 200);
}

/**
 * Run pop/fade animations on all batched cells.
 */
function flushCellAnimations(graph)
{
  if (graph == null || pendingAnimCellIds.length === 0) return;

  var ids = pendingAnimCellIds;
  pendingAnimCellIds = [];

  // Validate view to ensure all cell states have proper bounds
  graph.view.validate();

  var readyCells = [];
  var readyVertices = [];
  var readyEdges = [];
  var deferred = [];

  for (var i = 0; i < ids.length; i++)
  {
    var cell = graph.model.getCell(ids[i]);

    if (cell == null) continue;

    var state = graph.view.getState(cell);
    var hasBounds = state != null && (state.width > 1 || state.height > 1);

    if (!cell.edge && !hasBounds)
    {
      // Vertex without proper bounds — geometry not yet streamed
      deferred.push(ids[i]);
      continue;
    }

    readyCells.push(cell);

    if (cell.edge) readyEdges.push(cell);
    else readyVertices.push(cell);
  }

  // Re-queue deferred cells — they'll get animated once geometry arrives
  if (deferred.length > 0)
  {
    for (var d = 0; d < deferred.length; d++)
    {
      deferredAnimCellIds.push(deferred[d]);
    }
  }

  if (readyCells.length === 0) return;

  // Mark as animated
  for (var a = 0; a < readyCells.length; a++)
  {
    animatedCellIds[readyCells[a].id] = true;
  }

  // Collect all shape+text nodes for hiding
  var allNodes = [];

  for (var j = 0; j < readyCells.length; j++)
  {
    var state = graph.view.getState(readyCells[j]);

    if (state != null && state.shape != null && state.shape.node != null)
    {
      allNodes.push(state.shape.node);
    }

    if (state != null && state.text != null && state.text.node != null)
    {
      allNodes.push(state.text.node);
    }
  }

  if (allNodes.length === 0) return;

  // Fade in all new cells via CSS transition
  for (var k = 0; k < allNodes.length; k++)
  {
    allNodes[k].style.opacity = '0';
    allNodes[k].style.visibility = 'visible';
    allNodes[k].style.transition = 'opacity 0.4s ease-out';
  }

  // Trigger fade-in on next frame so the opacity:0 is painted first
  requestAnimationFrame(function()
  {
    for (var m = 0; m < allNodes.length; m++)
    {
      allNodes[m].style.opacity = '1';
    }

    // Clean up transitions after fade completes
    setTimeout(function()
    {
      for (var p = 0; p < allNodes.length; p++)
      {
        allNodes[p].style.transition = '';
      }
    }, 450);
  });
}

// --- Smart streaming camera ---
//
// Goal: keep the streaming preview inside a fixed visible viewport while
// new cells stream in. The camera target is recomputed on each partial
// (smart focus toward recently-added cells when they're a small subset)
// and a critically-damped spring animates toward it on every rAF tick,
// so the motion ease-outs naturally even between partials.

// Maximum height for the streaming container. Caps growth so the iframe
// stays in the user's chat viewport while the diagram fills in. Final
// GraphViewer (post-stream) renders at natural size — see endStreaming.
var STREAM_VIEWPORT_HEIGHT = 650;
// Minimum height — avoids a tiny initial frame for trivial diagrams.
var STREAM_VIEWPORT_MIN_HEIGHT = 320;
// Padding around the focus rect, in container pixels.
var STREAM_VIEWPORT_PADDING = 24;
// How long a cell counts as "recently added" for focus weighting.
// Long enough to keep the centroid stable when a single new arrival
// would otherwise shift it dramatically — averaging across more
// vertices smooths the panning.
var STREAM_RECENT_CELL_TTL_MS = 1200;
// Cap on the number of vertices considered "recent". Bigger set =
// smoother centroid (less jitter when a vertex is added or expires)
// but slightly wider focus rect.
var STREAM_RECENT_VERTEX_LIMIT = 6;
// How much extra zoom-in we'll allow when focusing on a small recent set,
// expressed as a multiplier on the fit-whole scale. 1.0 = no extra zoom.
var STREAM_RECENT_ZOOM_BOOST = 1.8;

// Insertion-order queue of recent vertex additions: [{id, t}, ...].
// We trim by both TTL and length cap so the camera only ever focuses on
// the actual leading edge of new content. Cleared on endStreaming.
var recentVertexQueue = [];

function trackRecentCells(ids)
{
  if (ids == null || ids.length === 0) return;
  var now = (typeof performance !== 'undefined' && performance.now)
    ? performance.now() : Date.now();

  for (var i = 0; i < ids.length; i++)
  {
    recentVertexQueue.push({ id: ids[i], t: now });
  }

  // Cap length: keep only the last N additions.
  if (recentVertexQueue.length > STREAM_RECENT_VERTEX_LIMIT)
  {
    recentVertexQueue = recentVertexQueue.slice(-STREAM_RECENT_VERTEX_LIMIT);
  }
}

// Camera animator state. The spring runs in log-space for scale (so
// 0.5→1.0 feels like 1.0→2.0) and linear for tx/ty.
var cameraTarget = null;     // { scale, tx, ty }
var cameraVelocity = { logScale: 0, tx: 0, ty: 0 };
var cameraAnimRaf = null;
var cameraAnimLastT = 0;
var cameraAnimGraph = null;
// Slightly overdamped spring: zeta > 1 guarantees no overshoot, even
// when the target keeps shrinking during streaming and the spring has
// accumulated zoom-out velocity (which would otherwise carry it past
// the final scale before settling back). Omega bumped a touch to keep
// the response feeling snappy despite the extra damping.
var CAMERA_SPRING_OMEGA = 10.0;
var CAMERA_SPRING_ZETA = 1.25;

/**
 * Compute the bbox of cells (in model-space, with parent offsets) from
 * an array of cell IDs. Returns null when no usable geometry was found.
 */
function computeCellsBBox(model, ids)
{
  var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  var any = false;

  for (var i = 0; i < ids.length; i++)
  {
    var cell = model.getCell(ids[i]);
    if (cell == null || !cell.visible) continue;
    var geo = cell.geometry;
    if (geo == null || geo.relative) continue;

    var ox = 0, oy = 0;
    var p = model.getParent(cell);

    while (p != null && p.id !== '0' && p.id !== '1')
    {
      if (p.geometry != null && !p.geometry.relative)
      {
        ox += p.geometry.x;
        oy += p.geometry.y;
      }

      p = model.getParent(p);
    }

    var x1 = geo.x + ox;
    var y1 = geo.y + oy;
    var x2 = x1 + (geo.width || 0);
    var y2 = y1 + (geo.height || 0);

    if (x1 < minX) minX = x1;
    if (y1 < minY) minY = y1;
    if (x2 > maxX) maxX = x2;
    if (y2 > maxY) maxY = y2;
    any = true;
  }

  if (!any) return null;
  return { minX: minX, minY: minY, maxX: maxX, maxY: maxY };
}

/**
 * Compute the bbox of all visible cells in the graph model.
 */
function computeWholeBBox(model)
{
  var ids = [];
  for (var id in model.cells)
  {
    if (id === '0' || id === '1') continue;
    ids.push(id);
  }
  return computeCellsBBox(model, ids);
}

/**
 * Given a target rect in model space (inflated with padding) and the
 * container size in pixels, return { scale, tx, ty } that fits it
 * centered, with scale clamped to [0.1, 1.0].
 */
function fitRectToContainer(rect, cw, ch)
{
  var rw = Math.max(rect.maxX - rect.minX, 1);
  var rh = Math.max(rect.maxY - rect.minY, 1);
  var availW = Math.max(cw - STREAM_VIEWPORT_PADDING * 2, 1);
  var availH = Math.max(ch - STREAM_VIEWPORT_PADDING * 2, 1);

  var scale = Math.min(availW / rw, availH / rh, 1);
  scale = Math.max(scale, 0.1);

  var cx = (rect.minX + rect.maxX) / 2;
  var cy = (rect.minY + rect.maxY) / 2;
  var tx = (cw / scale) / 2 - cx;
  var ty = (ch / scale) / 2 - cy;

  return { scale: scale, tx: tx, ty: ty };
}

/**
 * Decide where the camera should be aiming right now. Strategy:
 *
 *  - Always size the streaming container at STREAM_VIEWPORT_HEIGHT (or
 *    less when the diagram naturally fits smaller). Width is fixed by
 *    layout.
 *  - "Whole" target = fit-bbox of all cells, padded.
 *  - "Hot" target = fit-bbox of cells added in the last
 *    STREAM_RECENT_CELL_TTL_MS, expanded slightly so we keep some
 *    spatial context around them.
 *  - When recent cells span most of the diagram (recent_area / whole_area
 *    > 0.6), the hot view collapses into the whole view; the bias has no
 *    effect.
 *  - Otherwise blend toward the hot view: lerp center and (clamped)
 *    scale. The blend factor decays with the recent/whole area ratio so
 *    a single new node gets full focus and a flurry of new nodes barely
 *    nudges the camera.
 */
function computeStreamCameraTarget(graph)
{
  var model = graph.getModel();
  var wholeBox = computeWholeBBox(model);

  if (wholeBox == null) return null;

  // Choose container height: cap at STREAM_VIEWPORT_HEIGHT, but shrink
  // for tiny diagrams that fit smaller without zooming below 100%.
  var cw = containerEl.clientWidth;
  if (cw <= 0) return null;

  var wholeW = Math.max(wholeBox.maxX - wholeBox.minX, 1);
  var wholeH = Math.max(wholeBox.maxY - wholeBox.minY, 1);

  // Height that would let the whole diagram fit at its width-fit scale,
  // capped at STREAM_VIEWPORT_HEIGHT and floored at the minimum.
  var widthFitScale = Math.min((cw - STREAM_VIEWPORT_PADDING * 2) / wholeW, 1);
  var naturalH = Math.ceil(wholeH * widthFitScale + STREAM_VIEWPORT_PADDING * 2);
  var desiredH = Math.max(STREAM_VIEWPORT_MIN_HEIGHT,
                          Math.min(naturalH, STREAM_VIEWPORT_HEIGHT));

  if (Math.abs(containerEl.clientHeight - desiredH) > 1)
  {
    containerEl.style.height = desiredH + 'px';

    if (app.sendSizeChanged)
    {
      app.sendSizeChanged({ width: cw, height: desiredH });
    }
  }

  var ch = desiredH;

  // Whole-fit camera target.
  var paddedWhole = {
    minX: wholeBox.minX, minY: wholeBox.minY,
    maxX: wholeBox.maxX, maxY: wholeBox.maxY
  };
  var wholeView = fitRectToContainer(paddedWhole, cw, ch);

  // Collect recent vertex IDs (within TTL). Iterate the queue in
  // insertion order; expire stale entries by trimming from the front.
  var now = (typeof performance !== 'undefined' && performance.now)
    ? performance.now() : Date.now();
  var firstAlive = 0;

  while (firstAlive < recentVertexQueue.length &&
         now - recentVertexQueue[firstAlive].t > STREAM_RECENT_CELL_TTL_MS)
  {
    firstAlive++;
  }

  if (firstAlive > 0) recentVertexQueue = recentVertexQueue.slice(firstAlive);

  var recentIds = [];
  for (var rq = 0; rq < recentVertexQueue.length; rq++)
  {
    recentIds.push(recentVertexQueue[rq].id);
  }

  if (recentIds.length === 0) return wholeView;

  var recentBox = computeCellsBBox(model, recentIds);
  if (recentBox == null) return wholeView;

  // Inflate the recent bbox to keep some spatial context visible.
  var inflate = Math.max(wholeW, wholeH) * 0.15;
  var paddedRecent = {
    minX: recentBox.minX - inflate, minY: recentBox.minY - inflate,
    maxX: recentBox.maxX + inflate, maxY: recentBox.maxY + inflate
  };

  // Don't focus tighter than the whole bbox itself — clip to it so we
  // never pan outside the diagram.
  paddedRecent.minX = Math.max(paddedRecent.minX, wholeBox.minX);
  paddedRecent.minY = Math.max(paddedRecent.minY, wholeBox.minY);
  paddedRecent.maxX = Math.min(paddedRecent.maxX, wholeBox.maxX);
  paddedRecent.maxY = Math.min(paddedRecent.maxY, wholeBox.maxY);

  var recentView = fitRectToContainer(paddedRecent, cw, ch);

  // Blend factor: focus on recent when it's a small portion of the
  // diagram, fade to whole-fit as it grows. Capped at 0.75 so the
  // camera always keeps a fair amount of context visible (less twitchy
  // than a full 0.9 lock onto the hot region).
  var wholeArea = wholeW * wholeH;
  var recentArea = Math.max(recentBox.maxX - recentBox.minX, 1) *
                   Math.max(recentBox.maxY - recentBox.minY, 1);
  var ratio = Math.min(recentArea / Math.max(wholeArea, 1), 1);
  var blend = Math.max(0, 0.75 * (1 - ratio / 0.75));   // 0..0.75

  // Cap the focus zoom so we don't lose context — never more than
  // STREAM_RECENT_ZOOM_BOOST × the whole-fit scale.
  var maxScale = Math.min(wholeView.scale * STREAM_RECENT_ZOOM_BOOST, 1);
  var blendedScale = wholeView.scale +
                     (Math.min(recentView.scale, maxScale) - wholeView.scale) * blend;

  // Lerp center; convert (tx, ty) back from blended scale.
  var wholeCx = (wholeBox.minX + wholeBox.maxX) / 2;
  var wholeCy = (wholeBox.minY + wholeBox.maxY) / 2;
  var recentCx = (recentBox.minX + recentBox.maxX) / 2;
  var recentCy = (recentBox.minY + recentBox.maxY) / 2;
  var cx = wholeCx + (recentCx - wholeCx) * blend;
  var cy = wholeCy + (recentCy - wholeCy) * blend;

  return {
    scale: blendedScale,
    tx: (cw / blendedScale) / 2 - cx,
    ty: (ch / blendedScale) / 2 - cy
  };
}

/**
 * rAF tick: advance critically-damped spring on (logScale, tx, ty)
 * toward cameraTarget and apply to the graph view. Reschedules itself
 * until the camera is at rest (within thresholds).
 */
function cameraAnimTick(now)
{
  cameraAnimRaf = null;

  if (cameraAnimGraph == null || cameraTarget == null) return;

  var dt = (cameraAnimLastT > 0) ? Math.min((now - cameraAnimLastT) / 1000, 0.05) : 0.016;
  cameraAnimLastT = now;

  var view = cameraAnimGraph.view;
  var curScale = view.scale;
  var curTx = view.translate.x;
  var curTy = view.translate.y;

  var curLog = Math.log(Math.max(curScale, 0.0001));
  var tgtLog = Math.log(Math.max(cameraTarget.scale, 0.0001));

  // Damped spring: a = omega^2 * (target-pos) - 2*zeta*omega*vel
  // Slightly overdamped (zeta > 1) so a chasing target with built-up
  // velocity can never overshoot when the target finally settles.
  var omega = CAMERA_SPRING_OMEGA;
  var omega2 = omega * omega;
  var damp = 2 * CAMERA_SPRING_ZETA * omega;

  cameraVelocity.logScale += (omega2 * (tgtLog - curLog) - damp * cameraVelocity.logScale) * dt;
  cameraVelocity.tx       += (omega2 * (cameraTarget.tx - curTx) - damp * cameraVelocity.tx) * dt;
  cameraVelocity.ty       += (omega2 * (cameraTarget.ty - curTy) - damp * cameraVelocity.ty) * dt;

  var newLog = curLog + cameraVelocity.logScale * dt;
  var newScale = Math.exp(newLog);
  var newTx = curTx + cameraVelocity.tx * dt;
  var newTy = curTy + cameraVelocity.ty * dt;

  // Snap when within thresholds AND velocity is small.
  var atScale = Math.abs(newScale - cameraTarget.scale) < 0.003 &&
                Math.abs(cameraVelocity.logScale) < 0.05;
  var atTx = Math.abs(newTx - cameraTarget.tx) < 0.5 &&
             Math.abs(cameraVelocity.tx) < 1;
  var atTy = Math.abs(newTy - cameraTarget.ty) < 0.5 &&
             Math.abs(cameraVelocity.ty) < 1;

  if (atScale) { newScale = cameraTarget.scale; cameraVelocity.logScale = 0; }
  if (atTx)    { newTx = cameraTarget.tx;       cameraVelocity.tx = 0; }
  if (atTy)    { newTy = cameraTarget.ty;       cameraVelocity.ty = 0; }

  // Skip the apply if nothing visibly changed (avoids redundant SVG
  // matrix updates).
  if (newScale !== curScale || newTx !== curTx || newTy !== curTy)
  {
    view.scaleAndTranslate(newScale, newTx, newTy);
  }

  // Keep ticking until at rest.
  if (!(atScale && atTx && atTy))
  {
    cameraAnimRaf = requestAnimationFrame(cameraAnimTick);
  }
  else
  {
    cameraAnimLastT = 0;
  }
}

function ensureCameraAnimRunning(graph)
{
  cameraAnimGraph = graph;

  if (cameraAnimRaf == null)
  {
    cameraAnimLastT = 0;
    cameraAnimRaf = requestAnimationFrame(cameraAnimTick);
  }
}

function stopCameraAnim()
{
  if (cameraAnimRaf != null)
  {
    cancelAnimationFrame(cameraAnimRaf);
    cameraAnimRaf = null;
  }

  cameraAnimGraph = null;
  cameraTarget = null;
  cameraVelocity.logScale = 0;
  cameraVelocity.tx = 0;
  cameraVelocity.ty = 0;
  cameraAnimLastT = 0;
}

/**
 * Public entry point called after each merge. Recomputes the camera
 * target (smart focus toward recently-added cells) and ensures the
 * spring animator is running. The animator keeps ticking between
 * partials, so motion eases out smoothly even when the LLM pauses.
 */
function streamFollowNewCells(graph)
{
  var target = computeStreamCameraTarget(graph);
  if (target == null) return;

  cameraTarget = target;

  // First time: snap scale into a reasonable range so we don't start
  // from the default scale=1, translate=0,0 and zip across the screen.
  if (graph.view.scale === 1 && graph.view.translate.x === 0 &&
      graph.view.translate.y === 0)
  {
    // Start at a slightly lower scale than the target for a subtle
    // "zoom-in-as-it-renders" feel, capped at the target so we don't
    // start zoomed in.
    var startScale = Math.max(target.scale * 0.85, 0.1);
    graph.view.scaleAndTranslate(startScale, target.tx, target.ty);
  }

  ensureCameraAnimRunning(graph);
}

/**
 * Smooth handoff from the streaming Graph to the final GraphViewer.
 *
 * - Clears the recent-vertex queue so the camera target snaps back to
 *   fit-whole — the spring then animates the streamGraph from "zoomed
 *   in on the leading edge" out to the full diagram in parallel with
 *   the fade-out, so the user sees the camera pull back as the stream
 *   dissolves into the viewer.
 * - Fades out the streamGraph (350 ms) while the GraphViewer renders
 *   underneath at fit-whole (matching scale, no jump on swap).
 * - Skips the viewer's intro pop animation since the stream already
 *   showed every cell appearing.
 *
 * renderFn is called after the fade completes; it must call
 * renderDiagram(xml, { skipIntroAnim: true, fadeIn: true }).
 */
function transitionToFinalView(renderFn)
{
  if (streamGraph == null)
  {
    renderFn();
    return;
  }

  // Pull camera back to fit-whole during the fade. The smart-camera
  // target recomputes on each rAF tick of the spring, so emptying the
  // recent queue immediately retargets to the whole diagram.
  recentVertexQueue = [];

  var streamDiv = containerEl.firstElementChild;

  if (streamDiv != null)
  {
    streamDiv.style.transition = 'opacity 0.35s ease-out';
    streamDiv.style.opacity = '0';
  }

  pendingToolInputTimer = setTimeout(function()
  {
    pendingToolInputTimer = null;
    endStreaming();
    renderFn();
  }, 350);
}

/**
 * End streaming mode: destroy raw graph, remove fixed container,
 * reset state.
 */
function endStreaming()
{
  if (animDebounceTimer != null)
  {
    clearTimeout(animDebounceTimer);
    animDebounceTimer = null;
  }

  pendingAnimCellIds = [];
  deferredAnimCellIds = [];
  animatedCellIds = {};

  if (deferredAnimTimer != null)
  {
    clearTimeout(deferredAnimTimer);
    deferredAnimTimer = null;
  }

  stopCameraAnim();
  recentVertexQueue = [];

  if (streamGraph != null)
  {
    streamGraph.destroy();
    streamGraph = null;
  }

  streamPendingEdges = null;
  var prevH = containerEl.clientHeight;
  containerEl.classList.remove("streaming");
  containerEl.style.height = '';
  streamingInitialized = false;
  lastMergedMermaidText = null;
}

// --- Streaming: incremental rendering as the LLM generates XML ---

/**
 * Show the raw mermaid text in the <pre> preview element. Used as the
 * fallback when the parser can't yet make sense of the partial input.
 */
function showMermaidTextPreview(partialMermaid)
{
  loadingEl.style.display = 'none';
  mermaidPreviewEl.style.display = 'block';
  mermaidPreviewEl.textContent = partialMermaid;
  containerEl.style.display = 'none';
  toolbarEl.style.display = 'none';
  mermaidPreviewEl.scrollTop = mermaidPreviewEl.scrollHeight;

  if (app.sendSizeChanged)
  {
    var el = document.documentElement;
    app.sendSizeChanged({ width: Math.ceil(el.scrollWidth), height: Math.ceil(el.scrollHeight) });
  }
}

/**
 * Handle a mermaid partial: heal the text to a parseable prefix, run
 * parseText, stabilize IDs, and merge into the streaming Graph. On
 * any failure (viewer not loaded, parse error, unsupported type), fall
 * back to the raw-text preview as long as we haven't already started
 * rendering a graph for this stream.
 */
function handleMermaidPartial(partialMermaid)
{
  // Need the viewer + parser before we can render anything
  if (typeof Graph === 'undefined' || typeof mxUtils === 'undefined' ||
      typeof mxMermaidToDrawio === 'undefined' ||
      typeof mxMermaidToDrawio.parseText !== 'function')
  {
    if (!streamingInitialized) showMermaidTextPreview(partialMermaid);
    return;
  }

  var healed = healMermaidText(partialMermaid);

  if (healed == null)
  {
    if (!streamingInitialized) showMermaidTextPreview(partialMermaid);
    return;
  }

  // De-dupe: if this healed text is byte-identical to what we last merged,
  // parseText would produce the same XML and the merge would be a no-op.
  if (healed === lastMergedMermaidText) return;

  var xml;
  try
  {
    xml = mxMermaidToDrawio.parseText(healed, {
      theme: (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'default'
    });
  }
  catch (e)
  {
    if (!streamingInitialized) showMermaidTextPreview(partialMermaid);
    return;
  }

  if (xml == null)
  {
    if (!streamingInitialized) showMermaidTextPreview(partialMermaid);
    return;
  }

  xml = stabilizeMermaidIds(xml);

  // Hand off to the same merge pipeline used by XML streaming.
  try
  {
    var xmlDoc = mxUtils.parseXml(xml);
    var xmlNode = xmlDoc.documentElement;

    if (!streamingInitialized)
    {
      // First parseable chunk — switch from text preview to live graph
      streamingInitialized = true;
      introAnimPlayed = false;
      mermaidPreviewEl.style.display = 'none';
      containerEl.innerHTML = "";
      containerEl.classList.add("streaming");

      var graphDiv = document.createElement("div");
      graphDiv.style.width = "100%";
      graphDiv.style.height = "100%";
      graphDiv.style.overflow = "hidden";
      containerEl.appendChild(graphDiv);

      loadingEl.style.display = "none";
      containerEl.style.display = "block";

      streamGraph = new Graph(graphDiv);
      streamGraph.setEnabled(false);
      streamPendingEdges = [];

      var prevIds = getModelCellIds(streamGraph.getModel());
      streamPendingEdges = streamMergeXmlDelta(streamGraph, streamPendingEdges, xmlNode);
      var newIds = findNewCellIds(streamGraph.getModel(), prevIds);

      // Track recent VERTEX additions for the smart camera. Edges can
      // span the full diagram and would bloat the focus bbox, defeating
      // the close-up. Pop animation still uses all top-level cells.
      var topNewIds = filterTopLevelCellIds(streamGraph, newIds);
      trackRecentCells(filterVertexCellIds(streamGraph, topNewIds));

      // Only pop-animate top-level cells (parent === '1'). Nested cells
      // (row containers, column cells) appear with their parent so the
      // pop is one unified motion instead of many overlapping scale-ups.
      if (topNewIds.length > 0) queueCellAnimation(streamGraph, topNewIds);

      // streamFollowNewCells sets the container height + sends the
      // size update based on the smart-camera target — no manual call.
      streamFollowNewCells(streamGraph);
    }
    else if (streamGraph != null)
    {
      var prevIds2 = getModelCellIds(streamGraph.getModel());
      streamPendingEdges = streamMergeXmlDelta(streamGraph, streamPendingEdges, xmlNode);
      var newIds2 = findNewCellIds(streamGraph.getModel(), prevIds2);

      var topNewIds2 = filterTopLevelCellIds(streamGraph, newIds2);
      trackRecentCells(filterVertexCellIds(streamGraph, topNewIds2));
      if (topNewIds2.length > 0) queueCellAnimation(streamGraph, topNewIds2);

      if (pendingAnimCellIds.length > 0 && animDebounceTimer == null)
      {
        queueCellAnimation(streamGraph, []);
      }

      streamFollowNewCells(streamGraph);
    }

    lastMergedMermaidText = healed;
  }
  catch (e)
  {
    // Keep the last good graph on screen; next tick may succeed.
  }
}

app.ontoolinputpartial = function(params)
{
  // Mermaid streaming
  var partialMermaid = params.arguments && params.arguments.mermaid;

  if (partialMermaid != null && typeof partialMermaid === 'string')
  {
    handleMermaidPartial(partialMermaid);
    return;
  }

  // XML streaming path
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

  if (typeof Graph === 'undefined' || typeof mxUtils === 'undefined')
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
      // First usable partial: create raw Graph in fixed-size container
      streamingInitialized = true;
      introAnimPlayed = false;
      containerEl.innerHTML = "";
      containerEl.classList.add("streaming");

      var graphDiv = document.createElement("div");
      graphDiv.style.width = "100%";
      graphDiv.style.height = "100%";
      graphDiv.style.overflow = "hidden";
      containerEl.appendChild(graphDiv);

      loadingEl.style.display = "none";
      containerEl.style.display = "block";

      // Create raw Graph instance (not GraphViewer)
      streamGraph = new Graph(graphDiv);
      streamGraph.setEnabled(false);
      streamPendingEdges = [];

      // Initial merge
      var prevIds = getModelCellIds(streamGraph.getModel());
      streamPendingEdges = streamMergeXmlDelta(streamGraph, streamPendingEdges, xmlNode);
      var newIds = findNewCellIds(streamGraph.getModel(), prevIds);

      var topNew = filterTopLevelCellIds(streamGraph, newIds);
      trackRecentCells(filterVertexCellIds(streamGraph, topNew));

      if (newIds.length > 0)
      {
        queueCellAnimation(streamGraph, newIds);
      }

      // streamFollowNewCells sets the container height + sends the
      // size update based on the smart-camera target — no manual call.
      streamFollowNewCells(streamGraph);
    }
    else if (streamGraph != null)
    {
      // Subsequent partials: merge delta, animate new cells, fit
      var prevIds = getModelCellIds(streamGraph.getModel());
      streamPendingEdges = streamMergeXmlDelta(streamGraph, streamPendingEdges, xmlNode);
      var newIds = findNewCellIds(streamGraph.getModel(), prevIds);

      var topNew2 = filterTopLevelCellIds(streamGraph, newIds);
      trackRecentCells(filterVertexCellIds(streamGraph, topNew2));

      if (newIds.length > 0)
      {
        queueCellAnimation(streamGraph, newIds);
      }

      // Also flush any deferred cells whose geometry arrived during merge
      if (pendingAnimCellIds.length > 0 && animDebounceTimer == null)
      {
        queueCellAnimation(streamGraph, []);
      }

      // Smart camera: focus on recent cells, fit-to-viewport, smooth spring
      streamFollowNewCells(streamGraph);
    }
  }
  catch (e)
  {
    // Ignore parse errors from partial XML — next partial may fix it.
  }
};

app.ontoolinput = function(params)
{
  var args = (params && params.arguments) || {};
  var postLayout = args.postLayout || null;
  var startNodeIds = args.startNodeIds || null;
  var endNodeIds = args.endNodeIds || null;
  var layoutOpts = { skipIntroAnim: true, fadeIn: true, postLayout: postLayout, startNodeIds: startNodeIds, endNodeIds: endNodeIds };

  var mermaidText = args.mermaid;

  if (mermaidText != null && typeof mermaidText === 'string')
  {
    transitionToFinalView(function()
    {
      mermaidPreviewEl.style.display = 'none';
      loadingEl.style.display = 'flex';
      loadingEl.innerHTML = '<div class="spinner"></div>Converting Mermaid diagram...';

      waitForGraphViewer()
        .then(function()
        {
          return convertMermaidToXml(mermaidText);
        })
        .then(function(xml)
        {
          return renderDiagram(xml, layoutOpts);
        })
        .catch(function(e)
        {
          showError("Failed to convert Mermaid diagram: " + e.message);
        });
    });

    return;
  }

  var xml = args.xml;

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
    transitionToFinalView(function()
    {
      renderDiagram(xml, layoutOpts).catch(function(e)
      {
        showError("Failed to render diagram: " + e.message);
      });
    });
  }
  catch (e)
  {
    showError("Failed to render diagram: " + e.message);
  }
};

app.ontoolresult = function(result)
{
  // Cancel pending ontoolinput render — tool result is authoritative
  if (pendingToolInputTimer != null)
  {
    clearTimeout(pendingToolInputTimer);
    pendingToolInputTimer = null;
  }

  var textBlock = result.content && result.content.find(function(c) { return c.type === "text"; });

  if (result.isError)
  {
    endStreaming();
    var errorMsg = (textBlock && textBlock.text) ? textBlock.text : "Unknown error";
    showError("Tool error: " + errorMsg);
    return;
  }

  if (textBlock && textBlock.type === "text")
  {
    // Unified payload: {xml|mermaid, postLayout, startNodeIds, endNodeIds, _version} as JSON.
    // Fall back to treating the raw text as XML if JSON parsing fails.
    var mermaidText = null;
    var xmlText = null;
    var postLayout = null;
    var startNodeIds = null;
    var endNodeIds = null;

    try
    {
      var parsed = JSON.parse(textBlock.text);

      if (parsed && typeof parsed.mermaid === 'string')
      {
        mermaidText = parsed.mermaid;
        postLayout = parsed.postLayout || null;
        startNodeIds = parsed.startNodeIds || null;
        endNodeIds = parsed.endNodeIds || null;
      }
      else if (parsed && typeof parsed.xml === 'string')
      {
        xmlText = parsed.xml;
        postLayout = parsed.postLayout || null;
        startNodeIds = parsed.startNodeIds || null;
        endNodeIds = parsed.endNodeIds || null;
      }
    }
    catch (e)
    {
      // Not JSON — treat the raw text as XML
    }

    var layoutOpts = { skipIntroAnim: true, fadeIn: true, postLayout: postLayout, startNodeIds: startNodeIds, endNodeIds: endNodeIds };

    if (mermaidText != null)
    {
      transitionToFinalView(function()
      {
        mermaidPreviewEl.style.display = 'none';

        waitForGraphViewer()
          .then(function()
          {
            return convertMermaidToXml(mermaidText);
          })
          .then(function(xml)
          {
            return renderDiagram(xml, layoutOpts);
          })
          .catch(function(e)
          {
            showError("Failed to convert Mermaid diagram: " + e.message);
          });
      });
    }
    else
    {
      var rawXml = xmlText != null ? xmlText : textBlock.text;
      var normalizedXml = normalizeDiagramXml(rawXml);

      if (normalizedXml)
      {
        transitionToFinalView(function()
        {
          renderDiagram(normalizedXml, layoutOpts).catch(function(e)
          {
            showError("Failed to render diagram: " + e.message);
          });
        });
      }
      else
      {
        endStreaming();
        var inputPreview = rawXml.substring(0, 200);
        showError(invalidDiagramXmlMessage + "\\n\\nReceived (first 200 chars): " + inputPreview);
      }
    }
  }
  else
  {
    endStreaming();
    var blockTypes = result.content
      ? result.content.map(function(c) { return c.type; }).join(", ")
      : "none";
    showError(invalidDiagramXmlMessage + "\\n\\nContent block types: " + blockTypes);
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

// Re-render when tab becomes visible if the viewer failed to initialize
// or rendered with zero dimensions in the background (GraphViewer needs
// nonzero offsetWidth; rAF-based size reporting returns 0 in hidden tabs)
document.addEventListener('visibilitychange', function()
{
  if (!document.hidden && currentXml)
  {
    var svgEl = containerEl.querySelector('svg');
    var needsRerender = graphViewer == null ||
      svgEl == null ||
      svgEl.getBoundingClientRect().height < 1;

    if (needsRerender)
    {
      graphViewer = null;
      renderDiagram(currentXml).catch(function(e)
      {
        showError("Failed to render diagram: " + e.message);
      });
    }
    else
    {
      // Viewer rendered OK but host may have wrong size — update it
      notifySize('visibilitychange');
    }
  }
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

// ── Diagram validation ───────────────────────────────────────────────────────

/**
 * Validate draw.io XML and return errors/warnings.
 * Uses regex-based extraction — no XML parser needed.
 *
 * @param {string} xml - Raw draw.io XML string.
 * @returns {{errors: string[], warnings: string[]}}
 */
function validateDiagramXml(xml)
{
  var errors = [];
  var warnings = [];

  // 1. XML comments
  if (xml.indexOf("<!--") >= 0)
  {
    errors.push("XML comments (<!-- -->) are forbidden — remove all comments");
  }

  // 2. Collect all IDs and cell metadata via regex
  //    Match both <mxCell ...> and <mxCell .../> and <object ...>/<UserObject ...>
  var allIds = new Set();
  var duplicateIds = [];
  var cells = []; // {id, edge, vertex, source, target, parent, selfClosing, hasGeometryChild, line}

  // Extract id attributes from all elements (mxCell, object, UserObject)
  var idRegex = /\bid="([^"]*)"/g;
  var idMatch;

  while ((idMatch = idRegex.exec(xml)) !== null)
  {
    var id = idMatch[1];

    if (allIds.has(id))
    {
      duplicateIds.push(id);
    }
    else
    {
      allIds.add(id);
    }
  }

  if (duplicateIds.length > 0)
  {
    errors.push("Duplicate IDs: " + duplicateIds.join(", "));
  }

  // 3. Check structural cells
  if (!allIds.has("0"))
  {
    errors.push("Missing root cell with id=\"0\" — every diagram needs <mxCell id=\"0\"/>");
  }

  if (!allIds.has("1"))
  {
    errors.push("Missing default layer cell with id=\"1\" parent=\"0\" — every diagram needs <mxCell id=\"1\" parent=\"0\"/>");
  }

  // 4. Parse mxCell elements for detailed checks
  //    We split the XML by <mxCell to process each cell block
  var cellBlocks = xml.split(/<mxCell\s/);

  for (var i = 1; i < cellBlocks.length; i++)
  {
    var block = cellBlocks[i];

    // Find the end of the opening tag
    var tagEnd = block.indexOf(">");

    if (tagEnd < 0)
    {
      continue;
    }

    var tagContent = block.substring(0, tagEnd);
    var isSelfClosing = tagContent.charAt(tagContent.length - 1) === "/";

    // Extract attributes
    var attrs = {};
    var attrRegex = /(\w+)="([^"]*)"/g;
    var m;

    while ((m = attrRegex.exec(tagContent)) !== null)
    {
      attrs[m[1]] = m[2];
    }

    var isEdge = attrs.edge === "1";
    var isVertex = attrs.vertex === "1";

    // 5. Self-closing edge cells (missing mxGeometry)
    if (isEdge && isSelfClosing)
    {
      errors.push("Edge id=\"" + (attrs.id || "?") + "\" is self-closing — every edge must contain <mxGeometry relative=\"1\" as=\"geometry\"/> as a child element");
    }

    // 6. Edge without mxGeometry child (non-self-closing but still missing it)
    if (isEdge && !isSelfClosing)
    {
      // Check if the block between > and </mxCell> contains mxGeometry
      var closingIdx = block.indexOf("</mxCell>");

      if (closingIdx > tagEnd)
      {
        var body = block.substring(tagEnd + 1, closingIdx);

        if (body.indexOf("mxGeometry") < 0)
        {
          errors.push("Edge id=\"" + (attrs.id || "?") + "\" has no <mxGeometry> child — edges must contain <mxGeometry relative=\"1\" as=\"geometry\"/>");
        }
      }
    }

    // 7. Dangling source/target references
    if (attrs.source && !allIds.has(attrs.source))
    {
      warnings.push("Edge id=\"" + (attrs.id || "?") + "\" references source=\"" + attrs.source + "\" which does not exist");
    }

    if (attrs.target && !allIds.has(attrs.target))
    {
      warnings.push("Edge id=\"" + (attrs.id || "?") + "\" references target=\"" + attrs.target + "\" which does not exist");
    }

    // 8. Dangling parent references (skip "0" and "1" which are structural)
    if (attrs.parent && attrs.parent !== "0" && !allIds.has(attrs.parent))
    {
      warnings.push("Cell id=\"" + (attrs.id || "?") + "\" references parent=\"" + attrs.parent + "\" which does not exist");
    }

    // 9. Cell with source/target but missing edge="1"
    if ((attrs.source || attrs.target) && !isEdge)
    {
      warnings.push("Cell id=\"" + (attrs.id || "?") + "\" has source/target attributes but is missing edge=\"1\"");
    }
  }

  return { errors: errors, warnings: warnings };
}

// ── Shape search ─────────────────────────────────────────────────────────────

/**
 * Soundex phonetic encoding — matches the implementation in draw.io's Editor.js.
 * Returns a 4-character code (letter + 3 digits).
 */
function soundex(name)
{
  if (name == null || name.length === 0)
  {
    return "";
  }

  var s = [];
  var si = 1;
  var mappings = "01230120022455012603010202";

  s[0] = name[0].toUpperCase();

  for (var i = 1, l = name.length; i < l; i++)
  {
    var c = name[i].toUpperCase().charCodeAt(0) - 65;

    if (c >= 0 && c <= 25)
    {
      if (mappings[c] !== "0")
      {
        if (mappings[c] !== s[si - 1])
        {
          s[si] = mappings[c];
          si++;
        }

        if (si > 3)
        {
          break;
        }
      }
    }
  }

  while (si <= 3)
  {
    s[si] = "0";
    si++;
  }

  return s.join("");
}

/**
 * Build a tag-to-entries lookup from the flat shape index array.
 * Each tag (and its Soundex equivalent) maps to a Set of indices.
 *
 * @param {Array} shapeIndex - Array of {style, w, h, title, tags, type}.
 * @returns {Object} tagMap - { tag: Set<number> }
 */
function buildTagMap(shapeIndex)
{
  var tagMap = {};

  for (var i = 0; i < shapeIndex.length; i++)
  {
    var rawTags = shapeIndex[i].tags;

    if (!rawTags)
    {
      continue;
    }

    var tokens = rawTags.toLowerCase().replace(/[\/,()]/g, " ").split(" ");
    var seen = {};

    for (var j = 0; j < tokens.length; j++)
    {
      var token = tokens[j];

      if (token.length < 2 || seen[token])
      {
        continue;
      }

      seen[token] = true;

      if (!tagMap[token])
      {
        tagMap[token] = new Set();
      }

      tagMap[token].add(i);

      // Also index by Soundex
      var sx = soundex(token.replace(/\.*\d*$/, ""));

      if (sx && sx !== token && !seen[sx])
      {
        seen[sx] = true;

        if (!tagMap[sx])
        {
          tagMap[sx] = new Set();
        }

        tagMap[sx].add(i);
      }
    }
  }

  return tagMap;
}

/**
 * Split a token on camelCase and letter-digit boundaries.
 * e.g. "pid2misc" → ["pid", "misc"], "pid2inst" → ["pid", "inst"],
 *      "discInst" → ["disc", "inst"], "hello" → ["hello"]
 *
 * @param {string} token - A single query token.
 * @returns {Array<string>} Sub-tokens (lowercased, length >= 2 only).
 */
function splitCompoundToken(token)
{
  // Split on: digit-to-letter, letter-to-digit, lowercase-to-uppercase
  var parts = token.replace(/([a-z])([A-Z])/g, "$1 $2")
                   .replace(/([a-zA-Z])(\d)/g, "$1 $2")
                   .replace(/(\d)([a-zA-Z])/g, "$1 $2")
                   .toLowerCase()
                   .split(/\s+/);

  return parts.filter(function(p) { return p.length >= 2; });
}

/**
 * Collect all shape indices that match a single term (exact + Soundex).
 * Returns an object with separate exact and phonetic sets.
 *
 * @param {Object} tagMap - Pre-built tag→indices map.
 * @param {string} term - A single search term (lowercase).
 * @returns {{ exact: Set<number>, phonetic: Set<number> }}
 */
function matchTerm(tagMap, term)
{
  var exact = new Set();
  var phonetic = new Set();

  var exactHits = tagMap[term];

  if (exactHits)
  {
    exactHits.forEach(function(idx) { exact.add(idx); });
  }

  var sx = soundex(term.replace(/\.*\d*$/, ""));

  if (sx && sx !== term)
  {
    var phoneticHits = tagMap[sx];

    if (phoneticHits)
    {
      phoneticHits.forEach(function(idx)
      {
        if (!exact.has(idx))
        {
          phonetic.add(idx);
        }
      });
    }
  }

  return { exact: exact, phonetic: phonetic };
}

/**
 * Search the shape index with scored ranking and graceful fallback.
 *
 * Algorithm:
 * 1. Normalize query terms (split camelCase/digit boundaries)
 * 2. Try strict AND across all terms
 * 3. If AND produces results → score and rank them
 * 4. If AND produces nothing → fall back to scored OR (best partial matches)
 *
 * Scoring counts distinct query terms matched (primary) with a small
 * bonus for exact over Soundex matches (tiebreaker).
 * Score per term: +1.0 for exact tag match, +0.5 for Soundex-only match.
 *
 * @param {Array} shapeIndex - The flat shape array.
 * @param {Object} tagMap - Pre-built tag→indices map from buildTagMap().
 * @param {string} query - Space-separated search terms.
 * @param {number} limit - Maximum results to return.
 * @returns {Array} Matching shapes: [{style, w, h, title}].
 */
function searchShapes(shapeIndex, tagMap, query, limit)
{
  if (!query || !shapeIndex || shapeIndex.length === 0)
  {
    return [];
  }

  // Normalize: split compound tokens like "pid2misc" → ["pid", "misc"]
  var rawTerms = query.toLowerCase().split(/\s+/).filter(function(t) { return t.length > 0; });
  var terms = [];
  var seen = {};

  for (var i = 0; i < rawTerms.length; i++)
  {
    var subTokens = splitCompoundToken(rawTerms[i]);

    // If splitting produced nothing useful, keep the original if long enough
    if (subTokens.length === 0 && rawTerms[i].length >= 2)
    {
      subTokens = [rawTerms[i]];
    }

    for (var j = 0; j < subTokens.length; j++)
    {
      if (!seen[subTokens[j]])
      {
        seen[subTokens[j]] = true;
        terms.push(subTokens[j]);
      }
    }
  }

  if (terms.length === 0)
  {
    return [];
  }

  // Collect per-term match sets
  var termMatches = [];

  for (var i = 0; i < terms.length; i++)
  {
    termMatches.push(matchTerm(tagMap, terms[i]));
  }

  // Try strict AND first
  var andSet = null;

  for (var i = 0; i < termMatches.length; i++)
  {
    var combined = new Set();

    termMatches[i].exact.forEach(function(idx) { combined.add(idx); });
    termMatches[i].phonetic.forEach(function(idx) { combined.add(idx); });

    if (andSet === null)
    {
      andSet = combined;
    }
    else
    {
      var intersection = new Set();

      andSet.forEach(function(idx)
      {
        if (combined.has(idx))
        {
          intersection.add(idx);
        }
      });

      andSet = intersection;
    }

    if (andSet.size === 0)
    {
      break;
    }
  }

  // Score all candidates — either AND results or OR fallback
  // Per term: +1.0 for exact match, +0.5 for Soundex-only match
  // Each shape can only score once per term (exact wins over Soundex)
  var scores = {};

  if (andSet && andSet.size > 0)
  {
    // AND succeeded: score only the AND results
    andSet.forEach(function(idx)
    {
      scores[idx] = 0;
    });

    for (var i = 0; i < termMatches.length; i++)
    {
      // Track which AND candidates got an exact match for this term
      var exactForTerm = new Set();

      termMatches[i].exact.forEach(function(idx)
      {
        if (scores[idx] !== undefined)
        {
          scores[idx] += 1.0;
          exactForTerm.add(idx);
        }
      });

      termMatches[i].phonetic.forEach(function(idx)
      {
        if (scores[idx] !== undefined && !exactForTerm.has(idx))
        {
          scores[idx] += 0.5;
        }
      });
    }
  }
  else
  {
    // AND failed: fall back to OR — score every shape that matches any term
    for (var i = 0; i < termMatches.length; i++)
    {
      var exactForTerm = new Set();

      termMatches[i].exact.forEach(function(idx)
      {
        if (scores[idx] === undefined)
        {
          scores[idx] = 0;
        }

        scores[idx] += 1.0;
        exactForTerm.add(idx);
      });

      termMatches[i].phonetic.forEach(function(idx)
      {
        if (!exactForTerm.has(idx))
        {
          if (scores[idx] === undefined)
          {
            scores[idx] = 0;
          }

          scores[idx] += 0.5;
        }
      });
    }
  }

  // Sort by score descending, then by title alphabetically
  var candidates = Object.keys(scores).map(function(idx)
  {
    return { idx: parseInt(idx, 10), score: scores[idx] };
  });

  candidates.sort(function(a, b)
  {
    if (b.score !== a.score)
    {
      return b.score - a.score;
    }

    var titleA = shapeIndex[a.idx].title || "";
    var titleB = shapeIndex[b.idx].title || "";

    return titleA.localeCompare(titleB);
  });

  // Convert to result objects
  var results = [];

  for (var i = 0; i < candidates.length && results.length < limit; i++)
  {
    var shape = shapeIndex[candidates[i].idx];

    results.push({
      style: shape.style,
      w: shape.w,
      h: shape.h,
      title: shape.title
    });
  }

  return results;
}

// ── Server ───────────────────────────────────────────────────────────────────

/**
 * Create a new MCP server instance with the create_diagram tool + UI resource.
 *
 * @param {string} html - The pre-built, self-contained HTML string.
 * @param {object} [options] - Options.
 * @param {string} [options.domain] - Widget domain for ChatGPT sandbox rendering (e.g. "https://mcp.draw.io").
 * @param {string} [options.xmlReference] - XML generation reference text for the tool description.
 * @param {string} [options.mermaidReference] - Mermaid syntax reference text appended to the tool description.
 * @param {Array} [options.shapeIndex] - Shape search index array from search-index.json.
 * @param {object} [options.serverOptions] - Optional McpServer constructor options (e.g. jsonSchemaValidator).
 * @returns {McpServer}
 */
export function createServer(html, options = {})
{
  const { domain, xmlReference = "", mermaidReference = "", shapeIndex = null, serverOptions = {} } = typeof options === "object" && options !== null
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
        "Creates and displays an interactive draw.io diagram. Accepts either draw.io XML or Mermaid.js syntax — provide exactly one.\n\n" +
        "**Use Mermaid** for the following diagram types (all rendered natively, no upstream mermaid runtime):\n" +
        "  - flowchart / graph (TD, LR, …)\n" +
        "  - sequenceDiagram\n" +
        "  - classDiagram\n" +
        "  - stateDiagram / stateDiagram-v2\n" +
        "  - erDiagram\n" +
        "  - gantt\n" +
        "  - pie\n" +
        "  - journey (user-journey)\n" +
        "  - gitGraph\n" +
        "  - mindmap\n" +
        "  - timeline\n" +
        "  - quadrantChart\n" +
        "  - xychart-beta\n" +
        "  - sankey-beta\n" +
        "  - requirementDiagram\n" +
        "  - C4Context / C4Container / C4Component\n" +
        "  - block-beta\n" +
        "  - architecture-beta\n" +
        "  - packet-beta\n" +
        "  - kanban\n" +
        "  - radar-beta\n" +
        "  - treemap-beta\n" +
        "  - treeview-beta (draw.io-specific)\n" +
        "  - venn (draw.io-specific) — syntax: `venn` then `set A [\"Label\"]` for each set, `union A,B` for declared overlaps (informational), and `text A` / `text A,B` followed by `[\"Region label\"]` for text inside a region. Do NOT use `A AND B[...]` or `A[\"...\"]` shorthand — those lines are ignored.\n" +
        "  - ishikawa (draw.io-specific)\n" +
        "  - zenuml\n" +
        "**Strong default: use Mermaid for every diagram type on that list above.** Mermaid is simpler, more reliable, and the native Mermaid layout handles positioning and routing for you. For a flowchart, state diagram, sequence, ER, class, gantt, gitGraph, mindmap, etc. — reach for the `mermaid` parameter, not `xml`. Do not default to XML for flowcharts.\n\n" +
        "**Use XML** when the diagram type isn't on the Mermaid list above OR when the user explicitly asks for XML / draw.io format. Typical cases where XML is the right choice:\n" +
        "- **UI mockups / wireframes / screen designs** — buttons, form fields, sidebars, modal dialogs (`shape=mxgraph.bootstrap.*`, `shape=mxgraph.ios.*`, `shape=mxgraph.android.*`)\n" +
        "- **Floor plans / seating charts / room layouts** — rooms, doors, furniture (`shape=mxgraph.floorplan.*`)\n" +
        "- **Cloud architecture** with AWS / Azure / GCP / Kubernetes icons (`shape=mxgraph.aws4.*`, `shape=mxgraph.azure.*`, `shape=mxgraph.gcp2.*`, `shape=mxgraph.kubernetes.*`)\n" +
        "- **Network topology** with Cisco / Rack / networking shapes (`shape=mxgraph.cisco*.*`, `shape=mxgraph.rack.*`, `shape=mxgraph.networking.*`)\n" +
        "- **P&ID / electrical / engineering schematics** (`shape=mxgraph.pid2.*`, `shape=mxgraph.electrical.*`, `shape=mxgraph.mscae.*`)\n" +
        "- **Swimlanes / pools** with custom colors and hand-placed contents\n" +
        "- **UML class / component / deployment diagrams** where positioning carries meaning\n" +
        "- **Venn diagrams, quadrant charts, concept maps** with custom regions — anything where hand-placed geometry is the point\n" +
        "- **Any diagram requiring specific colors, fonts, stencils, or layouts** that Mermaid can't control precisely\n" +
        "Call `search_shapes` first when you need industry icons (AWS / Azure / Cisco / P&ID / Kubernetes / floorplan / mockup / electrical) to find the correct `style` string for each shape.\n\n" +
        "---\n\n" +
        "**XML reasoning discipline (applies ONLY when you chose XML — skip this whole section if you're using Mermaid):** Your job in XML is declaring logical structure — nodes, edges, labels, groupings. Follow these steps in order: (1) **Decide `postLayout` FIRST, before writing any XML.** If the XML diagram is a flowchart, state diagram, decision tree, or any directional/hierarchical process diagram (which you should rarely be writing as XML — prefer Mermaid), you MUST pass `postLayout` — use `verticalFlow` by default, `horizontalFlow` when the flow is drawn left-to-right, `tree` for pure hierarchies. Other algorithms (`force`, `stress`, `radial`) apply to their respective diagram types — see the `postLayout` parameter description. Omit `postLayout` only when the layout carries hand-crafted meaning (swimlanes, containers, architecture, UML) — the typical reason you chose XML in the first place. When `postLayout` is set, your x/y coordinates only need to express rough direction; ELK re-lays out the vertices. (1b) **Whenever you set `postLayout` to `verticalFlow` or `horizontalFlow`, you MUST also pass `startNodeIds` and `endNodeIds`** — arrays of cell IDs for your Start/entry and End/terminator nodes (e.g. `startNodeIds: [\"start\"]`, `endNodeIds: [\"end\"]`, or `endNodeIds: [\"success\",\"rejected\"]` for multi-outcome flows). This is always required, not just when the flow has feedback edges — ELK's topological detection mis-picks whenever your flow has loops, multiple entry points, or disconnected components. You are the one who named the cells; it's trivial for you to list them, and guesswork on the server side is not. (2) Pick ONE concrete scenario on your first impulse and commit — do not pitch alternatives, do not flip-flop between approaches. (3) Use the rigid grid in the XML reference (`x = col*180 + 40`, `y = row*120 + 40`) without computing spacings, canvas dimensions, or overlap checks. (4) Never add `<Array as=\"points\">` waypoints or `exitX/exitY/entryX/entryY` — when postLayout runs, ELK sets them; otherwise drawio's edge router handles it. (5) Do NOT narrate in your reasoning: no \"building the diagram\", no column enumeration, no coordinate math in prose, no coordinate re-verification after placement. Go straight to XML.\n\n" +
        "**User preference override — XML only.** If the user expresses a preference for draw.io XML over Mermaid in any phrasing (examples: \"no mermaid\", \"skip mermaid\", \"use xml\", \"I want drawio format\", \"stop using mermaid\", \"give me the xml\", \"native drawio only\", etc.), from that point onward in the conversation you MUST use the `xml` parameter exclusively and MUST NOT use the `mermaid` parameter, even for diagram types where Mermaid would normally be preferable. This preference persists for the remainder of the conversation unless the user clearly reverses it (e.g. \"mermaid is fine again\"). When the preference is active, translate any diagram request — including flowcharts, sequence diagrams, ER diagrams, etc. — directly to well-formed mxGraphModel XML.\n\n" +
        "When using XML: IMPORTANT — the XML must be well-formed. Do NOT include ANY XML comments (<!-- -->) in the output.\n\n" +
        xmlReference +
        (mermaidReference ? "\n\n---\n\n" + mermaidReference : ""),
      inputSchema:
      {
        xml: z
          .string()
          .optional()
          .describe(
            "draw.io XML content in mxGraphModel format. Must be well-formed XML: no XML comments (<!-- -->), no unescaped special characters in attribute values. Mutually exclusive with 'mermaid'."
          ),
        mermaid: z
          .string()
          .optional()
          .describe(
            "Mermaid.js diagram definition (e.g. 'graph TD\\n  A-->B'). Supports 26 diagram types — see the tool description for the full list. The diagram is parsed and laid out natively (no upstream mermaid runtime) and converted to draw.io format. Mutually exclusive with 'xml'."
          ),
        postLayout: z
          .enum(["verticalFlow", "horizontalFlow", "tree", "force", "stress", "radial"])
          .optional()
          .describe(
            "Optional client-side layout pass applied after the diagram renders, powered by ELK (Eclipse Layout Kernel). Vertices animate (morph) from the positions you supplied to the algorithm's layout — they are **replaced**, so only your edge topology survives. You are the judge of when a canonical layout will read better than the coordinates you wrote; set this whenever the diagram type fits one of the algorithms below:\n" +
            "- `verticalFlow` (ELK layered, top-down): flowcharts, process diagrams, state diagrams, decision flows, pipelines drawn vertically, ER/class diagrams with clear parent→child direction.\n" +
            "- `horizontalFlow` (ELK layered, left-to-right): sequence-of-steps pipelines drawn horizontally, swimlanes aligned L→R, any directional process where the layout is wider than tall.\n" +
            "- `tree` (ELK mrtree): org charts, decision trees, taxonomies, file/folder hierarchies — pure tree structures with a single root.\n" +
            "- `force` (ELK force-directed): network / topology diagrams without a clear hierarchy (peer-to-peer, social graphs, knowledge graphs).\n" +
            "- `stress` (ELK stress majorization): small-to-mid general graphs where `force` looks too loose — usually tighter and more readable for 10-30 nodes without a root.\n" +
            "- `radial` (ELK radial): concentric layers around a root (mind maps, centered ego networks, influence diagrams).\n" +
            "**Omit** for diagrams whose layout carries meaning you hand-crafted: swimlanes/pools, containers, architecture / deployment / network topology with grouped regions, P&ID or circuit schematics, floor plans, UML diagrams with deliberate placement. For Mermaid diagrams, the native layout already runs ELK — set this only if you specifically want a different algorithm.\n\n" +
            "**When you set this to `verticalFlow` or `horizontalFlow`, you MUST also provide `startNodeIds` and `endNodeIds`** so ELK knows which nodes belong in the first and last layers."
          ),
        startNodeIds: z
          .array(z.string())
          .optional()
          .describe(
            "**REQUIRED whenever `postLayout` is `verticalFlow` or `horizontalFlow`.** Cell IDs of start/entry nodes — pinned to the first layer (top for verticalFlow, left for horizontalFlow). Always pass this for layered flowcharts; do not rely on ELK's automatic source detection. You authored the cell IDs, so listing them is trivial. Example: a login flow with `<mxCell id=\"start\" value=\"Start\" ...>` should pass `startNodeIds: [\"start\"]`. Multiple entry points are allowed (e.g. `[\"manualStart\", \"scheduledStart\"]`)."
          ),
        endNodeIds: z
          .array(z.string())
          .optional()
          .describe(
            "**REQUIRED whenever `postLayout` is `verticalFlow` or `horizontalFlow`.** Cell IDs of end/terminator nodes — pinned to the last layer (bottom for verticalFlow, right for horizontalFlow). Always pass this for layered flowcharts; do not rely on ELK's automatic sink detection. Example: `endNodeIds: [\"end\"]` for a single endpoint, or `endNodeIds: [\"success\", \"rejected\", \"expired\"]` for a multi-outcome flow."
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
    async function({ xml, mermaid, postLayout, startNodeIds, endNodeIds })
    {
      var hasXml = (xml != null && typeof xml === "string" && xml.trim().length > 0);
      var hasMermaid = (mermaid != null && typeof mermaid === "string" && mermaid.trim().length > 0);

      try { console.log("[create_diagram] " + getBuildVersion() + " path=" + (hasMermaid ? "mermaid" : hasXml ? "xml" : "error")); } catch (e) {}

      if (hasXml === hasMermaid)
      {
        return {
          content: [{ type: "text", text: "Provide exactly one of 'xml' or 'mermaid'. " + (hasXml ? "Both were provided." : "Neither was provided.") }],
          isError: true,
        };
      }

      // Mermaid path: return JSON for client-side conversion
      if (hasMermaid)
      {
        return {
          content: [{ type: "text", text: JSON.stringify({ mermaid: mermaid, postLayout: postLayout || null, startNodeIds: startNodeIds || null, endNodeIds: endNodeIds || null, _version: getBuildVersion() }) }],
        };
      }

      // XML path: normalize, postprocess, validate
      var normalizedXml = normalizeDiagramXml(xml);

      if (!normalizedXml)
      {
        var preview = xml.length > 200 ? xml.substring(0, 200) + "..." : xml;
        return {
          content: [{ type: "text", text: "Could not extract draw.io XML from input. Expected <mxGraphModel> or <mxfile> root element. Received (first 200 chars): " + preview }],
          isError: true,
        };
      }

      // Server-side postprocess: xmldom normalization only (repairs
      // malformed AI XML so mxCodec can decode it). ELK edge routing
      // moved client-side — elkjs can't run in Cloudflare Workers.
      try
      {
        var ppResult = await postprocessDiagramXml(normalizedXml);
        normalizedXml = ppResult.xml;
      }
      catch (e)
      {
        try { console.log("[create_diagram] postprocessDiagramXml THREW: " + (e && e.message)); } catch (_) {}
      }

      var content = [
        { type: "text", text: JSON.stringify({ xml: normalizedXml, postLayout: postLayout || null, startNodeIds: startNodeIds || null, endNodeIds: endNodeIds || null, _version: getBuildVersion() }) }
      ];

      // Validate and append warnings/errors so the LLM can self-correct
      var validation = validateDiagramXml(normalizedXml);

      if (validation.errors.length > 0 || validation.warnings.length > 0)
      {
        var messages = [];

        if (validation.errors.length > 0)
        {
          messages.push("ERRORS (will cause rendering issues):\n- " + validation.errors.join("\n- "));
        }

        if (validation.warnings.length > 0)
        {
          messages.push("WARNINGS (may cause issues):\n- " + validation.warnings.join("\n- "));
        }

        content.push({ type: "text", text: messages.join("\n\n") });
      }

      return { content: content };
    }
  );

  // ── search_shapes tool (only registered when shapeIndex is provided) ───────

  if (shapeIndex && shapeIndex.length > 0)
  {
    var tagMap = buildTagMap(shapeIndex);

    registerAppTool(
      server,
      "search_shapes",
      {
        title: "Search Shapes",
        description:
          "Search the draw.io shape library by keywords. Returns matching shapes with " +
          "their exact style strings, dimensions, and titles. Use ONLY for diagrams that " +
          "need industry-specific or branded icons (cloud architecture, network topology, " +
          "P&ID, electrical, Cisco, Kubernetes, BPMN). Do NOT use for standard diagram " +
          "types like flowcharts, UML, ERD, org charts, or mind maps — these use basic " +
          "geometric shapes (rectangles, diamonds, circles, cylinders) that are already " +
          "covered in the XML reference. Also skip if the user asks to use basic/simple " +
          "shapes or says not to search. The style string from the results can be " +
          "used directly in mxCell style attributes.",
        inputSchema:
        {
          query: z
            .string()
            .describe(
              "Space-separated search keywords (e.g. 'pid globe valve', 'aws lambda', 'cisco router', 'kubernetes pod')"
            ),
          limit: z
            .number()
            .optional()
            .describe(
              "Maximum number of results to return (default: 10, max: 50)"
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
          "openai/toolInvocation/invoking": "Searching shapes...",
          "openai/toolInvocation/invoked": "Shape search complete.",
        },
      },
      async function({ query, limit })
      {
        var maxLimit = Math.min(limit || 10, 50);
        var results = searchShapes(shapeIndex, tagMap, query, maxLimit);

        if (results.length === 0)
        {
          return {
            content: [{ type: "text", text: "No shapes found for query: " + query }],
          };
        }

        return {
          content: [{ type: "text", text: JSON.stringify(results, null, 2) }],
        };
      }
    );
  }

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
                  resourceDomains: ["https://viewer.diagrams.net", "https://app.diagrams.net"],
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
