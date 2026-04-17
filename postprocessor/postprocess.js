#!/usr/bin/env node
/**
 * CLI: Post-process a single draw.io XML file.
 * Usage: node postprocess.js <input.drawio> [output.drawio]
 *
 * Normalizes XML via xmldom (repairs malformed AI-generated markup so
 * mxCodec can decode it on the client). Edge routing and layout are
 * handled client-side in the viewer.
 */
var fs = require("fs");
var path = require("path");
var { DOMParser, XMLSerializer } = require("@xmldom/xmldom");

async function postprocess(xmlString)
{
	try { console.log("[postprocess] start, length=" + (xmlString && xmlString.length)); } catch (e) {}

	var normalizedXml;
	try
	{
		var doc = new DOMParser().parseFromString(xmlString, "text/xml");
		normalizedXml = new XMLSerializer().serializeToString(doc);
		try { console.log("[postprocess] xmldom normalized, length=" + normalizedXml.length); } catch (e) {}
	}
	catch (e)
	{
		try { console.log("[postprocess] xmldom normalize FAILED: " + (e && e.message)); } catch (_) {}
		normalizedXml = xmlString;
	}

	return { xml: normalizedXml };
}

async function main()
{
	var args = process.argv.slice(2);

	if (args.length === 0)
	{
		console.error("Usage: node postprocess.js <input.drawio> [output.drawio]");
		process.exit(1);
	}

	var inputPath = path.resolve(args[0]);
	var outputPath = args[1] ? path.resolve(args[1]) : null;

	var xmlString = fs.readFileSync(inputPath, "utf-8");
	var result = await postprocess(xmlString);

	if (outputPath)
	{
		fs.writeFileSync(outputPath, result.xml, "utf-8");
		console.log("\nOutput written to: " + outputPath);
	}
	else
	{
		process.stdout.write(result.xml);
	}
}

module.exports = { postprocess: postprocess };

if (require.main === module)
{
	main().catch(function(e)
	{
		console.error(e);
		process.exit(1);
	});
}
