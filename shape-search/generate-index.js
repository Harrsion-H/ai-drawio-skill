#!/usr/bin/env node

/**
 * Shape Search Index Generator
 *
 * Loads the draw.io client (app.min.js) via jsdom, initializes all sidebar
 * palettes, and intercepts createVertexTemplateEntry / createEdgeTemplateEntry
 * calls to capture {style, w, h, title, tags} for every shape.
 *
 * Usage:
 *   DRAWIO_DEV_PATH=../drawio-dev node generate-index.js
 *
 * Output:
 *   search-index.json — array of shape objects
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { JSDOM } from "jsdom";

var __dirname = path.dirname(fileURLToPath(import.meta.url));
var DRAWIO_BASE_URL = "https://app.diagrams.net";
var DRAWIO_ROOT = null;
var useLocalFiles = false;

if (process.env.DRAWIO_DEV_PATH)
{
  DRAWIO_ROOT = path.resolve(process.env.DRAWIO_DEV_PATH, "src", "main", "webapp");

  var appMinPath = path.join(DRAWIO_ROOT, "js", "app.min.js");

  if (!fs.existsSync(appMinPath))
  {
    console.error("Cannot find app.min.js at: " + appMinPath);
    console.error("Set DRAWIO_DEV_PATH to the drawio-dev repository root.");
    process.exit(1);
  }

  useLocalFiles = true;
  console.log("Loading app.min.js from: " + DRAWIO_ROOT);
}
else
{
  console.log("Loading app.min.js from: " + DRAWIO_BASE_URL + "/js/app.min.js");
}

/**
 * Fetches a URL synchronously using curl. Returns the content as a string,
 * or null if the request fails.
 */
function fetchSync(url)
{
  try
  {
    return execFileSync("curl", ["-sL", "--fail", url], {
      maxBuffer: 50 * 1024 * 1024,
      timeout: 30000
    }).toString("utf8");
  }
  catch (e)
  {
    return null;
  }
}

var appCode;

if (useLocalFiles)
{
  appCode = fs.readFileSync(path.join(DRAWIO_ROOT, "js", "app.min.js"), "utf8");
}
else
{
  appCode = fetchSync(DRAWIO_BASE_URL + "/js/app.min.js");

  if (!appCode)
  {
    console.error("Failed to download app.min.js from " + DRAWIO_BASE_URL);
    process.exit(1);
  }

  console.log("Downloaded app.min.js (" + (appCode.length / (1024 * 1024)).toFixed(1) + " MB)");
}
var capturedShapes = [];

// ── Create jsdom with minimal stubs ──────────────────────────────────────────

