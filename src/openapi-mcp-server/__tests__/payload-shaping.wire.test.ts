import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { callTool, seq, withNotionMcp, type Harness } from './mcp-harness'
import { H1_ROUTES, H2_LANDED, H2_NESTED, H2_OPEN, OUTLINE_TOGGLE, PAGE_ID } from './notion-fake'

/**
 * Wire-level tests for response payload shaping.
 *
 * The properties worth pinning here are all about *size* and *request count*,
 * which is why they live at this layer: whether the caller gets the whole page
 * back is only observable in the response the client actually receives, and
 * whether the outline avoids reading the page is only observable in the
 * requests the backend actually receives.
 *
 * The same caveat as the other wire tests applies — the fake encodes our belief
 * about Notion's contract, and pins wiring rather than Notion's semantics.
 */

describe('page-markdown payload shaping', () => {
  let h: Harness

  beforeAll(async () => {
    h = await withNotionMcp()
  })

  afterAll(async () => {
    await h.close()
  })

  beforeEach(() => {
    h.fake.reset()
  })

  describe('update-page-markdown returns a receipt, not the document', () => {
    it('returns only the changed region by default', async () => {
      const data = await callTool(h.client, 'API-update-page-markdown', {
        page_id: PAGE_ID,
        type: 'update_content',
        update_content: {
          content_updates: [{ old_str: 'A closing paragraph.', new_str: 'A rewritten closing paragraph.' }],
        },
      })

      expect(data.object).toBe('page_markdown_update')
      expect(data.markdown_omitted).toBe(true)
      expect(data.edits).toBe(1)
      expect(data.verified).toBe(1)
      expect(data.unverified).toBe(0)
      expect(data.changed).toEqual([
        { index: 0, verified: true, markdown: 'A rewritten closing paragraph.' },
      ])

      // The whole point: the untouched body of the page does not come back.
      const text = JSON.stringify(data)
      expect(text).not.toContain('The opening paragraph of the page.')
      expect(text).not.toContain('Routes in')
    })

    it('costs the same on a huge page as on a small one', async () => {
      // The defect being fixed is that response size tracked *page* size, so
      // three edits to a 15,000-word page returned ~45,000 words. The property
      // that matters is therefore independence, not a ratio on any one page.
      const args = {
        page_id: PAGE_ID,
        type: 'update_content' as const,
        update_content: {
          content_updates: [{ old_str: 'A closing paragraph.', new_str: 'A rewritten closing paragraph.' }],
        },
      }

      const small = await callTool(h.client, 'API-update-page-markdown', args)

      h.fake.reset()
      const filler = Array.from({ length: 2000 }, (_, i) => `Filler paragraph number ${i}.`).join('\n\n')
      h.fake.store.pageMarkdown = `${filler}\n\nA closing paragraph.`
      const huge = await callTool(h.client, 'API-update-page-markdown', args)

      expect(JSON.stringify(small)).toEqual(JSON.stringify(huge))

      // And the page really was large enough for the old behaviour to hurt.
      h.fake.reset()
      h.fake.store.pageMarkdown = `${filler}\n\nA closing paragraph.`
      const full = await callTool(h.client, 'API-update-page-markdown', { ...args, return_content: 'full' })
      expect(JSON.stringify(full).length).toBeGreaterThan(50_000)
      expect(JSON.stringify(huge).length).toBeLessThan(400)
    })

    it('flags an edit it cannot verify rather than calling it applied', async () => {
      // The fake applies edits by exact replace, so an anchor that does not
      // match leaves the page untouched — and the receipt must say so.
      const data = await callTool(h.client, 'API-update-page-markdown', {
        page_id: PAGE_ID,
        type: 'update_content',
        update_content: {
          content_updates: [{ old_str: 'text that is not on the page', new_str: 'a replacement never applied' }],
        },
      })

      expect(data.verified).toBe(0)
      expect(data.unverified).toBe(1)
      expect(data.changed[0].verified).toBe(false)
      expect(data.changed[0].old_str).toBe('text that is not on the page')
      expect(data.changed[0].note).toContain('escaping')
    })

    it('defaults to a bare receipt for replace_content', async () => {
      const data = await callTool(h.client, 'API-update-page-markdown', {
        page_id: PAGE_ID,
        type: 'replace_content',
        replace_content: { new_str: '# Wholly new page\n\nWith new content.' },
      })

      expect(data.object).toBe('page_markdown_update')
      expect(data.changed).toBeUndefined()
      expect(JSON.stringify(data)).not.toContain('Wholly new page')
    })

    it('honours return_content: "none" and "full"', async () => {
      const none = await callTool(h.client, 'API-update-page-markdown', {
        page_id: PAGE_ID,
        return_content: 'none',
        type: 'update_content',
        update_content: {
          content_updates: [{ old_str: 'A closing paragraph.', new_str: 'Edited once.' }],
        },
      })
      expect(none.edits).toBe(1)
      expect(none.changed).toBeUndefined()

      h.fake.reset()
      const full = await callTool(h.client, 'API-update-page-markdown', {
        page_id: PAGE_ID,
        return_content: 'full',
        type: 'update_content',
        update_content: {
          content_updates: [{ old_str: 'A closing paragraph.', new_str: 'Edited once.' }],
        },
      })
      expect(full.object).toBe('page_markdown')
      expect(full.markdown).toContain('The opening paragraph of the page.')
    })

    it('never sends return_content to Notion', async () => {
      await callTool(h.client, 'API-update-page-markdown', {
        page_id: PAGE_ID,
        return_content: 'none',
        type: 'replace_content',
        replace_content: { new_str: 'new' },
      })

      const patch = h.requests.find((r) => r.method === 'PATCH')!
      expect(patch.query).toEqual({})
      expect(JSON.stringify(patch.body)).not.toContain('return_content')
    })
  })

  describe('outline mode', () => {
    it('returns headings with block IDs and hashes without reading the page', async () => {
      const data = await callTool(h.client, 'API-retrieve-page-markdown', {
        page_id: PAGE_ID,
        format: 'outline',
      })

      expect(data.object).toBe('page_outline')
      expect(data.truncated).toBe(false)

      // Nothing touched the markdown endpoint: the whole point is that
      // locating a section no longer costs a full-page read.
      expect(seq(h.requests).some((r) => r.includes('/markdown'))).toBe(false)

      const byId = Object.fromEntries(data.outline.map((e: any) => [e.block_id, e]))
      expect(Object.keys(byId).sort()).toEqual([H1_ROUTES, H2_LANDED, H2_NESTED, H2_OPEN].sort())

      expect(byId[H1_ROUTES]).toMatchObject({ type: 'heading_1', level: 1, text: 'Routes in' })
      expect(byId[H1_ROUTES].content_hash).toMatch(/^[0-9a-f]{16}$/)

      // "What landed" runs to the next h2: two paragraphs, the toggle, the
      // table. "Still open" closes it.
      expect(byId[H2_LANDED].section_blocks).toBe(4)
      // "Routes in" is an h1, so neither h2 closes it — it runs to the end.
      expect(byId[H1_ROUTES].section_blocks).toBe(8)
    })

    it('descends into collapsed containers to find hidden headings', async () => {
      const data = await callTool(h.client, 'API-retrieve-page-markdown', {
        page_id: PAGE_ID,
        format: 'outline',
      })

      expect(data.outline.map((e: any) => e.block_id)).toContain(H2_NESTED)
      expect(seq(h.requests)).toEqual([
        `GET /v1/blocks/${PAGE_ID}/children`,
        `GET /v1/blocks/${OUTLINE_TOGGLE}/children`,
      ])
    })

    it('a plain read of a heading block returns the heading alone, and says so', async () => {
      // The defect this pins: Notion headings are siblings of their content, so
      // reading a heading's own ID gets the heading line and nothing else. The
      // outline advertised this as a scoped section read for weeks.
      const data = await callTool(h.client, 'API-retrieve-page-markdown', { page_id: H2_LANDED })

      expect(data.markdown).toBe('## What landed')
      expect(data.section_hint).toContain('format: "section"')
    })

    it('format: "section" returns the heading together with its siblings', async () => {
      const outline = await callTool(h.client, 'API-retrieve-page-markdown', {
        page_id: PAGE_ID,
        format: 'outline',
      })
      const section = outline.outline.find((e: any) => e.block_id === H2_LANDED)

      h.fake.requests.length = 0
      const data = await callTool(h.client, 'API-retrieve-page-markdown', {
        page_id: section.block_id,
        format: 'section',
      })

      expect(data.object).toBe('page_markdown_section')
      // The tree and the Markdown describe the same page, so the section read
      // and the outline's count agree: 4 siblings plus the heading itself.
      expect(data.section_blocks).toBe(section.section_blocks + 1)
      expect(data.section_blocks).toBe(5)
      expect(data.markdown.startsWith('## What landed')).toBe(true)
      expect(data.markdown).toContain('</table>')
      expect(data.markdown).not.toContain('## Still open')
      expect(data.markdown).not.toContain('The opening paragraph of the page.')

      // Retrieve the block to learn its parent and level, then read the parent
      // in full and cut the section out on this side of the wire. The large
      // fetch is deliberate: what is being conserved is the caller's context.
      expect(seq(h.requests)).toEqual([
        `GET /v1/blocks/${H2_LANDED}`,
        `GET /v1/pages/${PAGE_ID}/markdown`,
      ])
    })

    it('falls back to an ordinary read when the block is not a heading', async () => {
      const data = await callTool(h.client, 'API-retrieve-page-markdown', {
        page_id: 'body-1',
        format: 'section',
      })
      expect(data.object).toBe('page_markdown')
    })

    it('never sends format to Notion', async () => {
      await callTool(h.client, 'API-retrieve-page-markdown', { page_id: PAGE_ID, format: 'markdown' })
      const get = h.requests.find((r) => r.path.includes('/markdown'))!
      expect(get.query.format).toBeUndefined()
    })
  })

  describe('max_blocks', () => {
    it('truncates a markdown read and reports what it dropped', async () => {
      const data = await callTool(h.client, 'API-retrieve-page-markdown', {
        page_id: PAGE_ID,
        max_blocks: 2,
      })

      // Notion separates blocks with a single newline, not a blank line.
      // Assuming otherwise makes the whole page one block, and this feature
      // silently stops doing anything.
      expect(data.markdown).toBe('# Routes in\nThe opening paragraph of the page.')
      expect(data.truncated).toBe(true)
      expect(data.omitted_blocks).toBe(7)
      expect(data.truncation_note).toContain('outline')
    })

    it('keeps a toggle and a table whole rather than splitting them per line', async () => {
      // <details> and <table> render across many lines. Counting each line as a
      // block would truncate mid-container and emit unbalanced markup.
      const data = await callTool(h.client, 'API-retrieve-page-markdown', {
        page_id: PAGE_ID,
        max_blocks: 7,
      })

      const opens = (data.markdown.match(/<details>|<table/g) ?? []).length
      const closes = (data.markdown.match(/<\/details>|<\/table>/g) ?? []).length
      expect(opens).toBe(closes)
      expect(data.markdown).toContain('<summary>Hidden section</summary>')
      expect(data.markdown).toContain('</table>')
      expect(data.omitted_blocks).toBe(2)
    })

    it('leaves a short page alone and does not reach Notion with the param', async () => {
      const data = await callTool(h.client, 'API-retrieve-page-markdown', {
        page_id: PAGE_ID,
        max_blocks: 100,
      })

      expect(data.truncated).toBe(false)
      expect(data.omitted_blocks).toBeUndefined()
      const get = h.requests.find((r) => r.path.includes('/markdown'))!
      expect(get.query.max_blocks).toBeUndefined()
    })
  })

  it('still rejects an unsafe batch before shaping anything', async () => {
    // Payload shaping must not have moved the batch validation: an unsafe
    // batch has to leave nothing written, which means no request at all.
    await expect(
      callTool(h.client, 'API-update-page-markdown', {
        page_id: PAGE_ID,
        type: 'update_content',
        update_content: {
          content_updates: [
            { old_str: 'A closing paragraph.', new_str: 'A closing paragraph, revised.' },
            { old_str: 'A closing paragraph, revised.', new_str: 'Revised twice.' },
          ],
        },
      }),
    ).rejects.toThrow()

    expect(h.requests).toEqual([])
  })
})

