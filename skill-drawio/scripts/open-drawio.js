#!/usr/bin/env node

/**
 * Open draw.io CLI
 *
 * Opens the draw.io editor in the browser with diagram content.
 * Supports XML, Mermaid, and CSV formats.
 *
 * Usage:
 *   node open-drawio.js --xml <file> [--dark] [--lightbox]
 *   node open-drawio.js --mermaid <file>
 *   node open-drawio.js --csv <file>
 *   echo "flowchart TD\n  A-->B" | node open-drawio.js --mermaid -
 */

var fs = require("fs");
var path = require("path");
var { spawn } = require("child_process");
var { tmpdir } = require("os");

// pako is optional; fallback to zlib for standalone use
var pako;
try
{
  pako = require("pako");
}
catch (e)
{
  pako = null;
}
var zlib = !pako ? require("zlib") : null;

var DRAWIO_BASE_URL = "https://app.diagrams.net/";

function compressData(data)
{
  if (!data || data.length === 0)
  {
    return data;
  }

  var encoded = encodeURIComponent(data);

  if (pako)
  {
    var compressed = pako.deflateRaw(encoded);
    return Buffer.from(compressed).toString("base64");
  }

  return Buffer.from(zlib.deflateRawSync(Buffer.from(encoded))).toString("base64");
}

function generateDrawioUrl(data, type, options)
{
  options = options || {};
  var lightbox = options.lightbox || false;
  var dark = options.dark || false;

  var compressedData = compressData(data);

  var createObj = {
    type: type,
    compressed: true,
    data: compressedData
  };

  var params = new URLSearchParams();

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

  if (dark)
  {
    params.set("dark", "1");
  }

  params.set("border", "10");
  params.set("edit", "_blank");

  var createHash = "#create=" + encodeURIComponent(JSON.stringify(createObj));
  var paramsStr = params.toString();

  return DRAWIO_BASE_URL + (paramsStr ? "?" + paramsStr : "") + createHash;
}

function openBrowser(url)
{
  var child;

  if (process.platform === "win32")
  {
    var tmpFile = path.join(tmpdir(), "drawio-cli-" + Date.now() + ".url");
    fs.writeFileSync(tmpFile, "[InternetShortcut]\r\nURL=" + url + "\r\n");
    child = spawn("cmd", ["/c", "start", "", tmpFile], { shell: false, stdio: "ignore" });

    setTimeout(function()
    {
      try { fs.unlinkSync(tmpFile); } catch (e) { /* ignore */ }
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
    console.error("Failed to open browser: " + error.message);
    console.error("Open this URL manually: " + url);
  });

  child.unref();
}

/**
 * CLI wrapper — can be called directly or from other scripts.
 */
function cli(argv)
{
  var args = argv || process.argv.slice(2);

  if (args.length === 0 || args[0] === "--help" || args[0] === "-h")
  {
    console.error("Usage: node open-drawio.js [options] <file>");
    console.error("");
    console.error("Options:");
    console.error("  --xml <file>       Open as draw.io XML");
    console.error("  --mermaid <file>   Open as Mermaid diagram");
    console.error("  --csv <file>       Open as CSV data");
    console.error("  --dark             Dark mode");
    console.error("  --lightbox         Read-only lightbox mode");
    console.error("  --url              Print URL only, don't open browser");
    console.error("  -                  Read from stdin");
    return;
  }

  var type = null;
  var filePath = null;
  var dark = false;
  var lightbox = false;
  var urlOnly = false;

  for (var i = 0; i < args.length; i++)
  {
    if (args[i] === "--xml" && i + 1 < args.length)
    {
      type = "xml";
      filePath = args[++i];
    }
    else if (args[i] === "--mermaid" && i + 1 < args.length)
    {
      type = "mermaid";
      filePath = args[++i];
    }
    else if (args[i] === "--csv" && i + 1 < args.length)
    {
      type = "csv";
      filePath = args[++i];
    }
    else if (args[i] === "--dark")
    {
      dark = true;
    }
    else if (args[i] === "--lightbox")
    {
      lightbox = true;
    }
    else if (args[i] === "--url")
    {
      urlOnly = true;
    }
  }

  if (!type)
  {
    console.error("Error: specify a format: --xml, --mermaid, or --csv");
    process.exit(1);
  }

  var content;

  if (filePath === "-")
  {
    content = fs.readFileSync(0, "utf-8");
  }
  else if (filePath)
  {
    var resolved = path.resolve(filePath);

    if (!fs.existsSync(resolved))
    {
      console.error("Error: file not found: " + resolved);
      process.exit(1);
    }

    content = fs.readFileSync(resolved, "utf-8");
  }
  else
  {
    console.error("Error: no input file specified");
    process.exit(1);
  }

  var url = generateDrawioUrl(content, type, { dark: dark, lightbox: lightbox });

  if (urlOnly)
  {
    console.log(url);
  }
  else
  {
    openBrowser(url);
    console.log("Opened draw.io in browser.");
    console.log("URL: " + url);
  }
}

module.exports = { cli: cli, generateDrawioUrl: generateDrawioUrl, compressData: compressData };

// Run directly if executed as script
if (require.main === module)
{
  cli();
}
