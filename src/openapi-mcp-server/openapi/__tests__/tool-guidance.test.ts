import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { OpenAPIToMCPConverter } from '../parser'

/**
 * Guards the guidance that actually reaches a client.
 *
 * A tool's description is built as `operation.summary || operation.description`
 * (parser.ts), so anything written into `description` on an operation that also
 * has a `summary` is never surfaced. That is not hypothetical: the content-hash
 * spec's required wording sat in `description` on four operations across three
 * commits and several deploys, invisible the whole time, because every check
 * inspected the spec JSON rather than the generated tools.
 *
 * These assertions run against the converter's output for that reason.
 */
const spec = JSON.parse(readFileSync(join(__dirname, '../../../../scripts/notion-openapi.json'), 'utf-8'))
const methods = new OpenAPIToMCPConverter(spec).convertToMCPTools().tools.API.methods

function toolFor(operationId: string): any {
  const found = methods.find((m: any) => m.name === operationId)
  if (!found) throw new Error(`no tool for ${operationId}`)
  return found
}

const describeOf = (operationId: string): string => toolFor(operationId).description ?? ''

describe('hash preconditions are stated in the description a client sees', () => {
  it.each([
    ['update-a-block', 'expected_content_hash'],
    ['delete-a-block', 'expected_subtree_hash'],
    ['patch-block-children', 'expected_anchor_hash'],
  ])('%s names %s and what a 409 means', (operationId, param) => {
    const description = describeOf(operationId)
    expect(description).toContain(param)
    expect(description).toContain('409')
    expect(description).toMatch(/do not construct or modify it/i)
  })

  it('retrieve-page-markdown says it is not a source of hashes', () => {
    const description = describeOf('retrieve-page-markdown')
    expect(description).toContain('no content_hash')
    // The claim 348b454 disproved must not come back: a plain read of a
    // heading's block ID returns the heading line, not its section.
    expect(description).not.toMatch(/passing a block id as page_id reads just that section/i)
  })

  it('offers format: "section" as the way to read one section', () => {
    const format = toolFor('retrieve-page-markdown').inputSchema?.properties?.format
    expect(format.enum).toEqual(['markdown', 'outline', 'section'])
    expect(format.description).toContain('siblings')
  })
})
