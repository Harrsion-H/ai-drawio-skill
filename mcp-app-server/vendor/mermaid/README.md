# Mermaid Vendor

Pre-built drawio-mermaid bundle, vendored to keep this repo self-contained
(see issue #29).

- `drawio-mermaid.min.js` — IIFE bundle. Exposes `mxMermaidToDrawio.parseText(text, config)` for converting Mermaid text into draw.io cells. Reads `globalThis.ELK` — load `vendor/elk/drawio-elk.min.js` first.

## Versioning

The bundle's first line is a banner of the form:

```
/*! @drawio/mermaid <semver>+commit.<sha> (built <yyyy-mm-dd>) */
```

To inspect the version of the vendored copy:

```sh
head -1 drawio-mermaid.min.js
```

## Refreshing

The bundle is manually updated by the repo owner.