var dom = new JSDOM(
  "<!DOCTYPE html><html><head></head><body></body></html>",
  {
    url: "https://app.diagrams.net/?dev=1&test=1&createindex=1",
    pretendToBeVisual: true,
    runScripts: "dangerously",
    beforeParse: function(window)
    {
      // XMLHttpRequest that serves files from local disk or the web
      window.XMLHttpRequest = function()
      {
        this.readyState = 0;
        this.status = 0;
        this.responseText = "";
        this.responseXML = null;
      };

      window.XMLHttpRequest.prototype = {
        open: function(method, url) { this._url = url; },
        send: function()
        {
          try
          {
            var content = null;
            var requestUrl = this._url;

            if (useLocalFiles)
            {
              var filePath = requestUrl;

              if (filePath.startsWith("/"))
              {
                filePath = DRAWIO_ROOT + filePath;
              }
              else if (filePath.startsWith("http"))
              {
                this.status = 404;
                this.readyState = 4;

                if (this.onreadystatechange) this.onreadystatechange();

                return;
              }
              else if (!filePath.match(/^[a-zA-Z]:/))
              {
                filePath = DRAWIO_ROOT + "/" + filePath;
              }

              if (fs.existsSync(filePath))
              {
                content = fs.readFileSync(filePath, "utf8");
              }
            }
            else
            {
              var fullUrl;

              if (requestUrl.startsWith("http"))
              {
                fullUrl = requestUrl;
              }
              else if (requestUrl.startsWith("/"))
              {
                fullUrl = DRAWIO_BASE_URL + requestUrl;
              }
              else
              {
                fullUrl = DRAWIO_BASE_URL + "/" + requestUrl;
              }

              content = fetchSync(fullUrl);
            }

            if (content != null)
            {
              this.responseText = content;
              this.status = 200;
              this.readyState = 4;

              try
              {
                var parser = new window.DOMParser();
                this.responseXML = parser.parseFromString(this.responseText, "text/xml");
              }
              catch (e) { /* ignore parse errors for non-XML files */ }

              if (this.onreadystatechange) this.onreadystatechange();
              if (this.onload) this.onload();
            }
            else
            {
              this.status = 404;
              this.readyState = 4;

              if (this.onreadystatechange) this.onreadystatechange();
            }
          }
          catch (e)
          {
            this.status = 500;
            this.readyState = 4;
          }
        },
        setRequestHeader: function() {},
        abort: function() {},
        getAllResponseHeaders: function() { return ""; },
        getResponseHeader: function() { return null; },
        overrideMimeType: function() {}
      };

      window.mxBasePath = useLocalFiles ? DRAWIO_ROOT + "/mxgraph/src" : "/mxgraph/src";
      window.mxLoadResources = false;
      window.mxForceIncludes = false;
      window.mxLoadStylesheets = false;
      window.urlParams = { createindex: "1", dev: "1", test: "1" };
      window.STENCIL_PATH = "/stencils";
      window.GRAPH_IMAGE_PATH = "/img";
      window.IMAGE_PATH = "/images";
      window.STYLE_PATH = "/styles";
      window.RESOURCES_PATH = "/resources";
      window.DRAWIO_BASE_URL = "https://app.diagrams.net";
      window.DRAWIO_SERVER_URL = "https://app.diagrams.net";
      window.DRAWIO_LOG_URL = "";
    }
  }
);

var w = dom.window;

// ── Load app.min.js ──────────────────────────────────────────────────────────

try
{
  w.eval(appCode);
}
catch (e)
{
  console.error("Failed to load app.min.js:", e.message);
  process.exit(1);
}

console.log("app.min.js loaded — Sidebar: " + typeof w.Sidebar + ", Graph: " + typeof w.Graph);

// ── Intercept template entry calls ───────────────────────────────────────────

var origVertexEntry = w.Sidebar.prototype.createVertexTemplateEntry;

w.Sidebar.prototype.createVertexTemplateEntry = function(style, width, height, value, title, showLabel, showTitle, tags)
{
  if (style)
  {
    var normalizedTags = "";

    if (tags != null && tags.length > 0)
    {
      normalizedTags = tags;

      if (title != null)
      {
        normalizedTags += " " + title;
      }
    }
    else
    {
      normalizedTags = (title != null) ? title.toLowerCase() : "";
    }

    capturedShapes.push({
      style: style,
      w: Math.round(width) || 0,
      h: Math.round(height) || 0,
      title: title || "",
      tags: normalizedTags,
      type: "vertex"
    });
  }

  return origVertexEntry.apply(this, arguments);
};

var origEdgeEntry = w.Sidebar.prototype.createEdgeTemplateEntry;

w.Sidebar.prototype.createEdgeTemplateEntry = function(style, width, height, value, title, showLabel, tags)
{
  if (style)
  {
    capturedShapes.push({
      style: style,
      w: Math.round(width) || 0,
      h: Math.round(height) || 0,
      title: title || "",
      tags: (tags != null && tags.length > 0) ? tags : (title ? title.toLowerCase() : ""),
      type: "edge"
    });
  }

  return origEdgeEntry.apply(this, arguments);
};

// ── Build a minimal Sidebar and run initPalettes ─────────────────────────────

var container = w.document.createElement("div");
container.style.width = "800px";
container.style.height = "600px";
w.document.body.appendChild(container);

// Load default theme for graph stylesheet
var themes = {};

try
{
  var defaultXml;

  if (useLocalFiles)
  {
    defaultXml = fs.readFileSync(path.join(DRAWIO_ROOT, "styles", "default.xml"), "utf8");
  }
  else
  {
    defaultXml = fetchSync(DRAWIO_BASE_URL + "/styles/default.xml");
  }

  if (defaultXml)
  {
    var themeDoc = new w.DOMParser().parseFromString(defaultXml, "text/xml");
    themes[w.Graph.prototype.defaultThemeName] = themeDoc.documentElement;
  }
}
catch (e)
{
  console.warn("Could not load default theme:", e.message);
}

