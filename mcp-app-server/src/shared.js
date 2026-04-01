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
  var createObj = { type: "xml", compressed: true, data: base64 };

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

        notifySize();
      });
    }
    else
    {
      GraphViewer.processElements();
      notifySize();
    }
  }
  catch (e)
  {
    showError("Failed to render diagram: " + e.message);
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

// --- Streaming: raw Graph + standalone merge (no GraphViewer) ---

var streamGraph = null;
var streamPendingEdges = null;
var streamFitRaf = null;

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

  // Scale to fit width, clamped to [0.6, 1.0]
  var fitScaleW = (cw - padding * 2) / Math.max(uw, 1);
  var targetScale = Math.min(fitScaleW, 1);
  targetScale = Math.max(targetScale, 0.6);

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

      setTimeout(function()
      {
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
  var textBlock = result.content && result.content.find(function(c) { return c.type === "text"; });

  endStreaming();

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
