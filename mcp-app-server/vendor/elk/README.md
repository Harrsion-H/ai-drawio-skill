# ELK Layout Vendor

Only the mxGraph wrapper is vendored here:

- `mxElkLayout.js` — mxGraph wrapper around ELK (`buildElkGraph`, `applyElkLayout`, `executeAsync`). Vendored from `jgraph/drawio-dev` origin/elk-layout branch.

The ELK engine itself (`elk.bundled.js`, ~1.6 MB) is no longer vendored — it's published as `globalThis.ELK` by `drawio-mermaid/dist/mermaid.bundled.js`, which the app server already inlines. See [`../../src/build-html.js`](../../src/build-html.js).

## Refreshing mxElkLayout.js

Until the `elk-layout` branch merges to drawio-dev's `dev`/`main`, refresh manually from a sibling `drawio-dev` checkout:

```sh
git -C ../../../drawio-dev show origin/elk-layout:src/main/webapp/js/elk/mxElkLayout.js > mxElkLayout.js
```

Once `elk-layout` lands on `dev`, switch to reading directly from the sibling repo in `build-html.js` and delete this vendor directory.
