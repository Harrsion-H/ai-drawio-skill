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
    <base href="https://app.diagrams.net/" />
    <title>draw.io Diagram</title>
    <link rel="icon" href="/favicon.png" type="image/png" />
    <style>
      * { margin: 0; padding: 0; box-sizing: border-box; }

      html {
        color-scheme: light dark;
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
      }
      #diagram-container.streaming {
        min-height: 400px;
        overflow: hidden;
        position: relative;
      }
      #diagram-container.streaming > div {
        width: 100% !important;
        height: 100% !important;
        overflow: hidden !important;
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
    <script>window.DRAWIO_BASE_URL = "https://app.diagrams.net";<\/script>
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

// --- State ---
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

  try
  {
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

        // Intro animation: bounce vertices, wipe edges
        if (viewer != null && viewer.graph != null)
        {
          playViewerIntroAnimation(viewer.graph);
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
    showError("Failed to render diagram: " + e.message);
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

/**
 * Smooth viewport during streaming: centers the entire diagram and
 * gradually zooms out as it grows. Scale clamped to [0.8, 1.0].
 * Uses lerp per partial-update call for smooth motion.
 */
function streamFollowNewCells(graph)
{
  // Compute model-space bounding box from cell geometries directly,
  // not from getGraphBounds() which depends on current scale/translate
  // and causes feedback wobble.
  var model = graph.getModel();
  var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  var cellCount = 0;

  for (var id in model.cells)
  {
    if (id === '0' || id === '1') continue;

    var cell = model.cells[id];

    if (!cell.visible) continue;

    var geo = cell.geometry;

    if (geo == null || geo.relative) continue;

    // Accumulate parent offsets for contained cells
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

    minX = Math.min(minX, x1);
    minY = Math.min(minY, y1);
    maxX = Math.max(maxX, x2);
    maxY = Math.max(maxY, y2);
    cellCount++;
  }

  if (cellCount === 0) return;

  var uw = maxX - minX;
  var uh = maxY - minY;

  if (uw <= 0 && uh <= 0) return;

  var padding = 20;
  var cw = containerEl.clientWidth;
  var ch = containerEl.clientHeight;

  if (cw <= 0 || ch <= 0) return;

  // Scale to fit width, clamped to [0.1, 1.0]
  var fitScaleW = (cw - padding * 2) / Math.max(uw, 1);
  var targetScale = Math.min(fitScaleW, 1);
  targetScale = Math.max(targetScale, 0.1);

  // Dynamically grow the streaming container to fit the diagram at this scale
  var neededH = Math.ceil(uh * targetScale + padding * 2);
  var streamH = Math.max(400, neededH);

  if (ch < streamH)
  {
    containerEl.style.height = streamH + 'px';
    ch = streamH;

    if (app.sendSizeChanged)
    {
      app.sendSizeChanged({ width: cw, height: streamH });
    }
  }

  // Translate to show the "active" part of the diagram:
  // - Horizontally: center the diagram
  // - Vertically: show the bottom edge (where new cells appear),
  //   keeping some padding. If the diagram fits vertically, center it.
  var cx = (minX + maxX) / 2;
  var viewH = ch / targetScale;
  var viewW = cw / targetScale;
  var targetTx = viewW / 2 - cx;

  var targetTy;

  if (uh <= viewH - padding * 2 / targetScale)
  {
    // Diagram fits vertically — center it
    var cy = (minY + maxY) / 2;
    targetTy = viewH / 2 - cy;
  }
  else
  {
    // Diagram taller than viewport — show bottom edge with padding
    var bottomPad = padding / targetScale;
    targetTy = viewH - bottomPad - maxY;
  }

  var curScale = graph.view.scale;
  var curTx = graph.view.translate.x;
  var curTy = graph.view.translate.y;

  // Skip if barely changed
  var dScale = Math.abs(curScale - targetScale);
  var dTx = Math.abs(curTx - targetTx) * targetScale;
  var dTy = Math.abs(curTy - targetTy) * targetScale;

  if (dScale < 0.005 && dTx < 2 && dTy < 2) return;

  // Lerp toward target each call. Since partials arrive ~30ms apart,
  // a factor of 0.15 gives smooth ~200ms convergence without needing
  // rAF animations that get cancelled by the next partial.
  var lerpFactor = 0.15;

  var newScale = curScale + (targetScale - curScale) * lerpFactor;
  var newTx = curTx + (targetTx - curTx) * lerpFactor;
  var newTy = curTy + (targetTy - curTy) * lerpFactor;

  // Snap if very close to target
  if (Math.abs(newScale - targetScale) < 0.005) newScale = targetScale;
  if (Math.abs(newTx - targetTx) < 1) newTx = targetTx;
  if (Math.abs(newTy - targetTy) < 1) newTy = targetTy;

  graph.view.scaleAndTranslate(newScale, newTx, newTy);
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

      if (newIds.length > 0)
      {
        queueCellAnimation(streamGraph, newIds);
      }

      // Notify size with fixed streaming height
      if (app.sendSizeChanged)
      {
        app.sendSizeChanged({ width: containerEl.clientWidth, height: 400 });
      }

      streamFollowNewCells(streamGraph);
    }
    else if (streamGraph != null)
    {
      // Subsequent partials: merge delta, animate new cells, fit
      var prevIds = getModelCellIds(streamGraph.getModel());
      streamPendingEdges = streamMergeXmlDelta(streamGraph, streamPendingEdges, xmlNode);
      var newIds = findNewCellIds(streamGraph.getModel(), prevIds);

      if (newIds.length > 0)
      {
        queueCellAnimation(streamGraph, newIds);
      }

      // Also flush any deferred cells whose geometry arrived during merge
      if (pendingAnimCellIds.length > 0 && animDebounceTimer == null)
      {
        queueCellAnimation(streamGraph, []);
      }

      // Smooth viewport: center diagram, zoom out as it grows
      streamFollowNewCells(streamGraph);
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
    // Crossfade: fade out streaming graph, then render final
    var streamContainer = containerEl.querySelector(':first-child');

    if (streamContainer != null && streamGraph != null)
    {
      streamContainer.style.transition = 'opacity 0.3s ease-out';
      streamContainer.style.opacity = '0';

      pendingToolInputTimer = setTimeout(function()
      {
        pendingToolInputTimer = null;
        endStreaming();
        renderDiagram(xml).catch(function(e)
        {
          showError("Failed to render diagram: " + e.message);
        });
      }, 300);
    }
    else
    {
      endStreaming();
      renderDiagram(xml).catch(function(e)
      {
        showError("Failed to render diagram: " + e.message);
      });
    }
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

  endStreaming();

  if (result.isError)
  {
    var errorMsg = (textBlock && textBlock.text) ? textBlock.text : "Unknown error";
    showError("Tool error: " + errorMsg);
    return;
  }

  if (textBlock && textBlock.type === "text")
  {
    var normalizedXml = normalizeDiagramXml(textBlock.text);

    if (normalizedXml)
    {
      renderDiagram(normalizedXml).catch(function(e)
      {
        showError("Failed to render diagram: " + e.message);
      });
    }
    else
    {
      var inputPreview = textBlock.text.substring(0, 200);
      showError(invalidDiagramXmlMessage + "\\n\\nReceived (first 200 chars): " + inputPreview);
    }
  }
  else
  {
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
 * @param {Array} [options.shapeIndex] - Shape search index array from search-index.json.
 * @param {object} [options.serverOptions] - Optional McpServer constructor options (e.g. jsonSchemaValidator).
 * @returns {McpServer}
 */
export function createServer(html, options = {})
{
  const { domain, xmlReference = "", shapeIndex = null, serverOptions = {} } = typeof options === "object" && options !== null
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
        "IMPORTANT: The XML must be well-formed. Do NOT include ANY XML comments (<!-- -->) in the output — they are strictly forbidden.\n\n" +
        xmlReference,
      inputSchema:
      {
        xml: z
          .string()
          .describe(
            "The draw.io XML content in mxGraphModel format to render as a diagram. Must be well-formed XML: no XML comments (<!-- -->), no unescaped special characters in attribute values."
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
      if (typeof xml !== "string" || xml.trim().length === 0)
      {
        return {
          content: [{ type: "text", text: "Invalid input: expected a non-empty XML string, got " + (xml === null ? "null" : typeof xml) }],
          isError: true,
        };
      }

      var normalizedXml = normalizeDiagramXml(xml);

      if (!normalizedXml)
      {
        var preview = xml.length > 200 ? xml.substring(0, 200) + "..." : xml;
        return {
          content: [{ type: "text", text: "Could not extract draw.io XML from input. Expected <mxGraphModel> or <mxfile> root element. Received (first 200 chars): " + preview }],
          isError: true,
        };
      }

      // Post-process XML to optimize edge routing
      try
      {
        normalizedXml = postprocessDiagramXml(normalizedXml).xml;
      }
      catch (e)
      {
        // Use original XML on failure
      }

      var content = [{ type: "text", text: normalizedXml }];

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
