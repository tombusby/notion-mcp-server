import { describe, expect, it } from 'vitest'
import { addSectionHint, extractRegion, headingOf, shapeMarkdownRead, shapeUpdateResponse, sliceSection, splitBlocks } from '../payload-shaping'

/**
 * Unit tests over a corpus captured verbatim from a real Notion page.
 *
 * The string below is the exact `markdown` field returned by
 * `GET /v1/pages/{id}/markdown` for a page containing the constructs the specs
 * name as failure-prone: emoji headings, nested bold-italic bibliography lines,
 * literal `*` `~` `#`, em dashes, a collapsed toggle and a table.
 *
 * It is a fixture rather than a fake because the wire tests cannot supply this:
 * their backend encodes our belief about Notion's rendering, and that belief was
 * wrong in exactly the way that matters here — blocks are separated by a single
 * newline, not a blank line. Every test agreed with the code because both made
 * the same assumption. Keeping the real bytes in the suite is what stops that
 * recurring.
 */
const REAL_PAGE = [
  '# 🧭 Routes in',
  'This page exists to test the forked Notion MCP against real content. Nothing here is meaningful; it is shaped to reproduce known failure modes.',
  '## 📚 Bibliography lines',
  '**Krafft-Ebing**, *Psychopathia Sexualis* (1886) — the nested bold-italic pattern that broke round-tripping.',
  '**Ellis**, *Studies in the Psychology of Sex* (1897) — a second line, so a batch has two nearby anchors.',
  '## ⚠️ Literal punctuation',
  'A span of \\~140 years, a literal # in prose, and an asterisk \\* standing alone.',
  'A paragraph with *italic* and **bold** adjacent, which is the run-boundary case.',
  '## 🗂️ A collapsed toggle',
  '<details>',
  '<summary>Hidden section</summary>',
  '\t### A heading inside the toggle',
  '\tA paragraph nested one level down, to prove the outline descends.',
  '</details>',
  '## 📊 A table',
  '<table header-row="true">',
  '<tr>',
  '<td>Addressing</td>',
  '<td>Stale read leads to</td>',
  '</tr>',
  '<tr>',
  '<td>old_str</td>',
  '<td>No-op. Loud, harmless.</td>',
  '</tr>',
  '</table>',
  '## 🧵 Closing',
  'A final paragraph, well separated from everything above.',
].join('\n')

describe('splitBlocks, against a real page', () => {
  it('finds one block per line, with containers kept whole', () => {
    const blocks = splitBlocks(REAL_PAGE)

    // 12 single-line blocks, plus the <details> and the <table>.
    expect(blocks).toHaveLength(14)
    expect(blocks[0]).toBe('# 🧭 Routes in')
    expect(blocks.filter((b) => b.startsWith('<details'))).toHaveLength(1)
    expect(blocks.filter((b) => b.startsWith('<table'))).toHaveLength(1)
  })

  it('keeps the toggle and its indented children together', () => {
    const toggle = splitBlocks(REAL_PAGE).find((b) => b.startsWith('<details'))!
    expect(toggle).toContain('<summary>Hidden section</summary>')
    expect(toggle).toContain('\t### A heading inside the toggle')
    expect(toggle.endsWith('</details>')).toBe(true)
  })

  it('keeps every table row in one block', () => {
    const table = splitBlocks(REAL_PAGE).find((b) => b.startsWith('<table'))!
    expect(table.match(/<tr>/g)).toHaveLength(2)
    expect(table.endsWith('</table>')).toBe(true)
  })

  it('does not split on blank lines, which the page does not use', () => {
    expect(REAL_PAGE).not.toContain('\n\n')
    // The assumption this guards: blank-line splitting yields one block.
    expect(REAL_PAGE.split(/\n{2,}/)).toHaveLength(1)
    expect(splitBlocks(REAL_PAGE).length).toBeGreaterThan(1)
  })
})

describe('extractRegion, against a real page', () => {
  it('returns just the paragraph that changed, not the page', () => {
    const region = extractRegion(REAL_PAGE, 'A final paragraph, well separated from everything above.')
    expect(region).toBe('A final paragraph, well separated from everything above.')
  })

  it('returns the bibliography line alone, escaping and all', () => {
    const region = extractRegion(REAL_PAGE, '*Psychopathia Sexualis* (1886)')
    expect(region).toBe(
      '**Krafft-Ebing**, *Psychopathia Sexualis* (1886) — the nested bold-italic pattern that broke round-tripping.',
    )
  })

  it('returns the whole container when the edit lands inside a toggle', () => {
    const region = extractRegion(REAL_PAGE, 'A paragraph nested one level down')!
    expect(region.startsWith('<details>')).toBe(true)
    expect(region.endsWith('</details>')).toBe(true)
  })

  it('reports a miss rather than guessing', () => {
    expect(extractRegion(REAL_PAGE, 'text that is not on the page')).toBeNull()
  })
})

