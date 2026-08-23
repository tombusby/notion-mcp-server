import { Block, contentHash } from './content-hash'
import { BlockReader } from './block-preconditions'
import { ContentUpdate } from './content-updates'

/**
 * Response payload shaping for the page-markdown operations.
 *
 * Both markdown endpoints return the *whole page*, on every call. A three-edit
 * session against a 15,000-word page therefore returns ~45,000 words to change
 * three paragraphs the caller already had in hand.
 *
 * The cost is not merely comfort. Large responses evict earlier reads from the
 * caller's context; an evicted read means the caller no longer holds the page
 * state it was working from; and an edit written from a half-remembered page is
 * exactly the stale write the content-hash preconditions exist to refuse. The
 * markdown path cannot be guarded by a hash, so on that path the eviction is
 * not caught at all.
 *
 * There is a second-order effect worth naming, because it is the one that
 * actually changes behaviour. The *safe* editing path (`update-a-block`, which
 * takes structured rich text and is immune to markdown escaping) needs a block
 * ID, and getting a block ID needed a full-page read. Making the read expensive
 * pushed callers onto the unsafe path. `format: "outline"` below is the cheap
 * entry point that removes that pressure: outline -> scoped read -> block edit,
 * with no full-page read anywhere in the sequence.
 *
 * What is deliberately not attempted here: annotating rendered markdown with
 * block IDs. Notion returns markdown as an opaque string with no block
 * correspondence, so emitting `<!--b:...-->` markers would mean fetching the
 * block tree separately and aligning it against serialised text — reintroducing
 * the text-matching fragility that block addressing exists to abolish. The
 * outline gives the same destination by a route that cannot silently misalign.
 *
 * Likewise not attempted: the markdown escaping bug (`**Author**, *Title*`
 * returning as `**Author, \*Title**\*`). That corruption is produced by
 * Notion's own serialiser — the stored blocks are correct, as `get-block-children`
 * shows — so it is not fixable from this side. It is why `verified: false`
 * below says "may have been applied with different escaping" rather than
 * "failed".
 */

/** Client-facing parameters, consumed here and never forwarded to Notion. */
export const RETURN_CONTENT = 'return_content'
export const FORMAT = 'format'
export const MAX_BLOCKS = 'max_blocks'

const PAYLOAD_PARAMS = [RETURN_CONTENT, FORMAT, MAX_BLOCKS]

export type ReturnContent = 'changed' | 'none' | 'full'

/**
 * How much of a changed region to echo back. Large enough to show a whole
 * ordinary paragraph — which is what makes the echo useful for spotting
 * escaping corruption — and small enough that a batch of edits cannot
 * reconstitute the page.
 */
const REGION_CHARS = 600

/** Requests the outline walk may spend before it gives up and says so. */
const OUTLINE_REQUEST_BUDGET = 25

const HEADING_LEVELS: Record<string, number> = {
  heading_1: 1,
  heading_2: 2,
  heading_3: 3,
}

/**
 * Container types worth descending into when building an outline. Headings
 * usually sit at the top level, but a page built from collapsed toggles hides
 * them one level down, and an outline that missed them would send the caller
 * straight back to a full read.
 */
const OUTLINE_CONTAINERS = new Set([
  'toggle',
  'callout',
  'quote',
  'column_list',
  'column',
  'synced_block',
  'heading_1',
  'heading_2',
  'heading_3',
])

export interface PayloadOptions {
  returnContent?: ReturnContent
  format?: 'markdown' | 'outline' | 'section'
  maxBlocks?: number
}

/** Strip the client-facing params so they are never sent to Notion. */
export function stripPayloadParams(params: Record<string, unknown>): Record<string, unknown> {
  const stripped = { ...params }
  for (const key of PAYLOAD_PARAMS) {
    delete stripped[key]
  }
  return stripped
}

/**
 * Read the shaping options off a call.
 *
 * `return_content` defaults to `"changed"` for a find-and-replace update and
 * `"none"` for a whole-page replace: after `replace_content` the caller just
 * supplied the entire content, so echoing it back tells them nothing they did
 * not just write.
 */
