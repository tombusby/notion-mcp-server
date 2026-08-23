import { Block, contentHash, subtreeHash, SubtreeTooLargeError } from './content-hash'

/**
 * Content-hash preconditions on block-mutating operations.
 *
 * Every mutating call must carry the hash the caller saw when it read the
 * block. The server re-reads, recomputes, and refuses the write if they
 * differ. A stale read therefore produces a loud 409 instead of a silent
 * overwrite.
 *
 * Note what this does and does not buy. It closes the dominant failure — a
 * single client editing from a read that is hours or days old — completely.
 * It does not make writes atomic: Notion has no compare-and-swap, so the
 * re-read and the write are two calls, and a genuinely simultaneous writer can
 * still land between them. The window shrinks from days to milliseconds, which
 * is the difference between a routine hazard and a lottery.
 *
 * Why a hash rather than the two obvious alternatives.
 *
 * `expected_last_edited_time` is simpler, and was the first candidate. But
 * Notion's timestamps are minute-granular (observed: `2026-08-11T21:28:00.000Z`),
 * so two edits inside the same minute are indistinguishable. It would catch
 * day-scale staleness — the dominant case — while staying blind to precisely
 * the races that are hardest to diagnose afterwards. The test named for a
 * second write inside the same minute exists to pin that difference.
 *
 * Invalidating block IDs on every edit — delete-and-recreate, so a stale ID
 * 404s — gives immutability for free, but destroys comments (Notion attaches
 * them to blocks), breaks `#block-id` anchor links on every edit, and cascades
 * through container subtrees. It overloads *identity* to carry *version*.
 * Version has to travel separately, and the hash is what carries it.
 *
 * On why this is enforced rather than advised. The operational rules the
 * markdown path relied on — re-fetch immediately before editing, never
 * reconstruct anchors from memory, never trust a clean return, one edit per
 * region — existed only because the tool could not enforce any of them. They
 * were discipline substituting for design, and they were violated repeatedly
 * in practice, including by callers who had written the rules down themselves.
 * A required hash makes the lapse impossible to express rather than merely
 * discouraged: forgetting to re-read produces a 409 instead of silent data
 * loss. The guard must not depend on the caller remembering to be careful.
 */

/** Server-side parameters, consumed here and never forwarded to Notion. */
export const EXPECTED_CONTENT_HASH = 'expected_content_hash'
export const EXPECTED_SUBTREE_HASH = 'expected_subtree_hash'
export const EXPECTED_ANCHOR_HASH = 'expected_anchor_hash'

const PRECONDITION_PARAMS = [EXPECTED_CONTENT_HASH, EXPECTED_SUBTREE_HASH, EXPECTED_ANCHOR_HASH]

/** Reads the proxy performs on the caller's behalf to verify a precondition. */
export interface BlockReader {
  retrieveBlock(blockId: string): Promise<Block>
  listChildren(blockId: string): Promise<Block[]>
}

export class PreconditionError extends Error {
  constructor(
    public status: number,
    public payload: Record<string, unknown>,
  ) {
    super(String(payload.message ?? 'precondition failed'))
    this.name = 'PreconditionError'
  }
}

function missingHash(param: string, operation: string): PreconditionError {
  return new PreconditionError(400, {
    status: 400,
    code: 'missing_content_hash',
    message:
      `${operation} requires '${param}'. Read the block first and pass back the hash ` +
      `returned with it. Do not construct or modify the value.`,
  })
}

function stale(
  code: string,
  blockId: string,
  expectedParam: string,
  expected: string,
  currentParam: string,
  current: string,
  currentBlock: Block,
): PreconditionError {
  const shortId = String(blockId).slice(0, 8)
  return new PreconditionError(409, {
    status: 409,
    code,
    message:
      `Block ${shortId} changed since it was read. Expected ${expected}, found ${current}. ` +
      `Re-read the block, decide whether your edit still applies, and retry with the new hash.`,
    block_id: blockId,
    [expectedParam]: expected,
    [currentParam]: current,
    current_last_edited_time: currentBlock?.last_edited_time ?? null,
    // Included so the caller can diff, decide and retry in one round trip
    // rather than being forced into a blind re-read.
    current_content: currentBlock,
  })
}

/** Strip the server-side params so they are never sent to Notion. */
export function stripPreconditionParams(params: Record<string, unknown>): Record<string, unknown> {
  const stripped = { ...params }
  for (const key of PRECONDITION_PARAMS) {
    delete stripped[key]
  }
  return stripped
}

function requireString(params: Record<string, unknown>, key: string, operation: string): string {
  const value = params[key]
  if (typeof value !== 'string' || value.trim() === '') {
    throw missingHash(key, operation)
  }
  return value.trim()
}

/**
 * Verify the precondition for a mutating block operation. Returns the params
 * to forward, with the server-side hash arguments removed.
 *
 * Operations not listed here are unguarded by design:
 *   - appending children with no `after` anchor is additive and destroys
 *     nothing;
 *   - `update-page-markdown` is the bulk escape hatch, and guarding it would
 *     push callers back onto find-and-replace for the cases the structured API
 *     cannot express.
 */
