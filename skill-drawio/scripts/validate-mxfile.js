#!/usr/bin/env node

/**
 * Validate a .drawio file against the local XSD schema.
 *
 * Loads references/mxfile.xsd at startup, extracts structural rules
 * (element hierarchy, attribute types), then validates the XML file
 * against those rules + semantic checks.
 *
 * Pure JS — no external dependencies.
 *
 * Usage:
 *   node validate-mxfile.js <file.drawio>
 *   node validate-mxfile.js - < input.drawio
 *
 * Exit codes: 0 = pass, 1 = fail
 */

var fs = require("fs");
var path = require("path");

var XSD_PATH = path.join(__dirname, "..", "references", "mxfile.xsd");

// ── XSD parser (minimal, draw.io subset) ──────────────────────────────────────

/**
 * Parse the XSD to extract validation rules.
 *
 * Returns:
 *   elemTypes:   { "mxfile": "mxfileType", ... }       element -> complex type
 *   typeChildren:{ "mxfileType": ["diagram"], ... }     type -> allowed child elements
 *   attrTypes:   { "mxCellType": [{name,type}, ...] }   type -> typed attributes
 *   simpleTypes: { "booleanInt": {enums:["0","1"]}, ... } type -> restrictions
 */
function parseXsd(xsdText)
{
  var elemTypes = {};
  var typeChildren = {};
  var attrTypes = {};
  var simpleTypes = {};

  // Element -> type: <xs:element name="X" type="Y">
  var m;
  var re = /<xs:element\s+name="([^"]+)"\s+type="([^"]+)"/g;
  while ((m = re.exec(xsdText)) !== null)
  {
    elemTypes[m[1]] = m[2];
  }

  // Complex types: child elements + typed attributes
  var ctParts = xsdText.split(/<xs:complexType\s+name="([^"]+)"/);
  for (var i = 1; i < ctParts.length; i += 2)
  {
    var tName = ctParts[i];
    var body = ctParts[i + 1];
    var end = body.indexOf("</xs:complexType>");
    if (end >= 0) body = body.substring(0, end);

    // Allowed child element names
    var children = [];
    var ce = /<xs:element\s+name="([^"]+)"/g;
    var cm;
    while ((cm = ce.exec(body)) !== null)
    {
      if (children.indexOf(cm[1]) < 0) children.push(cm[1]);
    }
    if (children.length > 0) typeChildren[tName] = children;

    // Attributes with their XSD types
    var attrs = [];
    var ae = /<xs:attribute\s+name="([^"]+)"[^>]*?type="([^"]+)"/g;
    var am;
    while ((am = ae.exec(body)) !== null)
    {
      attrs.push({ name: am[1], type: am[2] });
    }
    if (attrs.length > 0) attrTypes[tName] = attrs;
  }

  // Simple types: enumerations and patterns
  var stParts = xsdText.split(/<xs:simpleType\s+name="([^"]+)"/);
  for (var i = 1; i < stParts.length; i += 2)
  {
    var stName = stParts[i];
    var stBody = stParts[i + 1];
    var stEnd = stBody.indexOf("</xs:simpleType>");
    if (stEnd >= 0) stBody = stBody.substring(0, stEnd);

    var enums = [];
    var ee = /<xs:enumeration\s+value="([^"]+)"/g;
    var em;
    while ((em = ee.exec(stBody)) !== null) enums.push(em[1]);

    var patterns = [];
    var pe = /<xs:pattern\s+value="([^"]+)"/g;
    var pm;
    while ((pm = pe.exec(stBody)) !== null) patterns.push(pm[1]);

    simpleTypes[stName] = { enums: enums, patterns: patterns };
  }

  return {
    elemTypes: elemTypes,
    typeChildren: typeChildren,
    attrTypes: attrTypes,
    simpleTypes: simpleTypes
  };
}

// ── Validation ────────────────────────────────────────────────────────────────

