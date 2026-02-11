# Draw.io Project Instructions (No MCP Required)

An alternative approach that works **without installing the MCP server**. Instead of using MCP tools, you add instructions to a Claude Project that teach Claude to generate draw.io URLs using Python code execution.

## Advantages

- **No installation required** - works immediately in Claude.ai
- **No desktop app needed** - works entirely in the browser
- **Easy to use** - just add instructions to your Claude Project
- **Privacy-friendly** - the generated URL uses a hash fragment (`#create=...`), which stays in the browser and is never sent to any server

## How to Install

1. Open your Claude Project settings
2. Add the contents of [`claude-project-instructions.txt`](claude-project-instructions.txt) to your project instructions
3. Ask Claude to create diagrams - it will generate clickable draw.io URLs

## How It Works

The instructions teach Claude to:
1. Generate diagram code (Mermaid, XML, or CSV)
2. Execute Python code to compress and encode the diagram
3. The script outputs a complete HTML page with the URL embedded as a clickable button
4. Claude presents the HTML as an artifact - the user clicks the button to open draw.io

## Why HTML Output?

The generated URL contains compressed base64 data. LLMs are known to silently corrupt base64 strings when reproducing them token by token - even a single changed character breaks the link completely.

By having the Python script output a complete HTML page with the link already embedded, the URL never passes through Claude's text generation. Claude simply presents the script output as an artifact, ensuring the link is always correct.
