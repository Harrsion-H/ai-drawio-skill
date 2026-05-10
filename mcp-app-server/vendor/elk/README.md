# ELK Layout Vendor

Two artifacts are vendored here:

- `drawio-elk.min.js` — IIFE bundle. Defines `var ELK` (visible as `globalThis.ELK`) consumed by `drawio-mermaid.min.js` and `mxElkLayout.js`.
- `mxElkLayout.js` — mxGraph wrapper around ELK (`buildElkGraph`, `applyElkLayout`, `executeAsync`).

Vendored to keep this repo self-contained — see issue #29.

## Versioning

`drawio-elk.min.js`'s first line is a banner of the form:

```
/*! @drawio/elk <semver>+commit.<sha> (built <yyyy-mm-dd>) */
```

To inspect the version of the vendored copy:

```sh
head -1 drawio-elk.min.js
```

`mxElkLayout.js` has no banner — it's a thin mxGraph adapter.

## Refreshing

Both files are manually updated by the repo owner.