describe('dry run', () => {
  let h: Harness

  beforeAll(async () => {
    h = await withNotionMcp()
  })

  afterAll(async () => {
    await h.close()
  })

  beforeEach(() => {
    h.fake.reset()
  })

  it('writes nothing, and says what would happen', async () => {
    const data = await callTool(h.client, 'API-update-page-markdown', {
      page_id: PAGE_ID,
      dry_run: true,
      type: 'update_content',
      update_content: {
        content_updates: [{ old_str: 'A closing paragraph.', new_str: 'A rewritten closing paragraph.' }],
      },
    })

    expect(data.object).toBe('page_markdown_dry_run')
    expect(data.written).toBe(false)
    expect(data.would_apply).toBe(1)
    expect(data.would_fail).toBe(0)
    expect(data.changes[0]).toMatchObject({
      index: 0,
      matches: 1,
      would_apply: true,
      before: 'A closing paragraph.',
      after: 'A rewritten closing paragraph.',
    })

    // The whole point: a read to simulate against, and no PATCH at all.
    expect(seq(h.requests)).toEqual([`GET /v1/pages/${PAGE_ID}/markdown`])
    expect(h.fake.store.pageMarkdown).toContain('A closing paragraph.')
  })

  it('reports an anchor that is not on the page as a miss', async () => {
    const data = await callTool(h.client, 'API-update-page-markdown', {
      page_id: PAGE_ID,
      dry_run: true,
      type: 'update_content',
      update_content: {
        content_updates: [{ old_str: 'text that is not on the page', new_str: 'never applied' }],
      },
    })

    expect(data.would_apply).toBe(0)
    expect(data.would_fail).toBe(1)
    expect(data.changes[0].would_apply).toBe(false)
    expect(data.changes[0].matches).toBe(0)
  })

  it('catches an anchor that an earlier edit in the batch destroys', async () => {
    // This is the case validateContentUpdates says it cannot see: the two
    // anchors are unrelated as strings, so only simulating against the page
    // shows that the first edit removes the text the second needs.
    const data = await callTool(h.client, 'API-update-page-markdown', {
      page_id: PAGE_ID,
      dry_run: true,
      type: 'update_content',
      update_content: {
        content_updates: [
          // Disjoint as strings — neither contains the other, and the second
          // anchor is not in the first's replacement — so the string checks
          // pass. They still collide on the page.
          { old_str: 'mentions cold dread', new_str: 'mentions calm' },
          { old_str: 'cold dread and nothing else.', new_str: 'warm relief.' },
        ],
      },
    })

    expect(data.changes[0].would_apply).toBe(true)
    expect(data.changes[1].would_apply).toBe(false)
    expect(data.changes[1].note).toContain('earlier edit')
    expect(h.requests.some((r) => r.method === 'PATCH')).toBe(false)
  })

  it('never sends dry_run to Notion on a real write', async () => {
    await callTool(h.client, 'API-update-page-markdown', {
      page_id: PAGE_ID,
      dry_run: false,
      type: 'update_content',
      update_content: {
        content_updates: [{ old_str: 'A closing paragraph.', new_str: 'Edited for real.' }],
      },
    })

    const patch = h.requests.find((r) => r.method === 'PATCH')!
    expect(patch.query).toEqual({})
    expect(JSON.stringify(patch.body)).not.toContain('dry_run')
  })
})

