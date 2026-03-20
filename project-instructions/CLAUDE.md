# Project Instructions

Alternative approach that works without installing the MCP server. Users add instructions to a Claude Project that teach Claude to generate draw.io URLs using Python code execution.

## Key Files

| File | Purpose |
|------|---------|
| `claude-project-instructions.txt` | Instructions to paste into Claude Project settings |

## How It Works

1. Claude generates diagram code (Mermaid, XML, or CSV)
2. Executes Python code to compress and encode the diagram
3. The script outputs a complete HTML page with the URL embedded as a clickable button
4. Claude presents the HTML as an artifact — the user clicks the button to open draw.io

## Dark Mode Colors

draw.io supports automatic dark mode rendering. How colors behave depends on the property:

- **`strokeColor`, `fillColor`, `fontColor`** default to `"default"`, which renders as black in light theme and white in dark theme. When no explicit color is set, colors adapt automatically.
- **Explicit colors** (e.g. `fillColor=#DAE8FC`) specify the light-mode color. The dark-mode color is computed automatically by inverting the RGB values (blending toward the inverse at 93%) and rotating the hue by 180° (via `mxUtils.getInverseColor`).
- **`light-dark()` function** — To specify both colors explicitly, use `light-dark(lightColor,darkColor)` in the style string, e.g. `fontColor=light-dark(#7EA6E0,#FF0000)`. The first argument is used in light mode, the second in dark mode.

To enable dark mode color adaptation, the `mxGraphModel` element must include `adaptiveColors="auto"`.

When generating diagrams, you generally do not need to specify dark-mode colors — the automatic inversion handles most cases. Use `light-dark()` only when the automatic inverse color is unsatisfactory.

## Coding Conventions

- **Allman brace style**: Opening braces go on their own line for all control structures, functions, objects, and callbacks.
- Prefer `function()` expressions over arrow functions for callbacks.
- See the root `CLAUDE.md` for examples.

## Why HTML Output?

The generated URL contains compressed base64 data. LLMs silently corrupt base64 strings when reproducing them token by token. By having the Python script output a complete HTML page with the link embedded, the URL never passes through Claude's text generation — ensuring the link is always correct.
