#!/usr/bin/env node

/**
 * Validate a .drawio file against structural rules.
 *
 * Replicates the validateDiagramXml() logic from mcp-app-server/src/shared.js.
 * Pure regex-based — no external dependencies, no Python needed.
 *
 * Usage:
 *   node validate-mxfile.js <file.drawio>
 *   node validate-mxfile.js - < input.drawio
 *   cat diagram.drawio | node validate-mxfile.js -
 *
 * Exit codes: 0 = pass, 1 = fail
 */

var fs = require("fs");
var path = require("path");

// ── Validation logic ─────────────────────────────────────────────────────────

function validateDiagramXml(xml)
{
  var errors = [];
  var warnings = [];

  // 1. XML comments
  if (xml.indexOf("<!--") >= 0)
  {
    errors.push("[FAIL] XML comments (<!-- -->) are forbidden — remove all comments");
  }

  // 2. Collect all IDs
  var allIds = {};
  var duplicateIds = [];
  var idRegex = /\bid="([^"]*)"/g;
  var idMatch;

  while ((idMatch = idRegex.exec(xml)) !== null)
  {
    var id = idMatch[1];

    if (allIds[id])
    {
      duplicateIds.push(id);
    }
    else
    {
      allIds[id] = true;
    }
  }

  if (duplicateIds.length > 0)
  {
    errors.push("[FAIL] Duplicate IDs: " + duplicateIds.join(", "));
  }

  // 3. Structural cells
  if (!allIds["0"])
  {
    errors.push('[FAIL] Missing root cell with id="0"');
  }

  if (!allIds["1"])
  {
    errors.push('[FAIL] Missing default layer cell with id="1" parent="0"');
  }

  // 4-9. Parse mxCell elements
  var cellBlocks = xml.split(/<mxCell\s/);

  for (var i = 1; i < cellBlocks.length; i++)
  {
    var block = cellBlocks[i];
    var tagEnd = block.indexOf(">");

    if (tagEnd < 0)
    {
      continue;
    }

    var tagContent = block.substring(0, tagEnd);
    var isSelfClosing = tagContent.charAt(tagContent.length - 1) === "/";

    var attrs = {};
    var attrRegex = /(\w+)="([^"]*)"/g;
    var m;

    while ((m = attrRegex.exec(tagContent)) !== null)
    {
      attrs[m[1]] = m[2];
    }

    var isEdge = attrs.edge === "1";

    // 5. Self-closing edge (missing mxGeometry)
    if (isEdge && isSelfClosing)
    {
      errors.push(
        '[FAIL] Edge id="' + (attrs.id || "?")
        + '" is self-closing — every edge must contain '
        + '<mxGeometry relative="1" as="geometry"/>'
      );
    }

    // 6. Edge without mxGeometry child
    if (isEdge && !isSelfClosing)
    {
      var closingIdx = block.indexOf("</mxCell>");

      if (closingIdx > tagEnd)
      {
        var body = block.substring(tagEnd + 1, closingIdx);

        if (body.indexOf("mxGeometry") < 0)
        {
          errors.push(
            '[FAIL] Edge id="' + (attrs.id || "?")
            + '" has no <mxGeometry> child'
          );
        }
      }
    }

    // 7. Dangling source
    if (attrs.source && !allIds[attrs.source])
    {
      warnings.push(
        '[WARN] Edge id="' + (attrs.id || "?")
        + '" references source="' + attrs.source + '" which does not exist'
      );
    }

    // 8. Dangling target
    if (attrs.target && !allIds[attrs.target])
    {
      warnings.push(
        '[WARN] Edge id="' + (attrs.id || "?")
        + '" references target="' + attrs.target + '" which does not exist'
      );
    }

    // 9. Dangling parent
    if (attrs.parent && attrs.parent !== "0" && !allIds[attrs.parent])
    {
      warnings.push(
        '[WARN] Cell id="' + (attrs.id || "?")
        + '" references parent="' + attrs.parent + '" which does not exist'
      );
    }

    // 10. source/target without edge="1"
    if ((attrs.source || attrs.target) && !isEdge)
    {
      warnings.push(
        '[WARN] Cell id="' + (attrs.id || "?")
        + '" has source/target but missing edge="1"'
      );
    }
  }

  return { errors: errors, warnings: warnings };
}

// ── CLI entry point ──────────────────────────────────────────────────────────

function cli()
{
  var args = process.argv.slice(2);

  if (args.length === 0 || args[0] === "--help" || args[0] === "-h")
  {
    console.error("Usage: node validate-mxfile.js <file.drawio>");
    console.error("       node validate-mxfile.js -  (read from stdin)");
    console.error("");
    console.error("Validates .drawio XML for structural correctness.");
    console.error("Checks: comments, duplicate IDs, root cells, edge geometry, references.");
    process.exit(1);
  }

  var source = args[0];
  var xml;

  if (source === "-")
  {
    xml = fs.readFileSync(0, "utf-8");
  }
  else
  {
    var resolved = path.resolve(source);

    if (!fs.existsSync(resolved))
    {
      console.error("[FAIL] File not found: " + resolved);
      process.exit(1);
    }

    xml = fs.readFileSync(resolved, "utf-8");
  }

  var result = validateDiagramXml(xml);

  for (var i = 0; i < result.warnings.length; i++)
  {
    console.log(result.warnings[i]);
  }

  for (var i = 0; i < result.errors.length; i++)
  {
    console.log(result.errors[i]);
  }

  if (result.errors.length > 0)
  {
    console.log("\n[FAIL] Validation failed with " + result.errors.length + " error(s)");
    process.exit(1);
  }
  else if (result.warnings.length > 0)
  {
    console.log("\n[PASS] Validation passed with " + result.warnings.length + " warning(s)");
  }
  else
  {
    console.log("[PASS] Validation passed");
  }
}

module.exports = { validateDiagramXml: validateDiagramXml };

if (require.main === module)
{
  cli();
}
