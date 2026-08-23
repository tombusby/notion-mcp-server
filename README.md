# Notion MCP Server

> [!NOTE]
>
> We’ve introduced **Notion MCP**, a remote MCP server with the following improvements:
>
> - Easy installation via standard OAuth. No need to fiddle with JSON or API tokens anymore.
> - Powerful tools tailored to AI agents, including editing pages in Markdown. These tools are designed with optimized token consumption in mind.
>
> Learn more and get started at [Notion MCP documentation](https://developers.notion.com/docs/mcp).
>
> We are prioritizing, and only providing active support for, **Notion MCP** (remote). As a result:
>
> - We may sunset this local MCP server repository in the future.
> - Issues and pull requests here are not actively monitored.
> - Please do not file issues relating to the remote MCP here; instead, contact Notion support.

![notion-mcp-sm](https://github.com/user-attachments/assets/6c07003c-8455-4636-b298-d60ffdf46cd8)

This project implements an [MCP server](https://spec.modelcontextprotocol.io/) for the [Notion API](https://developers.notion.com/reference/intro).

![mcp-demo](https://github.com/user-attachments/assets/e3ff90a7-7801-48a9-b807-f7dd47f0d3d6)

---

## ⚠️ Version 2.0.0 breaking changes

**Version 2.0.0 migrates to the Notion API 2025-09-03** which introduces data sources as the primary abstraction for databases.

### What changed

**Removed tools (3):**

- `post-database-query` - replaced by `query-data-source`
- `update-a-database` - replaced by `update-a-data-source`
- `create-a-database` - replaced by `create-a-data-source`

**New tools (7):**

- `query-data-source` - Query a data source (database) with filters and sorts
- `retrieve-a-data-source` - Get metadata and schema for a data source
- `update-a-data-source` - Update data source properties
- `create-a-data-source` - Create a new data source
- `list-data-source-templates` - List available templates in a data source
- `move-page` - Move a page to a different parent location
- `retrieve-a-database` - Get database metadata including its data source IDs

**Parameter changes:**

- All database operations now use `data_source_id` instead of `database_id`
- Search filter values changed from `["page", "database"]` to `["page", "data_source"]`
- Page creation now supports both `page_id` and `database_id` parents (for data sources)

### Do I need to migrate?

**No code changes required.** MCP tools are discovered automatically when the server starts. When you upgrade to v2.0.0, AI clients will automatically see the new tool names and parameters. The old database tools are no longer available.

If you have hardcoded tool names or prompts that reference the old database tools, update them to use the new data source tools:

| Old Tool (v1.x) | New Tool (v2.0) | Parameter Change |
| -------------- | --------------- | ---------------- |
| `post-database-query` | `query-data-source` | `database_id` → `data_source_id` |
| `update-a-database` | `update-a-data-source` | `database_id` → `data_source_id` |
| `create-a-database` | `create-a-data-source` | No change (uses `parent.page_id`) |

> **Note:** `retrieve-a-database` is still available and returns database metadata including the list of data source IDs. Use `retrieve-a-data-source` to get the schema and properties of a specific data source.

**Total tools now: 22** (was 19 in v1.x)

---

## Page content as Markdown

The server exposes two tools for working with page content as enhanced Markdown instead of block JSON, which is significantly more token-efficient for AI agents:

- `retrieve-page-markdown` — Read a page's full content as Markdown (`GET /v1/pages/{page_id}/markdown`). Pass `include_transcript: true` to inline meeting-note transcripts, `format: "outline"` for [headings only](#keeping-responses-small), or `max_blocks` to cap the read.
- `update-page-markdown` — Edit a page's content with Markdown (`PATCH /v1/pages/{page_id}/markdown`). Use `replace_content` to overwrite the whole page, or `update_content` for find-and-replace edits. For targeted edits to a large page, prefer [editing by block ID](#editing-by-block-id).

### Keeping responses small

Notion's markdown endpoints return the **whole page** on every call, including on writes. Three small edits to a 15,000-word page therefore return roughly 45,000 words to change three paragraphs the caller already had in hand.

That is a correctness problem rather than an efficiency one. Large responses evict earlier reads from an agent's context; an evicted read means it no longer holds the page state it was working from; and an edit written from a half-remembered page is a stale write. On the markdown path there is no content hash to catch one.

The server trims both directions:

**Writes return a receipt.** `update-page-markdown` returns the regions it changed rather than the document:

```json
{ "object": "page_markdown_update", "id": "…", "edits": 1, "verified": 1, "unverified": 0,
  "changed": [{ "index": 0, "verified": true, "markdown": "the new text of this block only" }],
  "markdown_omitted": true }
```

Echoing the changed region is what lets you confirm the write landed as intended — including spotting escaping corruption — without re-reading. `verified: false` means the replacement text was not found verbatim afterwards: the edit may still have been applied with different escaping, so read the block by ID to be sure. Control it with `return_content`: `changed` (default for `update_content`), `none` (default for `replace_content`), or `full` for the old behaviour.

**`format: "outline"` makes locating a section cheap.** It returns headings only — each with its block ID, content hash and section size — and does not read the page body at all:

```json
{ "object": "page_outline", "id": "…", "truncated": false,
  "outline": [{ "block_id": "…", "type": "heading_2", "level": 2, "text": "What landed",
                "content_hash": "84fe9704dba18505", "section_blocks": 22, "has_children": false }] }
```

This is the entry point the block-ID path was missing. Editing safely needs a block ID, getting a block ID used to need a full-page read, and so the expensive read pushed callers back onto the unsafe markdown path. The workflow is now **outline → section read → block edit**: take a `block_id` from the outline, pass it back to `retrieve-page-markdown` as `page_id` with `format: "section"`, then edit with `update-a-block` using the `content_hash`.

`format: "section"` is required for that middle step, and the reason is worth knowing. A Notion heading is a **sibling** of the content beneath it, not its parent, so a plain read of a heading's block ID returns the heading line and nothing else — the outline's `section_blocks` counts following siblings, which no read of the heading itself can return. `section` resolves that range and returns it. Doing so costs a full read of the parent page behind the scenes, deliberately: the resource being conserved is the agent's context, not Notion's bandwidth, and returning 27 blocks instead of 239 is the whole point. If a heading cannot be located unambiguously — repeated verbatim elsewhere on the page — the read falls back to ordinary behaviour rather than returning the wrong section. A plain read that comes back as a lone heading carries a `section_hint` saying all this.

The outline walks the block tree and descends into collapsed containers, bounded by a request budget; if it stops early it sets `truncated` and says so rather than implying the page has no further headings.

Two things this deliberately does not do. It does not annotate rendered Markdown with block-ID comments: Notion returns Markdown as an opaque string with no block correspondence, so aligning IDs against serialised text would reintroduce exactly the fragility block addressing exists to remove — the outline reaches the same destination without that risk. And it does not repair Markdown escaping of literal `*` and `~`, which is produced by Notion's own serialiser: the stored blocks are correct, as `get-block-children` shows, so it is not fixable from this side. (A more serious form of this — nested bold/italic being mangled into `**Author, \*Title**\*` — was reported against an earlier version and no longer reproduces.)

These endpoints require Notion API version `2026-03-11`. The server now sources the `Notion-Version` header **per operation** from the OpenAPI spec, so these tools use `2026-03-11` while the rest of the API continues to use `2025-09-03` — no configuration needed. If you set `Notion-Version` yourself via `OPENAPI_MCP_HEADERS`, your value takes precedence for every tool.

### Editing by block ID

Markdown find-and-replace is convenient, but it anchors edits to *content*: `old_str` has to reproduce the existing text exactly. That gets fragile on large pages, and it has three limits worth knowing:

- **An `old_str` cannot span blocks.** Text either side of a blank line lives in different blocks, and the API matches within a single block only — such an anchor never matches, however carefully it is reproduced.
- **Literal punctuation comes back escaped.** `~140` reads back as `\~140` and a lone `*` as `\*`, so an anchor copied out of `retrieve-page-markdown` may not match when fed back in. Formatting itself round-trips: nested bold/italic such as `**Author**, *Title*` is returned byte-identical, as is `*italic*` adjacent to `**bold**` (retested against live content, Aug 2026). A literal `#` in prose is not escaped.
- **Table rows are stored one cell per line.** A row rewritten as a single line will not match.

For anything targeted — and for any bulk restructuring — address blocks by **ID** instead:

```
get-block-children(block_id)   → each child's `id`, `type`, `last_edited_time`
update-a-block(block_id)       → replace one block's content in place
delete-a-block(block_id)       → remove a block and its children
patch-block-children(block_id, after: <id>)  → insert at a position
retrieve-a-block(block_id)     → re-check `last_edited_time` before writing
```

Block IDs sidestep all three limits: deleting fifteen sections is fifteen `delete-a-block` calls that never touch the section text. `retrieve-page-markdown` also accepts a **block** ID, so a single section can be read without fetching the whole page.

`update-a-block` takes the block-type key at the **root** of the body, matching the block's existing type — a block cannot change type:

```json
{ "paragraph": { "rich_text": [{ "type": "text", "text": { "content": "New text" } }] } }
```

Two caveats on what you can *write*. `patch-block-children` only describes `paragraph` and `bulleted_list_item` in its schema, so adding a heading or callout is better done by writing Markdown through `update-page-markdown` ([#282](https://github.com/makenotion/notion-mcp-server/issues/282)). And `update-a-block` accepts any block type, but only `rich_text` and `to_do`'s `checked` are updatable — Notion's own constraint, not the spec's.

**Reordering is not supported.** Notion's API has no block-move operation — only `POST /v1/pages/{page_id}/move` for whole pages. Reordering content within a page means appending a copy with `patch-block-children` and deleting the original, which assigns new block IDs and does not carry comments over. Plan around it rather than expecting a move.

### Find-and-replace safety checks

`update_content` batches are applied server-side, in order, against a document each preceding edit has already changed. Nothing in the request says where an anchor is meant to land, so a batch whose anchors interact is accepted and returns cleanly while replacing the wrong content — silent loss, with a success response.

Before sending, the server rejects batches where:

- an `old_str` spans a newline outside a table, toggle or code fence (multi-block, can never match — Notion separates blocks with a single newline, not a blank line);
- a later `old_str` appears in an earlier edit's `new_str` (it would match text the earlier edit just wrote);
- two anchors overlap, or are identical without `replace_all_matches`;
- an `old_str` is empty, or identical to its `new_str`.

Rejection happens before the request is sent, so nothing is written and the batch is never partially applied. These checks compare the strings in the batch against each other, not against the page — two anchors that are unrelated as strings but land next to each other in the document cannot be detected this way. Use block IDs when an edit has to be exact.

---

### Installation

#### 1. Setting up integration in Notion

Go to [https://www.notion.so/profile/integrations](https://www.notion.so/profile/integrations) and create a new **internal** integration or select an existing one.

![Creating a Notion Integration token](docs/images/integrations-creation.png)

While we limit the scope of Notion API's exposed (for example, you will not be able to delete databases via MCP), there is a non-zero risk to workspace data by exposing it to LLMs. Security-conscious users may want to further configure the Integration's _Capabilities_.

For example, you can create a read-only integration token by giving only "Read content" access from the "Configuration" tab:

![Notion Integration Token Capabilities showing Read content checked](docs/images/integrations-capabilities.png)

#### 2. Connecting content to integration

Ensure relevant pages and databases are connected to your integration.

To do this, visit the **Access** tab in your internal integration settings. Edit access and select the pages you'd like to use.

![Integration Access tab](docs/images/integration-access.png)

![Edit integration access](docs/images/page-access-edit.png)

Alternatively, you can grant page access individually. You'll need to visit the target page, and click on the 3 dots, and select "Connect to integration".

![Adding Integration Token to Notion Connections](docs/images/connections.png)

#### 3. Adding MCP config to your client

##### Using npm

###### Cursor & Claude

Add the following to your `.cursor/mcp.json` or `claude_desktop_config.json` (MacOS: `~/Library/Application\ Support/Claude/claude_desktop_config.json`)

###### Option 1: Using NOTION_TOKEN (recommended)

```json
{
  "mcpServers": {
    "notionApi": {
      "command": "npx",
      "args": ["-y", "@notionhq/notion-mcp-server"],
      "env": {
        "NOTION_TOKEN": "ntn_****"
      }
    }
  }
}
```

###### Option 2: Using OPENAPI_MCP_HEADERS (for advanced use cases)

```json
{
  "mcpServers": {
    "notionApi": {
      "command": "npx",
      "args": ["-y", "@notionhq/notion-mcp-server"],
      "env": {
        "OPENAPI_MCP_HEADERS": "{\"Authorization\": \"Bearer ntn_****\", \"Notion-Version\": \"2025-09-03\" }"
      }
    }
  }
}
```

###### Zed

Add the following to your `settings.json`

```json
{
  "context_servers": {
    "some-context-server": {
      "command": {
        "path": "npx",
        "args": ["-y", "@notionhq/notion-mcp-server"],
        "env": {
          "OPENAPI_MCP_HEADERS": "{\"Authorization\": \"Bearer ntn_****\", \"Notion-Version\": \"2025-09-03\" }"
        }
      },
      "settings": {}
    }
  }
}
```

###### GitHub Copilot CLI

Use the Copilot CLI to interactively add the MCP server:

```bash
/mcp add
```

Alternatively, create or edit the configuration file `~/.copilot/mcp-config.json` and add:

```json
{
  "mcpServers": {
    "notionApi": {
      "command": "npx",
      "args": ["-y", "@notionhq/notion-mcp-server"],
      "env": {
        "NOTION_TOKEN": "ntn_****"
      }
    }
  }
}
```

For more information, see the [Copilot CLI documentation](https://docs.github.com/en/copilot/concepts/agents/about-copilot-cli).

##### Using Docker

There are two options for running the MCP server with Docker:

###### Option 1: Using the official Docker Hub image

Add the following to your `.cursor/mcp.json` or `claude_desktop_config.json`

Using NOTION_TOKEN (recommended):

```json
{
  "mcpServers": {
    "notionApi": {
      "command": "docker",
      "args": [
        "run",
        "--rm",
        "-i",
        "-e", "NOTION_TOKEN",
        "mcp/notion"
      ],
      "env": {
        "NOTION_TOKEN": "ntn_****"
      }
    }
  }
}
```

Using OPENAPI_MCP_HEADERS (for advanced use cases):

```json
{
  "mcpServers": {
    "notionApi": {
      "command": "docker",
      "args": [
        "run",
        "--rm",
        "-i",
        "-e", "OPENAPI_MCP_HEADERS",
        "mcp/notion"
      ],
      "env": {
        "OPENAPI_MCP_HEADERS": "{\"Authorization\":\"Bearer ntn_****\",\"Notion-Version\":\"2025-09-03\"}"
      }
    }
  }
}
```

This approach:

- Uses the official Docker Hub image
- Properly handles JSON escaping via environment variables
- Provides a more reliable configuration method

###### Option 2: Building the Docker image locally

You can also build and run the Docker image locally. First, build the Docker image:

```bash
docker compose build
```

Then, add the following to your `.cursor/mcp.json` or `claude_desktop_config.json`

Using NOTION_TOKEN (recommended):

```json
{
  "mcpServers": {
    "notionApi": {
      "command": "docker",
      "args": [
        "run",
        "--rm",
        "-i",
        "-e",
        "NOTION_TOKEN=ntn_****",
        "notion-mcp-server"
      ]
    }
  }
}
```

Using OPENAPI_MCP_HEADERS (for advanced use cases):

```json
{
  "mcpServers": {
    "notionApi": {
      "command": "docker",
      "args": [
        "run",
        "--rm",
        "-i",
        "-e",
        "OPENAPI_MCP_HEADERS={\"Authorization\": \"Bearer ntn_****\", \"Notion-Version\": \"2025-09-03\"}",
        "notion-mcp-server"
      ]
    }
  }
}
```

Don't forget to replace `ntn_****` with your integration secret. Find it from your integration configuration tab:

![Copying your Integration token from the Configuration tab in the developer portal](https://github.com/user-attachments/assets/67b44536-5333-49fa-809c-59581bf5370a)

### Transport options

The Notion MCP Server supports two transport modes:

#### STDIO transport (default)

The default transport mode uses standard input/output for communication. This is the standard MCP transport used by most clients like Claude Desktop.

```bash
# Run with default stdio transport
npx @notionhq/notion-mcp-server

# Or explicitly specify stdio
npx @notionhq/notion-mcp-server --transport stdio
```

#### Streamable HTTP transport

For web-based applications or clients that prefer HTTP communication, you can use the Streamable HTTP transport:

```bash
# Run with Streamable HTTP transport on port 3000 (default)
npx @notionhq/notion-mcp-server --transport http

# Run on a custom port
npx @notionhq/notion-mcp-server --transport http --port 8080

# Bind to a different host. The default is 127.0.0.1.
npx @notionhq/notion-mcp-server --transport http --host 0.0.0.0

# Run with a custom authentication token
npx @notionhq/notion-mcp-server --transport http --auth-token "your-secret-token"
```

When using Streamable HTTP transport, the server will be available at `http://127.0.0.1:<port>/mcp` by default.

##### Authentication

The Streamable HTTP transport requires bearer token authentication for security. You have three options:

###### Option 1: Auto-generated token (only for development)

```bash
npx @notionhq/notion-mcp-server --transport http
```

The server will generate a secure random token and write it to a file with restricted permissions:

```text
Generated auth token written to: /tmp/.notion-mcp-auth-token-12345
```

###### Option 2: Custom token via command line (recommended for production)

```bash
npx @notionhq/notion-mcp-server --transport http --auth-token "your-secret-token"
```

###### Option 3: Custom token via environment variable (recommended for production)

```bash
AUTH_TOKEN="your-secret-token" npx @notionhq/notion-mcp-server --transport http
```

The command line argument `--auth-token` takes precedence over the `AUTH_TOKEN` environment variable if both are provided.

###### Unsafe option: disable HTTP authentication

You can disable bearer token authentication only with the explicit unsafe flag:

```bash
npx @notionhq/notion-mcp-server --transport http --unsafe-disable-auth
```

WARNING: `--unsafe-disable-auth` is unsafe. The server may be reachable to pages you visit via DNS rebinding. Only use it on an isolated network.

When authentication is disabled, the server enables DNS rebinding protection by checking the `Host` and `Origin` headers against the configured local host and loopback hosts. The previous `--disable-auth` flag is still accepted as a deprecated alias, but it will print a warning.

##### Making HTTP requests

All requests to the Streamable HTTP transport must include the bearer token in the Authorization header:

```bash
# Example request
curl -H "Authorization: Bearer your-token-here" \
     -H "Content-Type: application/json" \
     -H "mcp-session-id: your-session-id" \
     -d '{"jsonrpc": "2.0", "method": "initialize", "params": {}, "id": 1}' \
     http://localhost:3000/mcp
```

**Note:** Make sure to set either the `NOTION_TOKEN` environment variable (recommended) or the `OPENAPI_MCP_HEADERS` environment variable with your Notion integration token when using either transport mode.

##### Serving multiple integrations (per-request token passthrough)

By default the server authenticates to Notion with a single token baked in at
startup, which locks one deployment to one Notion integration. To let a single
deployment serve **multiple** integrations, enable token passthrough so each
client supplies its own Notion integration token per connection:

```bash
# Enable per-request Notion tokens (flag or ENABLE_TOKEN_PASSTHROUGH=true)
npx @notionhq/notion-mcp-server --transport http --enable-token-passthrough
```

Clients then send their Notion token on the **initialize** request using the
dedicated `Notion-Token` header:

```bash
curl -H "Authorization: Bearer <server-auth-token>" \
     -H "Notion-Token: ntn_****" \
     -H "Content-Type: application/json" \
     -d '{"jsonrpc": "2.0", "method": "initialize", "params": {}, "id": 1}' \
     http://localhost:3000/mcp
```

How the token is resolved for each connection, in order:

1. The `Notion-Token` header (preferred — unambiguous, and works alongside the
   server's own `Authorization` gateway auth). If present it must be a valid
   Notion token, otherwise the request is rejected with `401`.
2. `Authorization: Bearer ntn_****` — only when the server's own bearer auth is
   turned off (`--unsafe-disable-auth`), so the header is free to carry the
   Notion token directly.
3. Otherwise the startup env token (`NOTION_TOKEN` / `OPENAPI_MCP_HEADERS`), if
   set, so passthrough and a default integration can coexist on one deployment.

Notes:

- Only values with a Notion token prefix (`ntn_`, legacy `secret_`) are treated
  as Notion tokens, so the server's gateway secret and a tenant's Notion token
  never collide.
- Each token is bound to its MCP session; tokens are never logged (only a
  redacted prefix is emitted).
- This is a deliberate token-passthrough setup. Always deploy it over TLS, and
  prefer keeping the server's own bearer auth (`--auth-token`) enabled as a
  gateway in front of multi-tenant traffic.

### Examples

1. Using the following instruction

```text
Comment "Hello MCP" on page "Getting started"
```

   AI will correctly plan two API calls, `v1/search` and `v1/comments`, to achieve the task

1. Similarly, the following instruction will result in a new page named "Notion MCP" added to parent page "Development"

```text
Add a page titled "Notion MCP" to page "Development"
```

1. You may also reference content ID directly

```text
Get the content of page 1a6b35e6e67f802fa7e1d27686f017f2
```

### Development

#### Build & test

```bash
npm run build
npm test
```

#### Execute

```bash
npx -y --prefix /path/to/local/notion-mcp-server @notionhq/notion-mcp-server
```

Testing changes locally in Cursor:

1. Run `npm link` command from repository root to create a machine-global symlink to the `notion-mcp-server` package.
2. Merge the configuration snippet below into Cursor's `mcp.json` (or other MCP client you want to test with).
3. (Cleanup) run `npm unlink` from repository root.

```json
{
  "mcpServers": {
    "notion-local-package": {
      "command": "notion-mcp-server",
      "env": {
        "NOTION_TOKEN": "ntn_..."
      }
    }
  }
}
```

#### Publish

```bash
npm login
npm publish --access public
```
