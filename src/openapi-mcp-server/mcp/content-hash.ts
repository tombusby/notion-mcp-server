import { createHash } from 'node:crypto'

/**
 * Content hashes for optimistic concurrency on block writes.
 *
 * Block IDs never expire, so a client that read a block on Monday can write to
 * it on Friday: the ID resolves, the write lands, and whatever the block held
 * in the meantime is destroyed silently. Notion's REST API offers no
 * conditional writes, so the precondition has to live here.
 *
 * The server computes a hash on read and verifies it on write. The client only
 * ever echoes an opaque token back — it never constructs, parses or reproduces
 * one. That is what separates this from the old `old_str` approach, where the
 * caller had to reproduce prior content exactly and escaping bugs became
 * targeting bugs.
 */

/**
 * Hashes are truncated for readability in errors and logs. Collision risk is
 * negligible here: a collision would have to occur between two versions of the
 * *same block*, and the consequence is one unguarded write rather than a
 * general integrity failure.
 */
export const HASH_LENGTH = 16

/**
 * Block-level fields excluded from the hash.
 *
 * These change without the content changing — Notion touches `last_edited_time`
 * on unrelated operations, and `has_children` flips when a child is added even
 * though the block's own content is untouched. Including them would produce
 * spurious 409s and train callers to retry blindly, which defeats the guard.
 *
 * `archived` / `in_trash` are excluded per spec: trashing is not a content
 * edit, and a trashed block fails the write with 404 anyway.
 */
const VOLATILE_BLOCK_FIELDS = new Set([
  'object',
  'id',
  'created_time',
  'last_edited_time',
  'created_by',
  'last_edited_by',
  'has_children',
  'archived',
  'in_trash',
  'parent',
  'request_id',
  'developer_survey',
])

export type RichTextItem = Record<string, any>
export type Block = Record<string, any>

/**
 * Deterministic JSON: object keys sorted at every level, no insignificant
 * whitespace. Two structurally equal values must always serialise identically,
 * or the hash is worthless.
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null'
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`)
  return `{${entries.join(',')}}`
}

/**
 * Project one rich-text item onto the parts that represent authored content.
 *
 * `plain_text` is deliberately not used as the content source for mentions:
 * Notion resolves it to the mentioned page's current title, so renaming a
 * linked page elsewhere in the workspace would change this block's hash and
 * 409 an edit that has nothing to do with the rename. The mention's own
 * payload (the referenced ID) is stable and is what actually identifies the
 * content.
 */
export function canonicalRichTextItem(item: RichTextItem): Record<string, unknown> {
  const annotations = item?.annotations ?? {}
  const canonical: Record<string, unknown> = {
    annotations: {
      bold: Boolean(annotations.bold),
      italic: Boolean(annotations.italic),
      strikethrough: Boolean(annotations.strikethrough),
      underline: Boolean(annotations.underline),
      code: Boolean(annotations.code),
      color: annotations.color ?? 'default',
    },
    href: item?.href ?? null,
  }

  const type = item?.type
  if (type === 'text' || type === undefined) {
    canonical.content = item?.text?.content ?? item?.plain_text ?? ''
    // The link URL is already carried by `href` for text items; including
    // `text.link` too would double-count it without adding information.
  } else {
    // mention / equation / anything Notion adds later: hash the type and its
    // own payload rather than the rendered text.
    canonical.type = type
    canonical.payload = item?.[type] ?? null
  }

  return canonical
}

/**
 * Canonical stored form of a block — never its rendered markdown.
 *
 * Rendering is lossy and ambiguous: the same stored block can serialise to two
 * different markdown strings, which would yield two hashes for unchanged
 * content and reintroduce the escaping problem through the back door.
 */
export function canonicalBlock(block: Block): Record<string, unknown> {
  const type = block?.type
  const payload = (type ? block?.[type] : undefined) ?? {}

  const canonical: Record<string, unknown> = { type: type ?? null }

  for (const [key, value] of Object.entries(payload)) {
    if (key === 'rich_text' || key === 'caption') {
      canonical[key] = Array.isArray(value) ? value.map(canonicalRichTextItem) : []
      continue
    }
    // Type-specific non-text fields — checked, language, is_toggleable, color,
    // external URLs, table width, and so on. Carried verbatim: any change to
    // them is a real content change.
    if (!VOLATILE_BLOCK_FIELDS.has(key)) {
      canonical[key] = value
    }
  }

  return canonical
}

function truncatedSha256(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex').slice(0, HASH_LENGTH)
}

/**
 * Hash of a block's own fields — not its children.
 *
 * Children are deliberately out of scope: if a toggle's hash changed whenever
 * a bullet inside it were edited, then editing one child would 409 every
 * pending operation on its siblings' parent. On a page built from collapsed
 * toggles that makes the guard unusable, so callers would route around it.
 */
export function contentHash(block: Block): string {
  return truncatedSha256(stableStringify(canonicalBlock(block)))
}

/**
 * Hash of a block together with its whole subtree, in order.
 *
 * Used only by `delete-a-block`, which destroys everything beneath the block:
 * guarding a delete against the block's own content alone would let a caller
 * delete a container whose children arrived after the read.
 *
 * `fetchChildren` is injected so this is testable without HTTP and so the
 * caller controls request budget. `budget` bounds the walk: a deep or wide
 * subtree could otherwise issue hundreds of Notion calls and blow the caller's
 * timeout. Exhausting it throws rather than returning a hash computed from a
 * partial tree — a hash that silently covered less than it claimed would be
 * worse than no hash at all.
 */
export async function subtreeHash(
  block: Block,
  fetchChildren: (blockId: string) => Promise<Block[]>,
  budget = { remaining: 200 },
): Promise<string> {
  const own = contentHash(block)
  if (!block?.has_children) {
    // Leaf: subtree_hash === content_hash, so a leaf delete needs no extra
    // round trip.
    return own
  }

  if (budget.remaining <= 0) {
    throw new SubtreeTooLargeError(block?.id)
  }
  budget.remaining -= 1

  const children = await fetchChildren(block.id)
  const childHashes: string[] = []
  for (const child of children) {
    childHashes.push(await subtreeHash(child, fetchChildren, budget))
  }

  return truncatedSha256(own + childHashes.join(''))
}

export class SubtreeTooLargeError extends Error {
  constructor(public blockId?: string) {
    super(
      `Subtree under block ${blockId ?? '(unknown)'} is too large to hash within the request budget. ` +
        `Delete its children in smaller groups, or delete from further down the tree.`,
    )
    this.name = 'SubtreeTooLargeError'
  }
}
