import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { CallToolRequestSchema, JSONRPCResponse, ListToolsRequestSchema, Tool } from '@modelcontextprotocol/sdk/types.js'
import { JSONSchema7 as IJsonSchema } from 'json-schema'
import { OpenAPIToMCPConverter } from '../openapi/parser'
import { HttpClient, HttpClientError } from '../client/http-client'
import { ContentUpdate, validateContentUpdates } from './content-updates'
import { annotateReadResponse, BlockReader, enforcePrecondition, PreconditionError } from './block-preconditions'
import {
  addSectionHint,
  buildOutline,
  headingOf,
  sliceSection,
  readPayloadOptions,
  shapeMarkdownRead,
  shapeUpdateResponse,
  stripPayloadParams,
} from './payload-shaping'
import { Block } from './content-hash'
import { OpenAPIV3 } from 'openapi-types'
import { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'

type PathItemObject = OpenAPIV3.PathItemObject & {
  get?: OpenAPIV3.OperationObject
  put?: OpenAPIV3.OperationObject
  post?: OpenAPIV3.OperationObject
  delete?: OpenAPIV3.OperationObject
  patch?: OpenAPIV3.OperationObject
}

type NewToolDefinition = {
  methods: Array<{
    name: string
    description: string
    inputSchema: IJsonSchema & { type: 'object' }
    returnSchema?: IJsonSchema
  }>
}

/**
 * Recursively deserialize stringified JSON values in parameters.
 * This handles the case where MCP clients (like Cursor, Claude Code, and some
 * SDKs) double-serialize nested object/array parameters, sending them as JSON
 * strings instead of structured values.
 *
 * The whole argument tree is walked uniformly: every object property and every
 * array element is visited, JSON-looking strings are decoded, and the decoded
 * result is walked again. This normalizes deeply nested cases — including a
 * stringified object that sits inside an array element object (e.g.
 * `{ children: [{ paragraph: '{"rich_text":[...]}' }] }`) and values that were
 * JSON-encoded more than once (e.g. `JSON.stringify(JSON.stringify(parent))`) —
 * before the request is forwarded to the Notion API.
 *
 * @see https://github.com/makenotion/notion-mcp-server/issues/176
 */
function deserializeParams(params: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(params)) {
    result[key] = deserializeValue(value)
  }
  return result
}

/**
 * Normalize a single value: decode a JSON-encoded string into the structured
 * value it represents (recursing into the result), walk into every array
 * element, and walk into every nested object property. Non-JSON strings and
 * scalars are returned unchanged, so values the schema legitimately wants as
 * strings (and numbers/booleans encoded as strings) are left intact.
 */
function deserializeValue(value: unknown): unknown {
  if (typeof value === 'string') {
    return unwrapJsonString(value)
  }

  if (Array.isArray(value)) {
    return value.map(deserializeValue)
  }

  if (typeof value === 'object' && value !== null) {
    const result: Record<string, unknown> = {}
    for (const [key, nested] of Object.entries(value)) {
      result[key] = deserializeValue(nested)
    }
    return result
  }

  return value
}

// Bound how many JSON-decode passes we attempt on a single string. One pass
// handles the common single-encoding; extra passes absorb double/triple
// serialization without unbounded work on adversarial input.
const MAX_UNWRAP_DEPTH = 3

/**
 * Resolve a (possibly multiply-)JSON-encoded string to the object or array it
 * represents. Only strings that ultimately decode to an object or array are
 * transformed (and then recursively normalized); a string that decodes to a
 * scalar (number/boolean/null) or to another plain string is returned
 * unchanged, so genuine string values are never corrupted.
 */
