#!/usr/bin/env node

/**
 * Shape Search CLI
 *
 * Searches the draw.io shape index (search-index.json) from the command line.
 * Replicates the search_shapes MCP tool logic for use without an MCP server.
 *
 * Usage:
 *   node search-shapes.js <query> [limit]
 *   node search-shapes.js "aws lambda" 10
 *   node search-shapes.js cisco firewall
 *
 * Output: JSON array of {style, w, h, title}
 */

var fs = require("fs");
var path = require("path");

// ── Search logic (from mcp-app-server/src/shared.js) ────────────────────────

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

function splitCompoundToken(token)
{
  var parts = token.replace(/([a-z])([A-Z])/g, "$1 $2")
                   .replace(/([a-zA-Z])(\d)/g, "$1 $2")
                   .replace(/(\d)([a-zA-Z])/g, "$1 $2")
                   .toLowerCase()
                   .split(/\s+/);

  return parts.filter(function(p) { return p.length >= 2; });
}

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

function searchShapes(shapeIndex, tagMap, query, limit)
{
  if (!query || !shapeIndex || shapeIndex.length === 0)
  {
    return [];
  }

  var rawTerms = query.toLowerCase().split(/\s+/).filter(function(t) { return t.length > 0; });
  var terms = [];
  var seen = {};

  for (var i = 0; i < rawTerms.length; i++)
  {
    var subTokens = splitCompoundToken(rawTerms[i]);

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

  var termMatches = [];

  for (var i = 0; i < terms.length; i++)
  {
    termMatches.push(matchTerm(tagMap, terms[i]));
  }

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

  var scores = {};

  if (andSet && andSet.size > 0)
  {
    andSet.forEach(function(idx)
    {
      scores[idx] = 0;
    });

    for (var i = 0; i < termMatches.length; i++)
    {
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

// ── CLI entry point ─────────────────────────────────────────────────────────

/**
 * CLI wrapper — can be called directly or from other scripts.
 */
function cli(argv)
{
  var args = argv || process.argv.slice(2);

  if (args.length === 0 || args[0] === "--help" || args[0] === "-h")
  {
    console.error("Usage: node search-shapes.js <query> [limit]");
    console.error("");
    console.error("Search the draw.io shape library by keywords.");
    console.error("Returns matching shapes with style strings, dimensions, and titles.");
    console.error("");
    console.error("Examples:");
    console.error("  node search-shapes.js \"aws lambda\" 10");
    console.error("  node search-shapes.js cisco firewall");
    console.error("  node search-shapes.js pid valve 5");
    process.exit(1);
  }

  var query = args[0];
  var limit = parseInt(args[1], 10) || 10;

  if (limit < 1)
  {
    limit = 10;
  }

  if (limit > 50)
  {
    limit = 50;
  }

  // Locate search-index.json: try multiple paths
  var scriptDir = __dirname;
  var homeDir = process.env.HOME || process.env.USERPROFILE || "";
  var candidates = [
    // Same directory as script
    path.join(scriptDir, "search-index.json"),
    // Skill global install
    path.join(homeDir, ".claude", "skills", "drawio", "scripts", "search-index.json"),
    // Skill local install
    path.join(".claude", "skills", "drawio", "scripts", "search-index.json"),
    // Repo structure
    path.join(scriptDir, "..", "..", "shape-search", "search-index.json")
  ];

  var indexPath = null;

  for (var i = 0; i < candidates.length; i++)
  {
    if (fs.existsSync(candidates[i]))
    {
      indexPath = candidates[i];
      break;
    }
  }

  if (!indexPath)
  {
    console.error("Error: search-index.json not found.");
    console.error("Searched: " + candidates.join(", "));
    process.exit(1);
  }

  var shapeIndex = JSON.parse(fs.readFileSync(indexPath, "utf-8"));
  var tagMap = buildTagMap(shapeIndex);
  var results = searchShapes(shapeIndex, tagMap, query, limit);

  console.log(JSON.stringify(results, null, 2));
}

module.exports = { cli: cli, searchShapes: searchShapes, buildTagMap: buildTagMap };

// Run directly if executed as script
if (require.main === module)
{
  cli();
}