var graph = new w.Graph(container, null, null, null, themes);
var editor = new w.Editor(false, null, null, graph);

// Create Sidebar via Object.create to skip the DOM-heavy constructor
var sidebar = Object.create(w.Sidebar.prototype);

sidebar.editorUi = {
  editor: editor,
  container: container,
  isOffline: function() { return true; },
  createTemporaryGraph: function(stylesheet)
  {
    return w.Graph.createOffscreenGraph(stylesheet);
  },
  addListener: function() {},
  fireEvent: function() {},
  getServiceName: function() { return "draw.io"; },
  getBaseUrl: function() { return "https://app.diagrams.net"; },
  formatEnabled: true
};

// Initialize fields that initPalettes requires
sidebar.taglist = {};
sidebar.currentSearchEntryLibrary = null;
sidebar.createdSearchIndex = [];
sidebar.shapetags = {};
sidebar.customEntries = null;
sidebar.appendCustomLibraries = false;
sidebar.addStencilsToIndex = false;
sidebar.styleToLibs = {};
sidebar.defaultImageWidth = 80;
sidebar.defaultImageHeight = 80;
sidebar.palettes = {};
sidebar.graph = graph;
sidebar.container = w.document.createElement("div");
sidebar.wrapper = w.document.createElement("div");
sidebar.container.appendChild(sidebar.wrapper);
w.document.body.appendChild(sidebar.container);

sidebar.initialDefaultVertexStyle = graph.getStylesheet().getDefaultVertexStyle() || { fontSize: 12 };
sidebar.initialDefaultEdgeStyle = graph.getStylesheet().getDefaultEdgeStyle() || {};

// Stub UI methods that are not needed for index generation
sidebar.showPalettes = function() {};
sidebar.showEntries = function() {};
sidebar.addSearchPalette = function() {};
sidebar.createItem = function() { return w.document.createElement("a"); };

sidebar.addPalette = function(id, title, expanded, fn)
{
  // Call fn to trigger createVertexTemplateEntry calls which populate the taglist
  try
  {
    if (fn) fn(w.document.createElement("div"));
  }
  catch (e) { /* ignore UI errors during palette building */ }
};

sidebar.addPaletteFunctions = function() {};

// Provide graph methods that entry functions may call
if (!graph.setLinkForCell) graph.setLinkForCell = function() {};
if (!graph.setAttributeForCell) graph.setAttributeForCell = function() {};
if (!graph.setTooltipForCell) graph.setTooltipForCell = function() {};

// Decompress tagIndex (additional keyword mappings)
if (w.Sidebar.prototype.tagIndex)
{
  sidebar.addTagIndex(w.Graph.decompress(w.Sidebar.prototype.tagIndex));
  console.log("tagIndex loaded — shapetags: " + Object.keys(sidebar.shapetags).length);
}

// ── Run initPalettes to trigger all shape registrations ──────────────────────

console.log("Running initPalettes...");

try
{
  sidebar.initPalettes();
}
catch (e)
{
  console.warn("initPalettes encountered an error (partial results may still be usable):", e.message);
}

console.log("initPalettes completed — captured " + capturedShapes.length + " shapes");

// ── Deduplicate by style string ──────────────────────────────────────────────

var seen = new Set();
var deduplicated = [];

for (var i = 0; i < capturedShapes.length; i++)
{
  var key = capturedShapes[i].style;

  if (!seen.has(key))
  {
    seen.add(key);
    deduplicated.push(capturedShapes[i]);
  }
}

console.log("After deduplication: " + deduplicated.length + " unique shapes");

// ── Write output ─────────────────────────────────────────────────────────────

var outPath = path.join(__dirname, "search-index.json");
fs.writeFileSync(outPath, JSON.stringify(deduplicated, null, 2));

var sizeMB = (fs.statSync(outPath).size / (1024 * 1024)).toFixed(2);
console.log("Written to " + outPath + " (" + sizeMB + " MB)");

// Summary stats
var vertices = deduplicated.filter(function(s) { return s.type === "vertex"; }).length;
var edges = deduplicated.filter(function(s) { return s.type === "edge"; }).length;
console.log("  Vertices: " + vertices + ", Edges: " + edges);

// Clean up
dom.window.close();
