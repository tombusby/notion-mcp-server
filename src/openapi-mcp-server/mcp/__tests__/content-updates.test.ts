import { describe, expect, it } from 'vitest'
import { ContentUpdate, ContentUpdateValidationError, validateContentUpdates } from '../content-updates'

/**
 * Guards the pre-flight checks on `update-page-markdown` find-and-replace
 * batches. Each rejection here corresponds to a batch the Notion API would
 * accept and apply incorrectly, returning success.
 */
describe('validateContentUpdates', () => {
  const expectRejection = (updates: ContentUpdate[], match: RegExp) => {
    expect(() => validateContentUpdates(updates)).toThrow(ContentUpdateValidationError)
    expect(() => validateContentUpdates(updates)).toThrow(match)
  }

  describe('accepts safe batches', () => {
    it('allows disjoint, well-separated anchors', () => {
      expect(() =>
        validateContentUpdates([
          { old_str: 'the first paragraph', new_str: 'the opening paragraph' },
          { old_str: 'a totally unrelated line', new_str: 'a rewritten line' },
        ]),
      ).not.toThrow()
    })

    it('allows a single edit', () => {
      expect(() => validateContentUpdates([{ old_str: 'before', new_str: 'after' }])).not.toThrow()
    })

    it('allows an empty batch', () => {
      expect(() => validateContentUpdates([])).not.toThrow()
    })

    it('allows a table row, which is multi-line inside a single block', () => {
      // Notion renders a table as one <table> block with a line per cell. An
      // earlier version of this test asserted the same thing about bare
      // newline-joined text ('Genre\nPop\n1984'), which encoded the belief
      // that blocks are blank-line separated — a live read disproved it.
      expect(() =>
        validateContentUpdates([
          { old_str: '<tr>\n<td>Genre</td>\n<td>Pop</td>\n</tr>', new_str: '<tr>\n<td>Genre</td>\n<td>Synthpop</td>\n</tr>' },
        ]),
      ).not.toThrow()
    })

    it('allows a fenced code block, whose newlines are inside one block', () => {
      expect(() =>
        validateContentUpdates([{ old_str: '```js\nconst a = 1\n```', new_str: '```js\nconst a = 2\n```' }]),
      ).not.toThrow()
    })

    it('allows a whole toggle, which wraps its children in one block', () => {
      expect(() =>
        validateContentUpdates([
          { old_str: '<details>\n<summary>Old</summary>\n</details>', new_str: '<details>\n<summary>New</summary>\n</details>' },
        ]),
      ).not.toThrow()
    })

    it('allows duplicate anchors when replace_all_matches is set', () => {
      expect(() =>
        validateContentUpdates([
          { old_str: 'colour', new_str: 'color', replace_all_matches: true },
          { old_str: 'colour', new_str: 'color', replace_all_matches: true },
        ]),
      ).not.toThrow()
    })

    it('leaves malformed entries to the API to reject', () => {
      expect(() => validateContentUpdates([{ old_str: 42 } as unknown as ContentUpdate])).not.toThrow()
      expect(() => validateContentUpdates(undefined as unknown as ContentUpdate[])).not.toThrow()
    })
  })

  describe('rejects multi-block anchors', () => {
    it('rejects two paragraphs separated by a single newline', () => {
      // The case the blank-line check missed entirely: Notion separates blocks
      // with one newline, so this is the shape a caller actually produces by
      // copying a region out of a markdown read.
      expectRejection([{ old_str: 'First paragraph.\nSecond paragraph.', new_str: 'x' }], /spans 2 blocks/)
    })

    it('rejects two list items, which are separate blocks', () => {
      expectRejection([{ old_str: '- one\n- two', new_str: 'x' }], /spans 2 blocks/)
    })

    it('rejects a heading followed by its paragraph', () => {
      expectRejection([{ old_str: '## Heading\nBody text.', new_str: 'x' }], /single newline/)
    })

    it('names the soft-break case rather than leaving the caller guessing', () => {
      expectRejection([{ old_str: 'a\nb', new_str: 'x' }], /soft line break/)
    })

    it('rejects an old_str spanning a blank line, naming the block count', () => {
      expectRejection(
        [{ old_str: 'First paragraph.\n\nSecond paragraph.', new_str: 'Merged.' }],
        /spans 2 blocks/,
      )
    })

    it('counts blocks across several blank lines', () => {
      expectRejection([{ old_str: 'a\n\nb\n\nc\n\nd', new_str: 'x' }], /spans 4 blocks/)
    })

    it('treats a blank line containing whitespace as a block separator', () => {
      expectRejection([{ old_str: 'a\n   \nb', new_str: 'x' }], /spans 2 blocks/)
    })

    it('points the caller at block IDs', () => {
      expectRejection([{ old_str: 'a\n\nb', new_str: 'x' }], /Retrieve block children/)
    })
  })

  describe('rejects interacting anchors', () => {
    it('rejects a later anchor that matches text an earlier edit inserts', () => {
      // The shape that silently destroys content: by the time edit 1 runs,
      // edit 0 has already written "Revised heading" into the document.
      expectRejection(
        [
          { old_str: 'Original heading', new_str: 'Revised heading' },
          { old_str: 'Revised heading', new_str: 'Something else entirely' },
        ],
        /appears in the new_str of content_updates\[0\]/,
      )
    })

    it('rejects an anchor contained within another anchor', () => {
      expectRejection(
        [
          { old_str: 'the quick brown fox jumps', new_str: 'the fox jumps' },
          { old_str: 'quick brown', new_str: 'slow grey' },
        ],
        /overlapping anchors/,
      )
    })

    it('rejects overlap regardless of which anchor is listed first', () => {
      expectRejection(
        [
          { old_str: 'quick brown', new_str: 'slow grey' },
          { old_str: 'the quick brown fox jumps', new_str: 'the fox jumps' },
        ],
        /overlapping anchors/,
      )
    })

    it('rejects duplicate anchors when replace_all_matches is not set', () => {
      expectRejection(
        [
          { old_str: 'colour', new_str: 'color' },
          { old_str: 'colour', new_str: 'colour scheme' },
        ],
        /have the same old_str/,
      )
    })
  })

  describe('rejects degenerate edits', () => {
    it('rejects an empty old_str', () => {
      expectRejection([{ old_str: '', new_str: 'inserted' }], /old_str is empty/)
    })

    it('rejects a no-op edit', () => {
      expectRejection([{ old_str: 'unchanged', new_str: 'unchanged' }], /would do nothing/)
    })
  })

  describe('error messages', () => {
    it('names the offending edit by index', () => {
      expectRejection(
        [
          { old_str: 'fine', new_str: 'also fine' },
          { old_str: 'a\n\nb', new_str: 'x' },
        ],
        /content_updates\[1\]/,
      )
    })

    it('truncates long anchors so the message stays readable', () => {
      const long = 'x'.repeat(200)
      try {
        validateContentUpdates([
          { old_str: long, new_str: 'short' },
          { old_str: long, new_str: 'other' },
        ])
        expect.unreachable('expected a rejection')
      } catch (error) {
        expect((error as Error).message).toMatch(/…/)
        expect((error as Error).message.length).toBeLessThan(400)
      }
    })
  })
})
