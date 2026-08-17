import { describe, expect, it } from 'vitest'
import { extractRegion, shapeMarkdownRead, shapeUpdateResponse, splitBlocks } from '../payload-shaping'

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