export function readPayloadOptions(
  operationId: string | undefined,
  params: Record<string, unknown>,
  contentUpdates: ContentUpdate[] | null,
): PayloadOptions {
  switch (operationId) {
    case 'update-page-markdown': {
      const raw = params[RETURN_CONTENT]
      const returnContent =
        raw === 'changed' || raw === 'none' || raw === 'full' ? raw : contentUpdates ? 'changed' : 'none'
      return { returnContent }
    }

    case 'retrieve-page-markdown': {
      const raw = params[FORMAT]
      const format = raw === 'outline' || raw === 'section' ? raw : 'markdown'
      const rawMax = params[MAX_BLOCKS]
      const maxBlocks = typeof rawMax === 'number' && Number.isFinite(rawMax) && rawMax > 0 ? Math.floor(rawMax) : undefined
      return { format, maxBlocks }
    }

    default:
      return {}
  }
}

function plainText(block: Block): string {
  const payload = block?.type ? block[block.type] : undefined
  const richText = payload?.rich_text
  if (!Array.isArray(richText)) return ''
  return richText.map((item: any) => item?.plain_text ?? item?.text?.content ?? '').join('')
}

interface OutlineEntry {
  block_id: string
  type: string
  level: number
  text: string
  content_hash: string
  /**
   * Sibling blocks belonging to this section: the blocks that follow the
   * heading up to the next heading at the same or a higher level. It is a size
   * signal for deciding whether to read the section, not a subtree count — a
   * recursive count would cost the very requests the outline exists to save.
   */
  section_blocks: number
  /** True when the heading is toggleable and holds its section as children. */
  has_children: boolean
}

/**
 * Build a headings-only view of a page, with the block IDs and content hashes
 * needed to read and then edit a section directly.
 *
 * This deliberately does not call the markdown endpoint at all. Asking Notion
 * for the page and then discarding the body would pay the whole cost the
 * outline exists to avoid; walking the block tree pays one request per
 * container instead, and the walk is bounded.
 */
export async function buildOutline(
  rootId: string,
  reader: BlockReader,
): Promise<Record<string, unknown>> {
  const outline: OutlineEntry[] = []
  const budget = { remaining: OUTLINE_REQUEST_BUDGET }

  await walkForHeadings(rootId, reader, budget, outline)

  return {
    object: 'page_outline',
    id: rootId,
    outline,
    // A truncated outline that did not say so would be read as "this page has
    // no further headings", which is the one wrong answer worth guarding.
    truncated: budget.remaining <= 0,
    ...(budget.remaining <= 0
      ? {
          truncation_note:
            `Outline walk stopped after ${OUTLINE_REQUEST_BUDGET} requests; deeper containers were not expanded. ` +
            `Call this again with a block ID from the outline to expand that section.`,
        }
      : {}),
  }
}

async function walkForHeadings(
  parentId: string,
  reader: BlockReader,
  budget: { remaining: number },
  outline: OutlineEntry[],
): Promise<void> {
  if (budget.remaining <= 0) return
  budget.remaining -= 1

  const siblings = await reader.listChildren(parentId)

  siblings.forEach((block, index) => {
    const level = HEADING_LEVELS[block?.type]
    if (!level) return
    outline.push({
      block_id: block.id,
      type: block.type,
      level,
      text: plainText(block),
      content_hash: contentHash(block),
      section_blocks: countSectionBlocks(siblings, index, level),
      has_children: Boolean(block.has_children),
    })
  })

  for (const block of siblings) {
    if (!block?.has_children || !OUTLINE_CONTAINERS.has(block.type)) continue
    await walkForHeadings(block.id, reader, budget, outline)
    if (budget.remaining <= 0) return
  }
}

/** Blocks between this heading and the next one at the same or a higher level. */
function countSectionBlocks(siblings: Block[], headingIndex: number, level: number): number {
  let count = 0
  for (let i = headingIndex + 1; i < siblings.length; i++) {
    const nextLevel = HEADING_LEVELS[siblings[i]?.type]
    if (nextLevel && nextLevel <= level) break
    count++
  }
  return count
}

/**
 * Split rendered page markdown into blocks.
 *
 * Notion separates blocks with a **single** newline, not a blank line. This is
 * worth stating plainly because the obvious assumption is the opposite one, and
 * getting it wrong is silent: splitting on blank lines yields one enormous
 * "block" spanning the whole page, so a receipt would echo the document it
 * exists to omit and `max_blocks` would never truncate anything. Verified
 * against a real page rather than assumed.
 *
 * Two constructs do span lines and must not be split apart: toggles render as
 * `<details>…</details>` with tab-indented children, and tables render as
 * `<table>…</table>` with a line per cell. Both are accumulated whole.
 */
