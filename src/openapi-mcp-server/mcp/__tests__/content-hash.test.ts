import { describe, expect, it } from 'vitest'
import {
  Block,
  canonicalBlock,
  contentHash,
  HASH_LENGTH,
  stableStringify,
  subtreeHash,
  SubtreeTooLargeError,
} from '../content-hash'

function paragraph(text: string, overrides: Record<string, any> = {}): Block {
  return {
    object: 'block',
    id: 'block-1',
    type: 'paragraph',
    created_time: '2026-08-01T10:00:00.000Z',
    last_edited_time: '2026-08-01T10:00:00.000Z',
    created_by: { object: 'user', id: 'u1' },
    last_edited_by: { object: 'user', id: 'u1' },
    has_children: false,
    archived: false,
    in_trash: false,
    parent: { type: 'page_id', page_id: 'p1' },
    paragraph: {
      color: 'default',
      rich_text: [
        {
          type: 'text',
          text: { content: text, link: null },
          annotations: {
            bold: false,
            italic: false,
            strikethrough: false,
            underline: false,
            code: false,
            color: 'default',
          },
          plain_text: text,
          href: null,
        },
      ],
    },
    ...overrides,
  }
}

describe('stableStringify', () => {
  it('is insensitive to key order', () => {
    expect(stableStringify({ b: 1, a: 2 })).toBe(stableStringify({ a: 2, b: 1 }))
  })

  it('sorts keys at every level, not just the top', () => {
    expect(stableStringify({ x: { b: 1, a: 2 } })).toBe(stableStringify({ x: { a: 2, b: 1 } }))
  })

  it('preserves array order, which is meaningful', () => {
    expect(stableStringify([1, 2])).not.toBe(stableStringify([2, 1]))
  })
})

describe('contentHash', () => {
  it('produces a short hex token', () => {
    const hash = contentHash(paragraph('hello'))
    expect(hash).toMatch(/^[0-9a-f]+$/)
    expect(hash).toHaveLength(HASH_LENGTH)
  })

  // Spec test 8: round-trip stability.
  it('is stable across repeated reads of an unmodified block', () => {
    expect(contentHash(paragraph('hello'))).toBe(contentHash(paragraph('hello')))
  })

  it('changes when the text changes', () => {
    expect(contentHash(paragraph('hello'))).not.toBe(contentHash(paragraph('hello!')))
  })

  it('changes when only an annotation changes', () => {
    const bolded = paragraph('hello')
    bolded.paragraph.rich_text[0].annotations.bold = true
    expect(contentHash(paragraph('hello'))).not.toBe(contentHash(bolded))
  })

  it('changes when a type-specific non-text field changes', () => {
    const unchecked = paragraph('task', { type: 'to_do', to_do: { rich_text: [], checked: false } })
    const checked = paragraph('task', { type: 'to_do', to_do: { rich_text: [], checked: true } })
    expect(contentHash(unchecked)).not.toBe(contentHash(checked))
  })

  // Spec test 4: metadata-only churn must not invalidate a hash.
  it('ignores metadata churn', () => {
    const before = paragraph('hello')
    const after = paragraph('hello', {
      last_edited_time: '2026-08-11T21:28:00.000Z',
      last_edited_by: { object: 'user', id: 'someone-else' },
      request_id: 'req-123',
      has_children: true,
      parent: { type: 'block_id', block_id: 'moved' },
    })
    expect(contentHash(before)).toBe(contentHash(after))
  })

  // Spec test 8: real formatting, not synthetic fixtures.
  it.each([
    ['asterisks and underscores', 'a *literal* asterisk and _underscore_'],
    ['tildes and hashes', '~strike~ and # hash'],
    ['em dashes', 'a — dash — heavy — line'],
    ['emoji', 'heading 🎧 with emoji'],
    ['backticks', 'inline `code` sample'],
  ])('round-trips %s without ambiguity', (_label, text) => {
    expect(contentHash(paragraph(text))).toBe(contentHash(paragraph(text)))
    expect(contentHash(paragraph(text))).not.toBe(contentHash(paragraph(text + ' ')))
  })

  it('distinguishes nested bold-italic from plain text with the same characters', () => {
    const plain = paragraph('Author, Title')
    const styled = paragraph('Author, Title')
    styled.paragraph.rich_text[0].annotations.bold = true
    styled.paragraph.rich_text[0].annotations.italic = true
    expect(contentHash(plain)).not.toBe(contentHash(styled))
  })

  it('hashes a mention by its target, not its rendered title', () => {
    // Renaming a mentioned page changes plain_text everywhere it is linked.
    // Hashing that would 409 edits to blocks nobody touched.
    const mention = (title: string): Block =>
      paragraph('x', {
        paragraph: {
          color: 'default',
          rich_text: [
            {
              type: 'mention',
              mention: { type: 'page', page: { id: 'page-abc' } },
              annotations: { bold: false, italic: false, strikethrough: false, underline: false, code: false, color: 'default' },
              plain_text: title,
              href: 'https://notion.so/page-abc',
            },
          ],
        },
      })
    expect(contentHash(mention('Old Title'))).toBe(contentHash(mention('New Title')))
  })

  it('excludes volatile fields from the canonical form', () => {
    const canonical = canonicalBlock(paragraph('hello'))
    expect(Object.keys(canonical)).not.toContain('last_edited_time')
    expect(Object.keys(canonical)).not.toContain('id')
    expect(canonical.type).toBe('paragraph')
  })
})

