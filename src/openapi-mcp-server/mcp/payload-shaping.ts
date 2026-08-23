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
export const DRY_RUN = 'dry_run'

const PAYLOAD_PARAMS = [RETURN_CONTENT, FORMAT, MAX_BLOCKS, DRY_RUN]

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
  dryRun?: boolean
}

/** Strip the client-facing params so they are never sent to Notion. */
export function stripPayloadParams(params: Record<string, unknown>): Record<string, unknown> {
  const stripped = { ...params }
  for (const key of PAYLOAD_PARAMS) {
    delete stripped[key]
  }

  // `dry_run` is also accepted inside `update_content`, so it has to be removed
  // from there too — that object goes to Notion as the request body, and a
  // top-level-only strip would send it an argument it does not define.
  const updateContent = stripped.update_content
  if (typeof updateContent === 'object' && updateContent !== null && DRY_RUN in updateContent) {
    const { [DRY_RUN]: _dropped, ...rest } = updateContent as Record<string, unknown>
    stripped.update_content = rest
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
      // Accepted at the top level and nested inside `update_content`, and the
      // nested form is the one to trust. A client validating a call against a
      // cached tool schema drops properties that schema does not list, so a
      // newly added top-level `dry_run` is silently discarded and the "preview"
      // becomes a real write. `update_content` is an open object, so a nested
      // flag survives that stripping. Defaulting to *writing* is the wrong
      // failure mode for this particular parameter.
      const nested = params.update_content
      const nestedDryRun =
        typeof nested === 'object' && nested !== null && (nested as Record<string, unknown>)[DRY_RUN] === true
      return { returnContent, dryRun: params[DRY_RUN] === true || nestedDryRun }
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
export function addSectionHint(data: unknown, sectionRequested = false): unknown {
  if (!data || typeof data !== 'object') return data
  const record = data as Record<string, unknown>
  if (typeof record.markdown !== 'string' || record.truncated === true) return data
  const blocks = splitBlocks(record.markdown)
  if (blocks.length !== 1 || !MARKDOWN_HEADING.test(blocks[0])) return data

  // Telling a caller who already asked for `section` to ask for `section` is an
  // instruction to loop. Reaching here with sectionRequested means the section
  // could not be resolved, so say that instead — it is a different situation
  // with a different remedy.
  return {
    ...record,
    section_hint: sectionRequested
      ? 'This heading\'s section could not be resolved, so this is an ordinary read of the heading ' +
        'block alone. That happens when the heading text appears more than once on the page at the ' +
        'same level, or when it sits inside a container such as a toggle. Read the parent page and ' +
        'locate the section yourself, or edit the blocks by ID via Retrieve block children.'
      : 'This block is a heading, and its section is not nested beneath it — the content that follows ' +
        'this heading on the page is stored as its siblings. Re-read with format: "section" to get the ' +
        'heading together with the blocks under it.',
  }
}

/** Every index at which `needle` occurs in `haystack`. */
function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0
  let count = 0
  let from = 0
  for (;;) {
    const at = haystack.indexOf(needle, from)
    if (at < 0) return count
    count++
    from = at + needle.length
  }
}

/**
 * Apply a batch of content updates in memory and report what each one would do.
 *
 * This is the only check that sees the *page*. `validateContentUpdates`
 * compares the strings in a batch against each other and says so explicitly: it
 * cannot catch two anchors that are unrelated as strings but land next to each
 * other in the document. Simulating against the real text can — an anchor that
 * matched before an earlier edit ran and does not afterwards shows up here as a
 * miss, with nothing written.
 *
 * Edits are applied in order against a document each preceding edit has already
 * changed, because that is what Notion does server-side.
 */
export function simulateContentUpdates(
  markdown: string,
  updates: ContentUpdate[],
): { changes: Record<string, unknown>[]; result: string } {
  let document = markdown
  const changes: Record<string, unknown>[] = []

  updates.forEach((update, index) => {
    const matches = countOccurrences(document, update.old_str)
    if (matches === 0) {
      changes.push({
        index,
        matches: 0,
        would_apply: false,
        old_str: update.old_str,
        note:
          'No match at this point in the batch. Either the anchor is not on the page, or an earlier ' +
          'edit in this batch changed the text it was written against.',
      })
      return
    }

    const before = extractRegion(document, update.old_str)
    // A function replacement, so `$&` and friends in new_str stay literal.
    document = update.replace_all_matches
      ? document.split(update.old_str).join(update.new_str)
      : document.replace(update.old_str, () => update.new_str)
    const after = extractRegion(document, update.new_str)

    changes.push({
      index,
      matches,
      would_apply: true,
      ...(matches > 1 && !update.replace_all_matches
        ? { note: `Anchor occurs ${matches} times; only the first would be replaced.` }
        : {}),
      before,
      after,
    })
  })

  return { changes, result: document }
}

/** The response for a dry run: what would happen, with nothing written. */
export function shapeDryRun(pageId: string, markdown: string, updates: ContentUpdate[]): unknown {
  const { changes } = simulateContentUpdates(markdown, updates)
  const wouldApply = changes.filter((c) => c.would_apply).length
  return {
    object: 'page_markdown_dry_run',
    id: pageId,
    dry_run: true,
    written: false,
    edits: updates.length,
    would_apply: wouldApply,
    would_fail: updates.length - wouldApply,
    changes,
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
