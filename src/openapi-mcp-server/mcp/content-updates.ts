/**
 * Pre-flight validation for `update-page-markdown`'s `update_content` batches.
 *
 * The Notion API applies `content_updates` server-side, in order, against a
 * document that each preceding edit has already mutated. Nothing in the request
 * declares where an anchor is expected to land, so a batch whose anchors
 * interact is accepted and returns cleanly while doing the wrong thing — a
 * later `old_str` can match text an earlier edit just wrote, replacing content
 * the caller never intended to touch. A clean return means *accepted*, not
 * *correct*, and the loss is silent.
 *
 * These checks run before the request is sent, so a rejected batch is never
 * partially applied: the whole call fails with nothing written.
 *
 * Scope and limits: this inspects only the relationships between the strings in
 * the batch, not the page they will be applied to. It catches anchors that
 * contain, equal, or reproduce one another, which are the shapes that cause
 * silent loss in practice. It cannot catch two anchors that are unrelated as
 * strings but happen to land adjacently in the document — detecting that would
 * require fetching the page and simulating the edits. Callers who need that
 * guarantee should address blocks by ID instead.
 */

import { splitBlocks } from './payload-shaping'

export type ContentUpdate = {
  old_str: string
  new_str: string
  replace_all_matches?: boolean
}

export class ContentUpdateValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ContentUpdateValidationError'
  }
}

/**
 * Markup that means a newline is inside one block rather than between two.
 *
 * Notion renders a table as a single `<table>` block spanning many lines (one
 * per cell) and a toggle as a single `<details>` block wrapping its children.
 * A fenced code block likewise holds its newlines inside one block. An anchor
 * containing any of these is multi-line but not necessarily multi-block, and we
 * cannot tell from the string alone — so it is left alone.
 */
const WITHIN_BLOCK_MARKUP = /<\/?(?:table|tr|td|th|details|summary)\b|```/

/** Keep quoted anchors readable when they appear in an error message. */
function excerpt(value: string, limit = 60): string {
  const collapsed = value.replace(/\s+/g, ' ').trim()
  return collapsed.length <= limit ? collapsed : `${collapsed.slice(0, limit - 1)}…`
}

/**
 * Throw if a batch of content updates is unsafe to apply.
 *
 * @throws {ContentUpdateValidationError} on the first problem found, naming the
 *   offending edit by its index and stating the remedy.
 */
export function validateContentUpdates(updates: ContentUpdate[]): void {
  if (!Array.isArray(updates)) {
    return
  }

  updates.forEach((update, index) => {
    if (typeof update?.old_str !== 'string' || typeof update?.new_str !== 'string') {
      // Shape is the schema's problem, not ours; let the API reject it.
      return
    }

    if (update.old_str === '') {
      throw new ContentUpdateValidationError(
        `content_updates[${index}]: old_str is empty. An empty anchor has no defined match position.`,
      )
    }

    if (update.old_str === update.new_str) {
      throw new ContentUpdateValidationError(
        `content_updates[${index}]: old_str and new_str are identical, so this edit would do nothing. ` +
          `Remove it, or correct the replacement text.`,
      )
    }

    // The API matches within a single block only, so a multi-block anchor can
    // never match however carefully it is reproduced. Without this check the
    // caller sees a bare "no match" and cannot tell it from a typo.
    //
    // Notion separates blocks with a SINGLE newline, not a blank line. An
    // earlier version of this check tested for a blank line, which meant the
    // common case — two paragraphs copied out of a markdown read — sailed
    // through and failed opaquely at the API.
    //
    // Deliberately conservative, with a false positive we accept: a paragraph
    // containing a soft line break (shift+enter) is one block but looks
    // identical to two paragraphs from the string alone. Rejecting it costs a
    // loud, recoverable refusal that names the alternative; letting it through
    // costs the unexplained no-match this check exists to remove. Anchors that
    // must be exact belong on the block-ID path regardless.
    if (!WITHIN_BLOCK_MARKUP.test(update.old_str) && update.old_str.includes('\n')) {
      const blocks = splitBlocks(update.old_str).length
      throw new ContentUpdateValidationError(
        `content_updates[${index}]: old_str spans ${blocks} blocks; multi-block matching is unsupported and will never match. ` +
          `Notion separates blocks with a single newline. Split it into one edit per block, or address the blocks by ID — ` +
          `read them with Retrieve block children, then use Update a block or Delete a block. ` +
          `(If this is one paragraph containing a soft line break, the block-ID path is the reliable way to edit it.)`,
      )
    }
  })

  for (let i = 0; i < updates.length; i++) {
    for (let j = i + 1; j < updates.length; j++) {
      const earlier = updates[i]
      const later = updates[j]
      if (typeof earlier?.old_str !== 'string' || typeof later?.old_str !== 'string') {
        continue
      }

      // The silent-loss shape: by the time edit j runs, edit i has already
      // written new_str into the document, so edit j matches text that did not
      // exist when the batch was written.
      if (typeof earlier.new_str === 'string' && earlier.new_str.includes(later.old_str)) {
        throw new ContentUpdateValidationError(
          `content_updates[${j}]: its old_str ("${excerpt(later.old_str)}") appears in the new_str of ` +
            `content_updates[${i}]. Edits apply in order, so edit ${j} would match text edit ${i} just inserted ` +
            `and silently replace the wrong content. Combine them into a single edit, or apply them in separate calls.`,
        )
      }

      if (earlier.old_str === later.old_str) {
        if (!earlier.replace_all_matches && !later.replace_all_matches) {
          throw new ContentUpdateValidationError(
            `content_updates[${i}] and content_updates[${j}] have the same old_str ("${excerpt(earlier.old_str)}"). ` +
              `Both would match the first occurrence, so edit ${j} would overwrite edit ${i}. ` +
              `Use replace_all_matches, or make each anchor unique by including surrounding text.`,
          )
        }
        continue
      }

      // Overlapping anchors: whichever runs first destroys the other's match.
      if (earlier.old_str.includes(later.old_str) || later.old_str.includes(earlier.old_str)) {
        throw new ContentUpdateValidationError(
          `content_updates[${i}] and content_updates[${j}] have overlapping anchors: one old_str contains the other ` +
            `("${excerpt(earlier.old_str)}" / "${excerpt(later.old_str)}"). Applying one destroys the other's match. ` +
            `Combine them into a single edit covering the whole region.`,
        )
      }
    }
  }
}