export function splitBlocks(markdown: string): string[] {
  const blocks: string[] = []
  let open: { lines: string[]; closer: string } | null = null

  for (const line of markdown.split('\n')) {
    if (open) {
      open.lines.push(line)
      if (line.trimStart().startsWith(open.closer)) {
        blocks.push(open.lines.join('\n'))
        open = null
      }
      continue
    }

    const trimmed = line.trimStart()
    if (trimmed.startsWith('<details')) {
      open = { lines: [line], closer: '</details>' }
      continue
    }
    if (trimmed.startsWith('<table')) {
      open = { lines: [line], closer: '</table>' }
      continue
    }
    // Blank lines are separators, not content.
    if (line.trim() === '') continue
    blocks.push(line)
  }

  // An unterminated container still has to come back, or content vanishes.
  if (open) blocks.push(open.lines.join('\n'))

  return blocks
}

/**
 * Locate `needle` in the updated markdown and return the block containing it.
 *
 * Note this is verification of a write that has already happened, never
 * targeting: nothing is addressed by the result, so a miss costs an unverified
 * flag rather than a wrong edit.
 */
export function extractRegion(markdown: string, needle: string, maxChars = REGION_CHARS): string | null {
  if (!needle) return null
  if (!markdown.includes(needle)) return null

  // The needle may itself span blocks (a multi-line replacement), so match on
  // the first block containing any of its lines and return that block.
  const firstLine = needle.split('\n').find((l) => l.trim() !== '') ?? needle
  const region = splitBlocks(markdown).find((b) => b.includes(firstLine))
  if (region === undefined) return null
  if (region.length <= maxChars) return region

  // Clip around the match rather than from the start of the block, so the text
  // the caller just wrote is always the part they get to see.
  const matchAt = Math.max(0, region.indexOf(firstLine))
  const half = Math.floor((maxChars - Math.min(firstLine.length, maxChars)) / 2)
  const clipStart = Math.max(0, matchAt - half)
  const clipEnd = Math.min(region.length, clipStart + maxChars)
  return (clipStart > 0 ? '…' : '') + region.slice(clipStart, clipEnd) + (clipEnd < region.length ? '…' : '')
}

/**
 * Reduce an `update-page-markdown` response from the whole page to a receipt.
 *
 * The changed regions are echoed rather than dropped entirely: they are what
 * lets a caller confirm the write landed as intended — including catching
 * escaping corruption at the moment it happens — without a re-read. On a
 * find-and-replace that is typically one paragraph rather than fifteen thousand
 * words.
 */
export function shapeUpdateResponse(
  data: unknown,
  contentUpdates: ContentUpdate[] | null,
  returnContent: ReturnContent,
): unknown {
  if (returnContent === 'full' || !data || typeof data !== 'object') {
    return data
  }

  const source = data as Record<string, unknown>
  const markdown = typeof source.markdown === 'string' ? source.markdown : ''

  const receipt: Record<string, unknown> = {
    object: 'page_markdown_update',
    id: source.id ?? null,
    markdown_omitted: true,
  }
  if (source.truncated !== undefined) receipt.truncated = source.truncated
  if (Array.isArray(source.unknown_block_ids) && source.unknown_block_ids.length > 0) {
    receipt.unknown_block_ids = source.unknown_block_ids
  }

  if (!contentUpdates) {
    receipt.note = `Page content updated. Pass return_content: "full" to receive the whole page.`
    return receipt
  }

  const changed = contentUpdates.map((update, index) => {
    const region = markdown ? extractRegion(markdown, update?.new_str ?? '') : null
    return region !== null
      ? { index, verified: true, markdown: region }
      : {
          index,
          verified: false,
          old_str: update?.old_str ?? null,
          note:
            `Replacement text was not found verbatim in the updated page. The edit may still have been ` +
            `applied with different escaping — Notion's markdown serialiser does not always round-trip ` +
            `characters such as *, ~ and #. Read the block by ID to confirm.`,
        }
  })

  const verified = changed.filter((c) => c.verified).length
  receipt.edits = changed.length
  receipt.verified = verified
  receipt.unverified = changed.length - verified
  if (returnContent === 'changed') {
    receipt.changed = changed
  }
  return receipt
}

