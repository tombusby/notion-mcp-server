import fs from 'node:fs'
import path from 'node:path'
import type { Server } from 'node:http'
import type { OpenAPIV3 } from 'openapi-types'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { MCPProxy } from '../mcp/proxy'
import { startTestServer, stopTestServer } from '../client/__tests__/test-server'
import { createFakeNotion, type FakeNotion, type RecordedRequest } from './notion-fake'

/**
 * Drives the real `MCPProxy` — real spec, real parser, real axios, real MCP
 * framing — against the fake Notion backend.
 *
 * Nothing here is mocked. `MCPProxy` takes its base URL from
 * `openApiSpec.servers[0].url` and offers no override, so the seam is to clone
 * the real spec and repoint that URL at the fake. Everything downstream is then
 * genuinely exercised, including the tool-name / operationId split that the
 * precondition layer depends on (`API-update-a-block` is the tool the client
 * calls; `update-a-block` is what `enforcePrecondition` switches on).
 */

export interface Harness {
  client: Client
  requests: RecordedRequest[]
  fake: FakeNotion
  close(): Promise<void>
}

const AUTH = 'Bearer test-token'

/** Assert on a request *sequence*: count and order, not merely presence. */
export function seq(requests: RecordedRequest[]): string[] {
  return requests.map((r) => `${r.method} ${r.path}`)
}

export function loadSpec(): OpenAPIV3.Document {
  const specPath = path.resolve(process.cwd(), 'scripts/notion-openapi.json')
  return JSON.parse(fs.readFileSync(specPath, 'utf-8')) as OpenAPIV3.Document
}

/**
 * Constructing this parses the full spec and initialises openapi-client-axios,
 * so build it once per file in `beforeAll` and call `fake.reset()` between
 * tests rather than rebuilding.
 */
export async function withNotionMcp(): Promise<Harness> {
  const fake = createFakeNotion()
  const { server, baseUrl } = await startTestServer(fake.app)

  const spec = loadSpec()
  spec.servers = [{ url: baseUrl }]

  // Headers are passed explicitly rather than read from the environment, so the
  // tests neither depend on nor are polluted by an ambient NOTION_TOKEN.
  const proxy = new MCPProxy('notion-wire-test', spec, { Authorization: AUTH })

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'wire-test-client', version: '1.0.0' }, { capabilities: {} })

  await Promise.all([proxy.connect(serverTransport), client.connect(clientTransport)])

  return {
    client,
    requests: fake.requests,
    fake,
    async close() {
      await client.close()
      await stopTestServer(server as Server)
    },
  }
}

/**
 * Call a tool and parse the single text content block back into an object.
 * Every result this server produces — success, structured error, and refused
 * precondition alike — is JSON in one text block.
 */
export async function callTool(client: Client, name: string, args: Record<string, unknown>): Promise<any> {
  return (await callToolRaw(client, name, args)).data
}

/**
 * As `callTool`, but keeps the result envelope so a test can assert on
 * `isError` — the protocol-level success/failure signal, which is separate from
 * whatever the payload says.
 */
export async function callToolRaw(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<{ data: any; isError: boolean }> {
  const result: any = await client.callTool({ name, arguments: args })
  const text = result?.content?.[0]?.text
  if (typeof text !== 'string') {
    throw new Error(`tool ${name} returned no text content: ${JSON.stringify(result)}`)
  }
  return { data: JSON.parse(text), isError: result.isError === true }
}