describe('receipts stay small on real content', () => {
  it('omits the page and echoes only the changed line', () => {
    const receipt = shapeUpdateResponse(
      { object: 'page_markdown', id: 'p1', markdown: REAL_PAGE, truncated: false },
      [{ old_str: 'A final paragraph', new_str: 'A final paragraph, well separated from everything above.' }],
      'changed',
    ) as any

    expect(receipt.verified).toBe(1)
    expect(receipt.changed[0].markdown).toBe('A final paragraph, well separated from everything above.')

    const text = JSON.stringify(receipt)
    expect(text).not.toContain('Krafft-Ebing')
    expect(text).not.toContain('Routes in')
    expect(text.length).toBeLessThan(REAL_PAGE.length / 2)
  })

  it('truncates a real page at a block boundary', () => {
    const trimmed = shapeMarkdownRead({ object: 'page_markdown', markdown: REAL_PAGE }, 3) as any
    expect(trimmed.markdown).toBe(
      ['# 🧭 Routes in', splitBlocks(REAL_PAGE)[1], '## 📚 Bibliography lines'].join('\n'),
    )
    expect(trimmed.omitted_blocks).toBe(11)
  })
})

describe('sliceSection, against a real page shape', () => {
  // Notion headings are siblings of their content, never parents. This fixture
  // is deliberately FLAT for that reason: the wire test's fake nested content
  // under headings, which is why it could not catch the defect this covers.
  const FLAT = [
    '# Top',
    'Intro paragraph.',
    '## First section',
    'Body of first.',
    'More of first.',
    '### Nested under first',
    'Body of nested.',
    '## Second section',
    'Body of second.',
  ].join('\n')

  it('returns the heading plus its siblings, stopping at the next peer heading', () => {
    const section = sliceSection(FLAT, 2, 'First section')!
    expect(section.blocks).toBe(5)
    expect(section.markdown).toBe(
      ['## First section', 'Body of first.', 'More of first.', '### Nested under first', 'Body of nested.'].join('\n'),
    )
  })

  it('stops at a higher-level heading, not only an equal one', () => {
    const section = sliceSection(FLAT, 3, 'Nested under first')!
    expect(section.markdown).toBe(['### Nested under first', 'Body of nested.'].join('\n'))
  })

  it('runs to the end of the page when nothing closes the section', () => {
    const section = sliceSection(FLAT, 2, 'Second section')!
    expect(section.blocks).toBe(2)
  })

  it('takes the whole page for a top-level heading', () => {
    expect(sliceSection(FLAT, 1, 'Top')!.blocks).toBe(9)
  })

  it('matches through the escaping the renderer adds', () => {
    // The block stores `~140 years`; the Markdown comes back `\~140 years`.
    const page = ['## \\~140 years', 'Body.'].join('\n')
    expect(sliceSection(page, 2, '~140 years')!.blocks).toBe(2)
  })

  it('refuses rather than guessing when a heading is repeated', () => {
    const page = ['## Notes', 'One.', '## Other', 'Two.', '## Notes', 'Three.'].join('\n')
    expect(sliceSection(page, 2, 'Notes')).toBeNull()
  })

  it('refuses when the heading is not on the page at all', () => {
    expect(sliceSection(FLAT, 2, 'Nonexistent')).toBeNull()
  })

  it('does not mistake a heading inside a container for a top-level one', () => {
    expect(sliceSection(REAL_PAGE, 3, 'A heading inside the toggle')).toBeNull()
  })
})

describe('headingOf', () => {
  it('reads level and text off a heading block', () => {
    expect(headingOf({ type: 'heading_2', heading_2: { rich_text: [{ plain_text: 'What landed' }] } })).toEqual({
      level: 2,
      text: 'What landed',
    })
  })

  it('joins runs, so formatting does not split the text', () => {
    const block = { type: 'heading_1', heading_1: { rich_text: [{ plain_text: 'Bold' }, { plain_text: ' and rest' }] } }
    expect(headingOf(block)!.text).toBe('Bold and rest')
  })

  it('returns null for anything that is not a heading', () => {
    expect(headingOf({ type: 'paragraph', paragraph: { rich_text: [] } })).toBeNull()
  })
})

describe('addSectionHint', () => {
  it('flags a lone heading, which is the shape that confuses callers', () => {
    const hinted = addSectionHint({ object: 'page_markdown', markdown: '## 6. What sets valence?' }) as any
    expect(hinted.section_hint).toContain('format: "section"')
  })

  it('says nothing when the read returned real content', () => {
    const hinted = addSectionHint({ object: 'page_markdown', markdown: '## Heading\nBody.' }) as any
    expect(hinted.section_hint).toBeUndefined()
  })

  it('says nothing about a lone paragraph', () => {
    expect((addSectionHint({ object: 'page_markdown', markdown: 'Just a paragraph.' }) as any).section_hint).toBeUndefined()
  })
})

describe('addSectionHint does not tell a caller to repeat what they just did', () => {
  const loneHeading = { object: 'page_markdown', markdown: '## Notes' }

  it('suggests format: "section" to a caller who did not use it', () => {
    expect((addSectionHint(loneHeading) as any).section_hint).toContain('Re-read with format: "section"')
  })

  it('explains the fallback instead when format: "section" was already requested', () => {
    // Live testing found this: a repeated heading falls back to an ordinary
    // read, and the old hint told the caller to retry with the exact parameter
    // they had just used — an instruction to loop.
    const hint = (addSectionHint(loneHeading, true) as any).section_hint
    expect(hint).toContain('could not be resolved')
    expect(hint).toContain('more than once')
    expect(hint).not.toContain('Re-read with format: "section"')
  })
})