/**
 * Cap a markdown read at `maxBlocks` blocks.
 *
 * Notion has no server-side limit to ask for, so this trims on arrival. That
 * saves no bandwidth and every token — and tokens are what the caller actually
 * runs out of.
 */
/** A rendered Markdown heading: the hashes, then the text. */
const MARKDOWN_HEADING = /^(#{1,6})\s+(.*)$/

/**
 * Compare heading text across the block/Markdown boundary.
 *
 * The rendered form escapes literal punctuation (`~` becomes `\~`) and may
 * differ in whitespace, so a byte comparison against the block's `plain_text`
 * would miss. Both sides are unescaped and whitespace-collapsed instead.
 */
function normaliseHeading(text: string): string {
  return text.replace(/\\(.)/g, '$1').replace(/\s+/g, ' ').trim()
}

/** The heading level and plain text of a block, or null if it is not a heading. */
export function headingOf(block: any): { level: number; text: string } | null {
  const level = HEADING_LEVELS[block?.type]
  if (!level) return null
  const richText = block?.[block.type]?.rich_text ?? []
  const text = richText.map((run: any) => run?.plain_text ?? run?.text?.content ?? '').join('')
  return { level, text }
}

/**
 * Cut one heading's section out of a page's rendered Markdown.
 *
 * A section is the heading plus every following block up to the next heading of
 * the same or a higher level — which is what the outline's `section_blocks`
 * counts. It cannot be had by reading the heading's own block ID: Notion
 * headings are *siblings* of the content beneath them, not parents of it, so
 * that read returns the heading line alone.
 *
 * Returns null rather than guessing when the heading cannot be located
 * unambiguously — absent, or repeated verbatim elsewhere on the page. A wrong
 * section returned confidently is worse than an honest fallback to the block's
 * own content.
 */
export function sliceSection(markdown: string, level: number, text: string): { markdown: string; blocks: number } | null {
  const blocks = splitBlocks(markdown)
  const wanted = normaliseHeading(text)

  const starts: number[] = []
  blocks.forEach((block, index) => {
    const match = MARKDOWN_HEADING.exec(block)
    if (match && match[1].length === level && normaliseHeading(match[2]) === wanted) {
      starts.push(index)
    }
  })
  if (starts.length !== 1) return null

  const start = starts[0]
  let end = blocks.length
  for (let i = start + 1; i < blocks.length; i++) {
    const match = MARKDOWN_HEADING.exec(blocks[i])
    if (match && match[1].length <= level) {
      end = i
      break
    }
  }

  const section = blocks.slice(start, end)
  return { markdown: section.join('\n'), blocks: section.length }
}

/**
 * Note a lone-heading result, which is almost always a caller expecting a
 * section read. Costs nothing: it is read off the response we already have.
 */
export function addSectionHint(data: unknown): unknown {
  if (!data || typeof data !== 'object') return data
  const record = data as Record<string, unknown>
  if (typeof record.markdown !== 'string' || record.truncated === true) return data
  const blocks = splitBlocks(record.markdown)
  if (blocks.length !== 1 || !MARKDOWN_HEADING.test(blocks[0])) return data
  return {
    ...record,
    section_hint:
      'This block is a heading, and its section is not nested beneath it — the content that follows ' +
      'this heading on the page is stored as its siblings. Re-read with format: "section" to get the ' +
      'heading together with the blocks under it.',
  }
}

export function shapeMarkdownRead(data: unknown, maxBlocks: number | undefined): unknown {
  if (maxBlocks === undefined || !data || typeof data !== 'object') {
    return data
  }
  const source = data as Record<string, unknown>
  if (typeof source.markdown !== 'string') return data

  const blocks = splitBlocks(source.markdown)
  if (blocks.length <= maxBlocks) return data

  return {
    ...source,
    markdown: blocks.slice(0, maxBlocks).join('\n'),
    truncated: true,
    omitted_blocks: blocks.length - maxBlocks,
    truncation_note:
      `Showing the first ${maxBlocks} of ${blocks.length} blocks. Use format: "outline" to locate a ` +
      `section, then read it by passing its block ID as page_id with format: "section".`,
  }
}
