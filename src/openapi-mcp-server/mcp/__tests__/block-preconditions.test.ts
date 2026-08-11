import { describe, expect, it, vi } from 'vitest'
import {
  annotateReadResponse,
  BlockReader,
  enforcePrecondition,
  PreconditionError,
  stripPreconditionParams,
} from '../block-preconditions'
import { Block, contentHash } from '../content-hash'

function paragraph(text: string, overrides: Record<string, any> = {}): Block {
  return {
    object: 'block',
    id: 'block-1',
    type: 'paragraph',
    last_edited_time: '2026-08-11T21:28:00.000Z',
    has_children: false,
    paragraph: {
      color: 'default',
      rich_text: [
        {
          type: 'text',
          text: { content: text, link: null },
          annotations: { bold: false, italic: false, strikethrough: false, underline: false, code: false, color: 'default' },
          plain_text: text,
          href: null,
        },
      ],
    },
    ...overrides,
  }
}

function readerFor(blocks: Record<string, Block>, children: Record<string, Block[]> = {}): BlockReader {
  return {
    retrieveBlock: vi.fn(async (id: string) => {
      const block = blocks[id]
      if (!block) throw new Error(`no such block ${id}`)
      return block
    }),
    listChildren: vi.fn(async (id: string) => children[id] ?? []),
  }
}

async function expectPrecondition(promise: Promise<unknown>): Promise<PreconditionError> {
  try {
    await promise
  } catch (error) {
    if (error instanceof PreconditionError) return error
    throw error
  }
  throw new Error('expected a PreconditionError')
}

describe('stripPreconditionParams', () => {
  // executeOperation puts any undeclared param straight into the request body,
  // so a hash that survives this far is sent to Notion and rejected.
  it('removes every server-side hash param', () => {
    const stripped = stripPreconditionParams({
      block_id: 'b1',
      expected_content_hash: 'aaa',
      expected_subtree_hash: 'bbb',
      expected_anchor_hash: 'ccc',
      paragraph: { rich_text: [] },
    })
    expect(stripped).toEqual({ block_id: 'b1', paragraph: { rich_text: [] } })
  })
})

describe('update-a-block', () => {
  // Spec test 1: happy path.
  it('proceeds when the hash matches, and forwards no hash to Notion', async () => {
    const current = paragraph('original')
    const reader = readerFor({ 'block-1': current })
    const forwarded = await enforcePrecondition(
      'update-a-block',
      { block_id: 'block-1', expected_content_hash: contentHash(current), paragraph: { rich_text: [] } },
      reader,
    )
    expect(forwarded).not.toHaveProperty('expected_content_hash')
    expect(forwarded).toHaveProperty('block_id', 'block-1')
  })

  // Spec test 2: stale write.
  it('rejects a stale hash with 409 carrying both hashes and the current content', async () => {
    const current = paragraph('edited by someone else')
    const reader = readerFor({ 'block-1': current })
    const error = await expectPrecondition(
      enforcePrecondition(
        'update-a-block',
        { block_id: 'block-1', expected_content_hash: 'a3f9c21b8e04d557', paragraph: { rich_text: [] } },
        reader,
      ),
    )
    expect(error.status).toBe(409)
    expect(error.payload).toMatchObject({
      code: 'stale_content_hash',
      block_id: 'block-1',
      expected_content_hash: 'a3f9c21b8e04d557',
      current_content_hash: contentHash(current),
      current_last_edited_time: '2026-08-11T21:28:00.000Z',
    })
    // Present so the caller can diff and retry without a blind re-read.
    expect(error.payload.current_content).toEqual(current)
  })

  // Spec test 3: same-minute race — the case last_edited_time cannot catch.
  it('catches a second write inside the same minute as the first', async () => {
    const original = paragraph('v1')
    const hashBothClientsRead = contentHash(original)

    // First writer succeeds; the block becomes v2 with a timestamp in the same
    // minute, so timestamps alone could not distinguish the two states.
    const afterFirstWrite = paragraph('v2', { last_edited_time: '2026-08-11T21:28:00.000Z' })
    expect(original.last_edited_time).toBe(afterFirstWrite.last_edited_time)

    const reader = readerFor({ 'block-1': afterFirstWrite })
    const error = await expectPrecondition(
      enforcePrecondition(
        'update-a-block',
        { block_id: 'block-1', expected_content_hash: hashBothClientsRead, paragraph: { rich_text: [] } },
        reader,
      ),
    )
    expect(error.status).toBe(409)
  })

  // Spec test 7: missing hash must never be a silent success.
  it.each([
    ['omitted', {}],
    ['empty', { expected_content_hash: '' }],
    ['whitespace', { expected_content_hash: '   ' }],
    ['not a string', { expected_content_hash: 12345 }],
  ])('rejects a %s hash with 400 and never reads or writes', async (_label, extra) => {
    const reader = readerFor({ 'block-1': paragraph('x') })
    const error = await expectPrecondition(
      enforcePrecondition('update-a-block', { block_id: 'block-1', ...extra }, reader),
    )
    expect(error.status).toBe(400)
    expect(error.payload.code).toBe('missing_content_hash')
    expect(reader.retrieveBlock).not.toHaveBeenCalled()
  })
})

