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

## Coding Conventions

- **Allman brace style**: Opening braces go on their own line for all control structures, functions, objects, and callbacks.
- Prefer `function()` expressions over arrow functions for callbacks.
- See the root `CLAUDE.md` for examples.

## Why HTML Output?

The generated URL contains compressed base64 data. LLMs silently corrupt base64 strings when reproducing them token by token. By having the Python script output a complete HTML page with the link embedded, the URL never passes through Claude's text generation — ensuring the link is always correct.