function unwrapJsonString(value: string): unknown {
  let current = value
  for (let depth = 0; depth < MAX_UNWRAP_DEPTH; depth++) {
    const trimmed = current.trim()
    // Only attempt a parse when the string could encode an object/array
    // (`{...}`/`[...]`) or wrap one in a JSON string literal (`"..."`). This
    // skips the common case of ordinary text without touching JSON.parse.
    const couldBeEncoded =
      (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
      (trimmed.startsWith('[') && trimmed.endsWith(']')) ||
      (trimmed.startsWith('"') && trimmed.endsWith('"'))
    if (!couldBeEncoded) {
      break
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      break
    }

    if (typeof parsed === 'object' && parsed !== null) {
      return deserializeValue(parsed)
    }
    if (typeof parsed === 'string') {
      // Peeled one layer of JSON-string encoding; loop to see whether it wraps
      // a structured value (double-encoding).
      current = parsed
      continue
    }
    // Decoded to a scalar — not a structured value; leave the original intact.
    break
  }
  return value
}

/**
 * Extract the `content_updates` batch from an `update-page-markdown` call, or
 * null when this call is not a find-and-replace update.
 *
 * Only `update_content` carries interacting anchors; `replace_content` and the
 * deprecated positional operations are left alone.
 */
function getContentUpdates(
  operation: OpenAPIV3.OperationObject & { method: string; path: string },
  params: Record<string, unknown>,
): ContentUpdate[] | null {
  if (operation.operationId !== 'update-page-markdown' || params.type !== 'update_content') {
    return null
  }
  const updateContent = params.update_content
  if (typeof updateContent !== 'object' || updateContent === null) {
    return null
  }
  const updates = (updateContent as Record<string, unknown>).content_updates
  return Array.isArray(updates) ? (updates as ContentUpdate[]) : null
}

// import this class, extend and return server
export class MCPProxy {
  private server: Server
  private httpClient: HttpClient
  private tools: Record<string, NewToolDefinition>
  private openApiLookup: Record<string, OpenAPIV3.OperationObject & { method: string; path: string }>

  /**
   * @param headers Notion API headers to authenticate with. When omitted, the
   *   headers are resolved from the environment (`OPENAPI_MCP_HEADERS` /
   *   `NOTION_TOKEN`). The HTTP transport passes per-connection headers here so a
   *   single deployment can serve multiple Notion integrations.
   */
  constructor(name: string, openApiSpec: OpenAPIV3.Document, headers?: Record<string, string>) {
    this.server = new Server({ name, version: '1.0.0' }, { capabilities: { tools: {} } })
    const baseUrl = openApiSpec.servers?.[0].url
    if (!baseUrl) {
      throw new Error('No base URL found in OpenAPI spec')
    }
    this.httpClient = new HttpClient(
      {
        baseUrl,
        headers: headers ?? this.parseHeadersFromEnv(),
      },
      openApiSpec,
    )

    // Convert OpenAPI spec to MCP tools
    const converter = new OpenAPIToMCPConverter(openApiSpec)
    const { tools, openApiLookup } = converter.convertToMCPTools()
    this.tools = tools
    this.openApiLookup = openApiLookup

    this.setupHandlers()
  }

  private setupHandlers() {
    // Handle tool listing
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      const tools: Tool[] = []

      // Add methods as separate tools to match the MCP format
      Object.entries(this.tools).forEach(([toolName, def]) => {
        def.methods.forEach(method => {
          const toolNameWithMethod = `${toolName}-${method.name}`;
          const truncatedToolName = this.truncateToolName(toolNameWithMethod);

          // Look up the HTTP method to determine annotations
          const operation = this.openApiLookup[toolNameWithMethod];
          const httpMethod = operation?.method?.toLowerCase();
          const isReadOnly = httpMethod === 'get';

          tools.push({
            name: truncatedToolName,
            description: method.description,
            inputSchema: method.inputSchema as Tool['inputSchema'],
            annotations: {
              title: this.operationIdToTitle(method.name),
              ...(isReadOnly
                ? { readOnlyHint: true }
                : { destructiveHint: true }),
            },
          })
        })
      })

      return { tools }
    })

    // Handle tool calling
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: params } = request.params

      // Find the operation in OpenAPI spec
      const operation = this.findOperation(name)
      if (!operation) {
        throw new Error(`Method ${name} not found`)
      }

      // Deserialize any stringified JSON parameters (fixes double-serialization bug)
      // See: https://github.com/makenotion/notion-mcp-server/issues/176
      const deserializedParams = params ? deserializeParams(params as Record<string, unknown>) : {}

      // A find-and-replace batch is applied server-side in order, against a
      // document each preceding edit has already changed. Anchors that interact
      // are accepted and return cleanly while replacing the wrong content, so
      // reject them here — before the request is sent, leaving nothing written.
      const contentUpdates = getContentUpdates(operation, deserializedParams)
      if (contentUpdates) {
        validateContentUpdates(contentUpdates)
      }

      // How much of the response the caller wants back. Read before the call
      // because `format: "outline"` is answered from the block tree and never
      // reaches the markdown endpoint at all.
      const payloadOptions = readPayloadOptions(operation.operationId, deserializedParams, contentUpdates)

      try {
        if (payloadOptions.format === 'outline') {
          const outline = await buildOutline(String(deserializedParams.page_id ?? ''), this.blockReader())
          return { content: [{ type: 'text', text: JSON.stringify(outline) }] }
        }

        if (payloadOptions.format === 'section') {
          const section = await this.readSection(String(deserializedParams.page_id ?? ''))
          if (section) {
            return { content: [{ type: 'text', text: JSON.stringify(section) }] }
          }
          // Not a heading, or not locatable — fall through to a normal read
          // rather than failing. The response carries a note saying so.
        }

        // Block writes carry a content-hash precondition. Verified before the
        // request is sent, so a stale write leaves nothing written. Returns
        // the params with the server-side hash arguments removed — they are
        // ours, and executeOperation would otherwise put them in the request
        // body and have Notion reject the call.
        const checkedParams = await enforcePrecondition(operation.operationId, deserializedParams, this.blockReader())

        // The response-shaping params are ours too, and Notion would reject
        // them as unknown query arguments.
        const forwardParams = stripPayloadParams(checkedParams)

        // Execute the operation
        const response = await this.httpClient.executeOperation(operation, forwardParams)

        // Attach the hashes a subsequent write will require.
        const annotated = await annotateReadResponse(operation.operationId, response.data, this.blockReader())

        // Trim the page-markdown responses, which otherwise return the whole
        // page on every call — including on writes, where the caller already
        // holds the content it just sent.
        const data = this.shapeResponse(operation.operationId, annotated, payloadOptions, contentUpdates)

        // Convert response to MCP format
        return {
          content: [
            {
              type: 'text', // currently this is the only type that seems to be used by mcp server
              text: JSON.stringify(data), // TODO: pass through the http status code text?
            },
          ],
        }
      } catch (error) {
        if (error instanceof PreconditionError) {
          // A refused write is an expected outcome rather than a server fault,
          // and the payload is deliberately actionable — it carries the current
          // content so the caller can diff, decide and retry in one round trip.
          //
          // It is still flagged as an error, because the whole point of the
          // guard is that a stale write is loud. Reported as an ordinary
          // success, a refusal reads as "the edit landed" to anything that does
          // not parse the payload closely, which is the silent data loss the
          // precondition exists to prevent, merely moved one level up.
          console.error('Precondition failed', { status: error.status, code: error.payload.code })
          return {
            isError: true,
            content: [{ type: 'text', text: JSON.stringify(error.payload) }],
          }
        }
        console.error('Error in tool call', error instanceof Error ? error.message : 'Unknown error')
        if (error instanceof HttpClientError) {
          console.error('HttpClientError encountered, returning structured error', { status: error.status })
          const data = error.data?.response?.data ?? error.data ?? {}
          return {
            // Without this the call is reported as a success whose text merely
            // describes a failure, leaving a client no way to tell the two
            // apart without parsing a payload whose shape it cannot assume.
            isError: true,
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  ...(typeof data === 'object' && data !== null ? data : { data }),
                  // Last, so it wins. This used to be the literal 'error' set
                  // first, which every Notion error body then overwrote with its
                  // own numeric status — leaving the field a string on the paths
                  // where the body carried no status and a number everywhere
                  // else. The transport status is the one thing always known, so
                  // it is what the field reports.
                  status: error.status,
                }),
              },
            ],
          }
        }
        throw error
      }
    })
  }

  /** Apply the caller's payload-size choices to a page-markdown response. */
  private shapeResponse(
    operationId: string | undefined,
    data: unknown,
    options: ReturnType<typeof readPayloadOptions>,
    contentUpdates: ContentUpdate[] | null,
  ): unknown {
    switch (operationId) {
      case 'update-page-markdown':
        return shapeUpdateResponse(data, contentUpdates, options.returnContent ?? 'changed')
      case 'retrieve-page-markdown':
        // The hint costs nothing — it is read off the response already in hand
        // — and catches the caller who passed a heading's block ID expecting
        // its section and got the heading line by itself.
        return addSectionHint(shapeMarkdownRead(data, options.maxBlocks))
      default:
        return data
    }
  }

  private findOperation(operationId: string): (OpenAPIV3.OperationObject & { method: string; path: string }) | null {
    return this.openApiLookup[operationId] ?? null
  }

  /**
   * Read a heading's whole section, which is what `format: "outline"` promises
   * a block ID is good for.
   *
   * Notion headings are siblings of the content beneath them, so
   * `GET /v1/pages/{heading_id}/markdown` returns the heading line by itself.
   * The section has to be cut out of the parent's rendered Markdown instead.
   *
   * That means fetching the parent in full — deliberately. The resource being
   * conserved is the caller's context, not Notion's bandwidth: returning 27
   * blocks instead of 239 is the entire point, and the large fetch stays on
   * this side of the wire.
   *
   * Returns null when the block is not a heading or its section cannot be
   * located unambiguously, so the caller falls back to an ordinary read.
   */
  private async readSection(blockId: string): Promise<Record<string, unknown> | null> {
    if (!blockId) return null
    const markdownOp = this.findOperation('API-retrieve-page-markdown')
    if (!markdownOp) return null

    const block = (await this.blockReader().retrieveBlock(blockId)) as any
    const heading = headingOf(block)
    if (!heading) return null

    const parent = block?.parent ?? {}
    const parentId = parent.page_id ?? parent.block_id
    if (!parentId) return null

    const response = await this.httpClient.executeOperation(markdownOp, { page_id: parentId })
    const markdown = (response.data as { markdown?: unknown })?.markdown
    if (typeof markdown !== 'string') return null

    const section = sliceSection(markdown, heading.level, heading.text)
    if (!section) return null

    return {
      object: 'page_markdown_section',
      id: blockId,
      parent_id: parentId,
      heading: heading.text,
      level: heading.level,
      markdown: section.markdown,
      section_blocks: section.blocks,
      truncated: false,
    }
  }

  /**
   * The reads the precondition layer performs on the caller's behalf, routed
   * through the same HttpClient (and so the same per-connection Notion
   * credentials) as the tool call that triggered them.
   */
  private blockReader(): BlockReader {
    const retrieve = this.findOperation('API-retrieve-a-block')
    const children = this.findOperation('API-get-block-children')
    return {
      retrieveBlock: async (blockId: string): Promise<Block> => {
        if (!retrieve) throw new Error('retrieve-a-block operation is not available')
        const response = await this.httpClient.executeOperation(retrieve, { block_id: blockId })
        return response.data as Block
      },
      listChildren: async (blockId: string): Promise<Block[]> => {
        if (!children) throw new Error('get-block-children operation is not available')
        const collected: Block[] = []
        let cursor: string | undefined
        // Notion pages children 100 at a time. A partial listing would produce
        // a subtree hash over less than the subtree, so follow the cursor.
        do {
          const response = await this.httpClient.executeOperation(children, {
            block_id: blockId,
            page_size: 100,
            ...(cursor ? { start_cursor: cursor } : {}),
          })
          const data = response.data as { results?: Block[]; next_cursor?: string | null; has_more?: boolean }
          collected.push(...(data.results ?? []))
          cursor = data.has_more && data.next_cursor ? data.next_cursor : undefined
        } while (cursor)
        return collected
      },
    }
  }

  private parseHeadersFromEnv(): Record<string, string> {
    // First try OPENAPI_MCP_HEADERS (existing behavior)
    const headersJson = process.env.OPENAPI_MCP_HEADERS
    if (headersJson) {
      try {
        const headers = JSON.parse(headersJson)
        if (typeof headers !== 'object' || headers === null) {
          console.warn('OPENAPI_MCP_HEADERS environment variable must be a JSON object, got:', typeof headers)
        } else if (Object.keys(headers).length > 0) {
          // Only use OPENAPI_MCP_HEADERS if it contains actual headers
          return headers
        }
        // If OPENAPI_MCP_HEADERS is empty object, fall through to try NOTION_TOKEN
      } catch (error) {
        console.warn('Failed to parse OPENAPI_MCP_HEADERS environment variable:', error)
        // Fall through to try NOTION_TOKEN
      }
    }

    // Alternative: try NOTION_TOKEN
    const notionToken = process.env.NOTION_TOKEN
    if (notionToken) {
      // Notion-Version is intentionally omitted: it is sourced per-operation from
      // the OpenAPI spec by HttpClient, so endpoints can pin the version they need.
      return {
        'Authorization': `Bearer ${notionToken}`,
      }
    }

    return {}
  }

  private getContentType(headers: Headers): 'text' | 'image' | 'binary' {
    const contentType = headers.get('content-type')
    if (!contentType) return 'binary'

    if (contentType.includes('text') || contentType.includes('json')) {
      return 'text'
    } else if (contentType.includes('image')) {
      return 'image'
    }
    return 'binary'
  }

  private truncateToolName(name: string): string {
    if (name.length <= 64) {
      return name;
    }
    return name.slice(0, 64);
  }

  /**
   * Convert an operationId like "createDatabase" to a human-readable title like "Create Database"
   */
  private operationIdToTitle(operationId: string): string {
    // Split on camelCase boundaries and capitalize each word
    return operationId
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
      .split(/[\s_-]+/)
      .map(word => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  }

  async connect(transport: Transport) {
    // The SDK will handle stdio communication
    await this.server.connect(transport)
  }

  getServer() {
    return this.server
  }
}