describe('delete-a-block', () => {
  // Spec test 6: delete is guarded against the subtree, not just the block.
  it('rejects when a child arrived after the read, though the block itself is unchanged', async () => {
    const toggle = paragraph('toggle', { id: 'toggle-1', has_children: true })
    const hashBeforeChildAdded = contentHash(toggle) // leaf-equivalent at read time

    const reader = readerFor({ 'toggle-1': toggle }, { 'toggle-1': [paragraph('newly added child')] })
    const error = await expectPrecondition(
      enforcePrecondition(
        'delete-a-block',
        { block_id: 'toggle-1', expected_subtree_hash: hashBeforeChildAdded },
        reader,
      ),
    )
    expect(error.status).toBe(409)
    expect(error.payload.code).toBe('stale_subtree_hash')
  })

  it('proceeds for an unchanged subtree', async () => {
    const toggle = paragraph('toggle', { id: 'toggle-1', has_children: true })
    const children = { 'toggle-1': [paragraph('child')] }
    const reader = readerFor({ 'toggle-1': toggle }, children)

    const { subtreeHash } = await import('../content-hash')
    const current = await subtreeHash(toggle, async (id) => children[id as keyof typeof children] ?? [])

    const forwarded = await enforcePrecondition(
      'delete-a-block',
      { block_id: 'toggle-1', expected_subtree_hash: current },
      reader,
    )
    expect(forwarded).not.toHaveProperty('expected_subtree_hash')
  })

  it('requires the hash', async () => {
    const reader = readerFor({ 'block-1': paragraph('x') })
    const error = await expectPrecondition(
      enforcePrecondition('delete-a-block', { block_id: 'block-1' }, reader),
    )
    expect(error.status).toBe(400)
  })
})