export async function enforcePrecondition(
  operationId: string | undefined,
  params: Record<string, unknown>,
  reader: BlockReader,
): Promise<Record<string, unknown>> {
  switch (operationId) {
    case 'update-a-block': {
      const expected = requireString(params, EXPECTED_CONTENT_HASH, 'update-a-block')
      const blockId = String(params.block_id ?? '')
      const current = await reader.retrieveBlock(blockId)
      const actual = contentHash(current)
      if (actual !== expected) {
        throw stale(
          'stale_content_hash',
          blockId,
          EXPECTED_CONTENT_HASH,
          expected,
          'current_content_hash',
          actual,
          current,
        )
      }
      return stripPreconditionParams(params)
    }

    case 'delete-a-block': {
      const expected = requireString(params, EXPECTED_SUBTREE_HASH, 'delete-a-block')
      const blockId = String(params.block_id ?? '')
      const current = await reader.retrieveBlock(blockId)
      let actual: string
      try {
        actual = await subtreeHash(current, (id) => reader.listChildren(id))
      } catch (error) {
        if (error instanceof SubtreeTooLargeError) {
          throw new PreconditionError(400, {
            status: 400,
            code: 'subtree_too_large',
            message: error.message,
            block_id: blockId,
          })
        }
        throw error
      }
      if (actual !== expected) {
        throw stale(
          'stale_subtree_hash',
          blockId,
          EXPECTED_SUBTREE_HASH,
          expected,
          'current_subtree_hash',
          actual,
          current,
        )
      }
      return stripPreconditionParams(params)
    }

    case 'patch-block-children': {
      // Only anchored inserts need a precondition: `after` positions the new
      // content relative to an existing block, so an anchor that has since
      // changed or been replaced puts the insert in the wrong place.
      const after = params.after
      if (typeof after !== 'string' || after.trim() === '') {
        return stripPreconditionParams(params)
      }
      const expected = requireString(params, EXPECTED_ANCHOR_HASH, 'patch-block-children with `after`')
      const anchorId = after.trim()
      const current = await reader.retrieveBlock(anchorId)
      const actual = contentHash(current)
      if (actual !== expected) {
        throw stale(
          'stale_anchor_hash',
          anchorId,
          EXPECTED_ANCHOR_HASH,
          expected,
          'current_anchor_hash',
          actual,
          current,
        )
      }
      return stripPreconditionParams(params)
    }

    default:
      return params
  }
}

/**
 * Annotate a read response with the hashes its writes will require.
 *
 * Every read path that exposes a block must return one. If any did not,
 * callers would discover that path and route around the guard — not out of
 * malice, but because it is the one that works without an extra step.
 *
 * `subtree_hash` is computed only for a single retrieved block, never for
 * every child of a listing: it needs a recursive walk, and doing that per
 * child would turn a one-call listing into hundreds on a page of collapsed
 * toggles. Delete is the only consumer, so the cost belongs on the path that
 * precedes a delete.
 */
export async function annotateReadResponse(
  operationId: string | undefined,
  data: unknown,
  reader: BlockReader,
): Promise<unknown> {
  if (!data || typeof data !== 'object') {
    return data
  }

  switch (operationId) {
    case 'retrieve-a-block': {
      const block = data as Block
      if (!block.type) return data
      const annotated: Record<string, unknown> = { ...block, content_hash: contentHash(block) }
      try {
        annotated.subtree_hash = await subtreeHash(block, (id) => reader.listChildren(id))
      } catch (error) {
        if (error instanceof SubtreeTooLargeError) {
          // A read must not fail because the subtree is big. Report the gap
          // explicitly instead: delete will refuse, which is the safe outcome,
          // and the caller is told why here rather than at the write.
          annotated.subtree_hash = null
          annotated.subtree_hash_error = error.message
        } else {
          throw error
        }
      }
      return annotated
    }

    case 'get-block-children': {
      const results = (data as any).results
      if (!Array.isArray(results)) return data
      return {
        ...(data as Record<string, unknown>),
        results: results.map((block: Block) =>
          block && block.type ? { ...block, content_hash: contentHash(block) } : block,
        ),
      }
    }

    // A write returns the block it just produced. Handing back its new hash
    // lets a caller make a second edit without a re-read, which is both faster
    // and removes the temptation to reuse the now-stale hash it already has.
    case 'update-a-block':
    case 'patch-block-children': {
      const block = data as Block
      if (block.type) {
        return { ...block, content_hash: contentHash(block) }
      }
      const results = (data as any).results
      if (Array.isArray(results)) {
        return {
          ...(data as Record<string, unknown>),
          results: results.map((child: Block) =>
            child && child.type ? { ...child, content_hash: contentHash(child) } : child,
          ),
        }
      }
      return data
    }

    default:
      return data
  }
}