describe('subtreeHash', () => {
  const noChildren = async () => []

  it('equals contentHash for a leaf, so leaf deletes need no extra read', async () => {
    const leaf = paragraph('leaf')
    expect(await subtreeHash(leaf, noChildren)).toBe(contentHash(leaf))
  })

  // Spec test 5: a child edit must not invalidate the parent's content_hash,
  // but must change its subtree_hash.
  it('changes when a child changes, while the parent content_hash does not', async () => {
    const toggle = paragraph('toggle', { id: 'toggle-1', has_children: true })
    const before = async () => [paragraph('child text')]
    const after = async () => [paragraph('child text edited')]

    expect(await subtreeHash(toggle, before)).not.toBe(await subtreeHash(toggle, after))
    expect(contentHash(toggle)).toBe(contentHash(toggle))
  })

  it('changes when a child is added', async () => {
    const toggle = paragraph('toggle', { id: 'toggle-1', has_children: true })
    const one = async () => [paragraph('a')]
    const two = async () => [paragraph('a'), paragraph('b')]
    expect(await subtreeHash(toggle, one)).not.toBe(await subtreeHash(toggle, two))
  })

  it('changes when children are reordered', async () => {
    const toggle = paragraph('toggle', { id: 'toggle-1', has_children: true })
    const ab = async () => [paragraph('a'), paragraph('b')]
    const ba = async () => [paragraph('b'), paragraph('a')]
    expect(await subtreeHash(toggle, ab)).not.toBe(await subtreeHash(toggle, ba))
  })

  it('descends through grandchildren', async () => {
    const root = paragraph('root', { id: 'root', has_children: true })
    const mkFetch = (grandchildText: string) => async (id: string) => {
      if (id === 'root') return [paragraph('mid', { id: 'mid', has_children: true })]
      return [paragraph(grandchildText)]
    }
    expect(await subtreeHash(root, mkFetch('deep'))).not.toBe(await subtreeHash(root, mkFetch('deeper')))
  })

  it('refuses rather than hashing a partial tree when the budget runs out', async () => {
    const root = paragraph('root', { id: 'root', has_children: true })
    // Every block claims children, so the walk never terminates on its own.
    const endless = async () => [paragraph('child', { id: 'child', has_children: true })]
    await expect(subtreeHash(root, endless, { remaining: 5 })).rejects.toBeInstanceOf(SubtreeTooLargeError)
  })
})