describe('patch-block-children', () => {
  // Spec test 9: anchored insert with a stale anchor.
  it('rejects a stale anchor hash when `after` is supplied', async () => {
    const anchor = paragraph('anchor moved on', { id: 'anchor-1' })
    const reader = readerFor({ 'anchor-1': anchor })
    const error = await expectPrecondition(
      enforcePrecondition(
        'patch-block-children',
        { block_id: 'parent-1', after: 'anchor-1', expected_anchor_hash: 'stale00000000000', children: [] },
        reader,
      ),
    )
    expect(error.status).toBe(409)
    expect(error.payload.code).toBe('stale_anchor_hash')
  })

  it('accepts a matching anchor hash', async () => {
    const anchor = paragraph('anchor', { id: 'anchor-1' })
    const reader = readerFor({ 'anchor-1': anchor })
    const forwarded = await enforcePrecondition(
      'patch-block-children',
      { block_id: 'parent-1', after: 'anchor-1', expected_anchor_hash: contentHash(anchor), children: [] },
      reader,
    )
    expect(forwarded).not.toHaveProperty('expected_anchor_hash')
    expect(forwarded).toHaveProperty('after', 'anchor-1')
  })

  it('requires no hash when appending at the end, because appending destroys nothing', async () => {
    const reader = readerFor({})
    const forwarded = await enforcePrecondition(
      'patch-block-children',
      { block_id: 'parent-1', children: [] },
      reader,
    )
    expect(forwarded).toEqual({ block_id: 'parent-1', children: [] })
    expect(reader.retrieveBlock).not.toHaveBeenCalled()
  })

  it('requires the anchor hash once `after` is supplied', async () => {
    const reader = readerFor({ 'anchor-1': paragraph('anchor', { id: 'anchor-1' }) })
    const error = await expectPrecondition(
      enforcePrecondition('patch-block-children', { block_id: 'parent-1', after: 'anchor-1', children: [] }, reader),
    )
    expect(error.status).toBe(400)
  })
})

describe('unguarded operations', () => {
  it('leaves update-page-markdown alone — it is the bulk escape hatch', async () => {
    const reader = readerFor({})
    const params = { page_id: 'p1', type: 'replace_content', replace_content: { content: '# hi' } }
    expect(await enforcePrecondition('update-page-markdown', params, reader)).toEqual(params)
    expect(reader.retrieveBlock).not.toHaveBeenCalled()
  })
})

describe('annotateReadResponse', () => {
  // Spec §3: every read path that exposes a block must return a hash, or
  // callers route around the guard via the path that does not.
  it('adds content_hash to every child of a listing', async () => {
    const reader = readerFor({})
    const listing = { object: 'list', results: [paragraph('a'), paragraph('b', { id: 'block-2' })] }
    const annotated: any = await annotateReadResponse('get-block-children', listing, reader)
    expect(annotated.results.map((b: any) => b.content_hash)).toEqual([
      contentHash(paragraph('a')),
      contentHash(paragraph('b', { id: 'block-2' })),
    ])
  })

  it('does not walk subtrees for a listing, keeping reads to a single call', async () => {
    const reader = readerFor({})
    const listing = { object: 'list', results: [paragraph('a', { has_children: true })] }
    const annotated: any = await annotateReadResponse('get-block-children', listing, reader)
    expect(reader.listChildren).not.toHaveBeenCalled()
    expect(annotated.results[0]).not.toHaveProperty('subtree_hash')
  })

  it('adds both hashes to a single retrieved block', async () => {
    const block = paragraph('solo')
    const reader = readerFor({ 'block-1': block })
    const annotated: any = await annotateReadResponse('retrieve-a-block', block, reader)
    expect(annotated.content_hash).toBe(contentHash(block))
    expect(annotated.subtree_hash).toBe(contentHash(block)) // leaf
  })

  it('reports an unhashable subtree instead of failing the read', async () => {
    const root = paragraph('root', { id: 'root', has_children: true })
    const reader: BlockReader = {
      retrieveBlock: async () => root,
      listChildren: async () => [paragraph('child', { id: 'child', has_children: true })],
    }
    const annotated: any = await annotateReadResponse('retrieve-a-block', root, reader)
    expect(annotated.content_hash).toBe(contentHash(root))
    expect(annotated.subtree_hash).toBeNull()
    expect(annotated.subtree_hash_error).toMatch(/too large/i)
  })

  it('returns the new hash after a write so the caller can chain edits', async () => {
    const updated = paragraph('now says this')
    const reader = readerFor({})
    const annotated: any = await annotateReadResponse('update-a-block', updated, reader)
    expect(annotated.content_hash).toBe(contentHash(updated))
  })

  it('leaves unrelated responses untouched', async () => {
    const reader = readerFor({})
    const data = { object: 'user', id: 'u1' }
    expect(await annotateReadResponse('retrieve-a-user', data, reader)).toEqual(data)
  })
})