function validateDiagramXml(xml, xsdRules)
{
  var errors = [];
  var warnings = [];

  // Strip comments — valid in draw.io, skip for analysis
  var clean = xml.replace(/<!--[\s\S]*?-->/g, "");

  // 1. Hierarchy: required elements (from XSD structure)
  var hierarchy = ["mxfile", "diagram", "mxGraphModel", "root"];
  for (var i = 0; i < hierarchy.length; i++)
  {
    if (clean.indexOf("<" + hierarchy[i]) < 0)
    {
      errors.push('[FAIL] Missing required element <' + hierarchy[i] + "> (XSD)");
    }
  }

  // 2. Collect all IDs, detect duplicates
  var allIds = {};
  var duplicateIds = [];
  var idRegex = /\bid="([^"]*)"/g;
  var m;
  while ((m = idRegex.exec(clean)) !== null)
  {
    if (allIds[m[1]]) duplicateIds.push(m[1]);
    else allIds[m[1]] = true;
  }
  if (duplicateIds.length > 0)
  {
    errors.push("[FAIL] Duplicate IDs: " + duplicateIds.join(", "));
  }

  // 3. Structural cells (XSD rootType documentation)
  if (!allIds["0"])
  {
    errors.push('[FAIL] Missing root cell id="0" (XSD: rootType)');
  }
  if (!allIds["1"])
  {
    errors.push('[FAIL] Missing default layer id="1" (XSD: rootType)');
  }

  // 4. Build enum-attr lookup from XSD for mxCell
  var enumAttrs = {};
  if (xsdRules)
  {
    var cellTypeName = xsdRules.elemTypes["mxCell"] || "mxCellType";
    var cellAttrDefs = xsdRules.attrTypes[cellTypeName] || [];
    for (var i = 0; i < cellAttrDefs.length; i++)
    {
      var st = xsdRules.simpleTypes[cellAttrDefs[i].type];
      if (st && st.enums.length > 0)
      {
        enumAttrs[cellAttrDefs[i].name] = st.enums;
      }
    }
  }

  // 5. Parse mxCell elements
  var cellBlocks = clean.split(/<mxCell\s/);
  for (var i = 1; i < cellBlocks.length; i++)
  {
    var block = cellBlocks[i];
    var tagEnd = block.indexOf(">");
    if (tagEnd < 0) continue;

    var tagContent = block.substring(0, tagEnd);
    var isSelfClosing = tagContent.charAt(tagContent.length - 1) === "/";

    var attrs = {};
    var ar = /(\w+)="([^"]*)"/g;
    var am;
    while ((am = ar.exec(tagContent)) !== null) attrs[am[1]] = am[2];

    var isEdge = attrs.edge === "1";

    // Edge must have mxGeometry child
    if (isEdge && isSelfClosing)
    {
      errors.push(
        '[FAIL] Edge id="' + (attrs.id || "?")
        + '" is self-closing — must contain <mxGeometry relative="1" as="geometry"/>'
      );
    }
    if (isEdge && !isSelfClosing)
    {
      var ci = block.indexOf("</mxCell>");
      if (ci > tagEnd)
      {
        var body = block.substring(tagEnd + 1, ci);
        if (body.indexOf("mxGeometry") < 0)
        {
          errors.push(
            '[FAIL] Edge id="' + (attrs.id || "?")
            + '" has no <mxGeometry> child'
          );
        }
      }
    }

    // Reference integrity
    if (attrs.source && !allIds[attrs.source])
    {
      warnings.push(
        '[WARN] Edge id="' + (attrs.id || "?")
        + '" source="' + attrs.source + '" not found'
      );
    }
    if (attrs.target && !allIds[attrs.target])
    {
      warnings.push(
        '[WARN] Edge id="' + (attrs.id || "?")
        + '" target="' + attrs.target + '" not found'
      );
    }
    if (attrs.parent && attrs.parent !== "0" && !allIds[attrs.parent])
    {
      warnings.push(
        '[WARN] Cell id="' + (attrs.id || "?")
        + '" parent="' + attrs.parent + '" not found'
      );
    }
    if ((attrs.source || attrs.target) && !isEdge)
    {
      warnings.push(
        '[WARN] Cell id="' + (attrs.id || "?")
        + '" has source/target but missing edge="1"'
      );
    }

    // XSD enum-based attribute validation
    var attrNames = Object.keys(attrs);
    for (var j = 0; j < attrNames.length; j++)
    {
      var name = attrNames[j];
      if (enumAttrs[name] && enumAttrs[name].indexOf(attrs[name]) < 0)
      {
        warnings.push(
          '[WARN] Cell id="' + (attrs.id || "?")
          + '" @' + name + '="' + attrs[name]
          + '" — XSD allows: ' + enumAttrs[name].join("|")
        );
      }
    }
  }

  return { errors: errors, warnings: warnings };
}

// ── CLI ───────────────────────────────────────────────────────────────────────

function cli()
{
  var args = process.argv.slice(2);

  if (args.length === 0 || args[0] === "--help" || args[0] === "-h")
  {
    console.error("Usage: node validate-mxfile.js <file.drawio>");
    console.error("       node validate-mxfile.js -  (read from stdin)");
    console.error("");
    console.error("Validates .drawio XML against " + XSD_PATH);
    process.exit(1);
  }

  // Load XSD
  var xsdRules = null;
  if (fs.existsSync(XSD_PATH))
  {
    xsdRules = parseXsd(fs.readFileSync(XSD_PATH, "utf-8"));
  }
  else
  {
    console.error("[WARN] XSD not found: " + XSD_PATH);
  }

  // Read input
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

  // Validate
  var result = validateDiagramXml(xml, xsdRules);

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
    console.log("\n[FAIL] " + result.errors.length + " error(s)");
    process.exit(1);
  }
  else if (result.warnings.length > 0)
  {
    console.log("\n[PASS] with " + result.warnings.length + " warning(s)");
  }
  else
  {
    console.log("[PASS] Validation passed");
  }
}

module.exports = { validateDiagramXml: validateDiagramXml, parseXsd: parseXsd };

if (require.main === module)
{
  cli();
}
