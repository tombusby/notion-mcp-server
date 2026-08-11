import { describe, it, expect } from 'vitest'
import path from 'path'
import fs from 'fs'
import type { OpenAPIV3 } from 'openapi-types'
import { OpenAPIToMCPConverter } from '../parser'

/**
 * Guards the page-markdown tools against the real Notion OpenAPI spec and
 * verifies that header parameters (Notion-Version) are not exposed as model
 * inputs.
 */
describe('Notion page-markdown tools', () => {
  const spec = JSON.parse(
    fs.readFileSync(path.resolve(process.cwd(), 'scripts/notion-openapi.json'), 'utf-8'),
  ) as OpenAPIV3.Document

  const { tools, openApiLookup } = new OpenAPIToMCPConverter(spec).convertToMCPTools()
  const methods = Object.values(tools).flatMap((t) => t.methods)
  const byName = (name: string) => methods.find((m) => m.name === name)

  it('exposes retrieve-page-markdown and update-page-markdown', () => {
    expect(byName('retrieve-page-markdown')).toBeDefined()
    expect(byName('update-page-markdown')).toBeDefined()
  })

  it('maps the markdown tools to the correct HTTP operations', () => {
    const get = Object.entries(openApiLookup).find(([, op]) => op.operationId === 'retrieve-page-markdown')
    const patch = Object.entries(openApiLookup).find(([, op]) => op.operationId === 'update-page-markdown')
    expect(get?.[1].method).toBe('get')
    expect(get?.[1].path).toBe('/v1/pages/{page_id}/markdown')
    expect(patch?.[1].method).toBe('patch')
    expect(patch?.[1].path).toBe('/v1/pages/{page_id}/markdown')
  })

  it('does not expose Notion-Version (a server-managed header) as a tool input', () => {
    for (const method of methods) {
      expect(Object.keys(method.inputSchema.properties ?? {})).not.toContain('Notion-Version')
    }
  })

  it('exposes the expected inputs for the markdown tools', () => {
    const retrieve = byName('retrieve-page-markdown')!
    const retrieveProps = Object.keys(retrieve.inputSchema.properties ?? {})
    expect(retrieveProps).toContain('page_id')
    expect(retrieveProps).toContain('include_transcript')

    const update = byName('update-page-markdown')!
    const updateProps = Object.keys(update.inputSchema.properties ?? {})
    expect(updateProps).toContain('page_id')
    expect(updateProps).toContain('type')
    expect(updateProps).toContain('replace_content')
    expect(updateProps).toContain('update_content')
  })

  /**
   * Only `summary` reaches the model as a tool description (parser.ts builds it
   * from `operation.summary || operation.description`), and per-property
   * descriptions survive on the input schema. These assertions keep the
   * block-addressing guidance from being silently dropped by a future spec
   * regeneration — without it, nothing tells the model that block IDs exist.
   */
  describe('block-addressing guidance', () => {
    it('tells the model that block children carry IDs usable for targeted edits', () => {
      const description = byName('get-block-children')!.description
      expect(description).toMatch(/block ID/i)
      expect(description).toMatch(/last_edited_time/)
    })

    it('steers the block mutation tools away from find-and-replace', () => {
      expect(byName('update-a-block')!.description).toMatch(/Retrieve block children/)
      expect(byName('delete-a-block')!.description).toMatch(/Retrieve block children/)
    })

    it('documents that `after` positions an append, and that there is no move operation', () => {
      expect(byName('patch-block-children')!.description).toMatch(/no move operation/i)
    })

    it('warns that retrieved Markdown is not guaranteed to round-trip', () => {
      expect(byName('retrieve-page-markdown')!.description).toMatch(/round-trip/i)
    })

    it('points update-page-markdown at block IDs for targeted edits', () => {
      expect(byName('update-page-markdown')!.description).toMatch(/Retrieve block children/)
    })
  })

  /**
   * Regression guard for makenotion/notion-mcp-server#271: the spec used to
   * declare a `type` object in the update-a-block request body, so the only
   * shape the generated tool could send was `{"type": {"paragraph": …}}` —
   * which Notion rejects with a 400 on every call, leaving the tool able to do
   * nothing but archive. Block-type keys belong at the body root.
   */
  describe('update-a-block request shape', () => {
    const updateABlock = () => byName('update-a-block')!

    it('does not wrap block content under a `type` body field', () => {
      const properties = updateABlock().inputSchema.properties ?? {}
      expect(Object.keys(properties)).not.toContain('type')
    })

    it('accepts block-type keys at the root of the body', () => {
      const properties = updateABlock().inputSchema.properties ?? {}
      expect(Object.keys(properties)).toContain('paragraph')
      expect(Object.keys(properties)).toContain('bulleted_list_item')
    })

    it('models a block-type value as { rich_text: [...] }', () => {
      // The converter wraps object properties in an anyOf with a string
      // alternative, to tolerate clients that JSON-encode nested arguments.
      const paragraph = (updateABlock().inputSchema.properties as any).paragraph
      const objectBranch = (paragraph.anyOf ?? [paragraph]).find((b: any) => b.type === 'object')
      expect(objectBranch.properties.rich_text.type).toBe('array')
      expect(objectBranch.required).toContain('rich_text')
    })

    it('permits block types the spec does not enumerate', () => {
      // Only paragraph and bulleted_list_item are modelled, but headings,
      // to_do, callout and the rest take the same shape and must get through.
      // An absent additionalProperties permits them; an explicit false would not.
      expect((updateABlock().inputSchema as any).additionalProperties).not.toBe(false)
    })

    it('tells the model where the block-type key goes, since the schema cannot', () => {
      // The body-level description is not carried onto the input schema, so
      // the shape has to be stated in the summary to reach the model at all.
      expect(updateABlock().description).toMatch(/root of the body/)
    })

    it('does not default `archived` to true, which would archive on any edit', () => {
      const archived = (updateABlock().inputSchema.properties as any).archived
      expect(archived.default).toBeUndefined()
    })
  })

  describe('find-and-replace hazard documentation', () => {
    const updateContent = () => {
      const update = byName('update-page-markdown')!
      const schema = (update.inputSchema.properties as any).update_content
      // The request body is a union over the edit operations; find the branch
      // carrying content_updates rather than depending on its position.
      const branches = schema.anyOf ?? [schema]
      return branches.find((b: any) => b?.properties?.content_updates)?.properties
    }

    it('warns on content_updates that edits apply in order and can drop content', () => {
      const description = updateContent().content_updates.description
      expect(description).toMatch(/in order/)
      expect(description).toMatch(/silently/i)
    })

    it('documents the single-block constraint and table-row storage on old_str', () => {
      const description = updateContent().content_updates.items.properties.old_str.description
      expect(description).toMatch(/single block/i)
      expect(description).toMatch(/blank line/i)
      expect(description).toMatch(/table rows/i)
    })
  })
})