describe('dry_run survives a client with a stale schema', () => {
  let h: Harness

  beforeAll(async () => {
    h = await withNotionMcp()
  })

  afterAll(async () => {
    await h.close()
  })

  beforeEach(() => {
    h.fake.reset()
  })

  it('honours dry_run nested inside update_content', async () => {
    // Found live: a connector validating the call against a cached tool schema
    // dropped the top-level dry_run, and the preview wrote to the page. The
    // nested flag rides inside an open object, so it is not stripped.
    const data = await callTool(h.client, 'API-update-page-markdown', {
      page_id: PAGE_ID,
      type: 'update_content',
      update_content: {
        dry_run: true,
        content_updates: [{ old_str: 'A closing paragraph.', new_str: 'Previewed only.' }],
      },
    })

    expect(data.object).toBe('page_markdown_dry_run')
    expect(data.written).toBe(false)
    expect(h.requests.some((r) => r.method === 'PATCH')).toBe(false)
    expect(h.fake.store.pageMarkdown).toContain('A closing paragraph.')
  })

  it('still writes when neither form is set', async () => {
    const data = await callTool(h.client, 'API-update-page-markdown', {
      page_id: PAGE_ID,
      type: 'update_content',
      update_content: {
        content_updates: [{ old_str: 'A closing paragraph.', new_str: 'Written for real.' }],
      },
    })

    expect(data.object).toBe('page_markdown_update')
    expect(h.requests.some((r) => r.method === 'PATCH')).toBe(true)
  })

  it('never forwards the nested flag to Notion', async () => {
    await callTool(h.client, 'API-update-page-markdown', {
      page_id: PAGE_ID,
      type: 'update_content',
      update_content: {
        dry_run: false,
        content_updates: [{ old_str: 'A closing paragraph.', new_str: 'Written for real.' }],
      },
    })
    const patch = h.requests.find((r) => r.method === 'PATCH')!
    expect(JSON.stringify(patch.body)).not.toContain('dry_run')
  })
})
