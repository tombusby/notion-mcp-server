import { describe, expect, it, beforeAll, beforeEach, afterAll } from 'vitest'
import { callTool, seq, withNotionMcp, type Harness } from './mcp-harness'
import { GRANDCHILD, LEAF, PAGE_ID, TOGGLE, TOGGLE_CHILD, WIDE, WIDE_CHILD_COUNT } from './notion-fake'

/**
 * Wire-level tests: the real MCP proxy, over a real MCP transport, against a
 * fake Notion HTTP backend, asserting the *sequence* of outbound requests.
 *
 * The rest of the suite mocks either `HttpClient` or the MCP `Server` and so
 * observes arguments rather than requests. That was adequate when one tool call
 * meant one backend call. It no longer is: `enforcePrecondition` reads before it
 * writes, `annotateReadResponse` walks a subtree after it reads, and
 * `listChildren` follows a pagination cursor. What this server does is now a
 * sequence of HTTP calls, and this file is where that sequence is pinned.
 *
 * Assertions use `toEqual` on the whole recorded sequence rather than
 * `toContain`, because the count and the order are the point — "no write was
 * issued" and "no extra read was issued" are the properties at risk.
 *
 * What this layer cannot reach: anything decided before the request is built.
 * `executeOperation` forwards whatever arguments it is given, so a body-shape
 * mistake in the spec produces a correctly-transmitted wrong body. Schema and
 * guidance regressions belong to the snapshot and parser tests; this file
 * covers only what happens between the tool call and the socket.
 *
 * Limitation: the fake encodes our belief about Notion's contract. If that
 * belief is wrong in the same direction the code is wrong, both agree and these
 * tests stay green. They pin wiring — sequence, body shape, parameter leakage,
 * call counts — not Notion's semantics. A live-workspace run is still owed.
 */

describe('block workflows (wire level)', () => {
  let h: Harness

  beforeAll(async () => {
    // Parsing the real spec and initialising openapi-client-axios is the
    // expensive part; do it once and reset the fake between tests.
    h = await withNotionMcp()
  })

  beforeEach(() => {
    h.fake.reset()
  })

  afterAll(async () => {
    await h.close()
  })

  /** Read a block and return the hashes a subsequent write will require. */
  async function hashesFor(blockId: string): Promise<{ content_hash: string; subtree_hash: string }> {
    const data = await callTool(h.client, 'API-retrieve-a-block', { block_id: blockId })
    h.fake.requests.length = 0
    return data
  }

  describe('reads and hash annotation', () => {
    it('retrieves a leaf with a single request, and its subtree hash is its content hash', async () => {
      const data = await callTool(h.client, 'API-retrieve-a-block', { block_id: LEAF })

      expect(seq(h.requests)).toEqual([`GET /v1/blocks/${LEAF}`])
      expect(data.content_hash).toEqual(expect.any(String))
      // A leaf has no children, so hashing its subtree costs no extra round trip.
      expect(data.subtree_hash).toBe(data.content_hash)
    })

    it('walks the whole subtree recursively when the block has children', async () => {
      const data = await callTool(h.client, 'API-retrieve-a-block', { block_id: TOGGLE })

      // The grandchild fetch is what distinguishes a real recursion from a
      // walk that only descends one level.
      expect(seq(h.requests)).toEqual([
        `GET /v1/blocks/${TOGGLE}`,
        `GET /v1/blocks/${TOGGLE}/children`,
        `GET /v1/blocks/${TOGGLE_CHILD}/children`,
      ])
      expect(data.subtree_hash).not.toBe(data.content_hash)
    })

    it('lists children in one request and does not walk each child subtree', async () => {
      const data = await callTool(h.client, 'API-get-block-children', { block_id: TOGGLE })

      // Deliberate: hashing every child's subtree would turn a one-call listing
      // into hundreds on a page of collapsed toggles.
      expect(seq(h.requests)).toEqual([`GET /v1/blocks/${TOGGLE}/children`])
      expect(data.results).toHaveLength(1)
      expect(data.results[0].content_hash).toEqual(expect.any(String))
      expect(data.results[0]).not.toHaveProperty('subtree_hash')
    })

    it('follows the pagination cursor when a block has more than one page of children', async () => {
      const data = await callTool(h.client, 'API-retrieve-a-block', { block_id: WIDE })

      const childListings = h.requests.filter((r) => r.path === `/v1/blocks/${WIDE}/children`)
      expect(childListings).toHaveLength(2)
      expect(childListings[0].query).not.toHaveProperty('start_cursor')
      expect(childListings[1].query.start_cursor).toBe('wide-child-100')
      expect(data.subtree_hash).toEqual(expect.any(String))
    })

    it('covers children beyond the first page in the subtree hash', async () => {
      const before = await callTool(h.client, 'API-retrieve-a-block', { block_id: WIDE })

      // Mutate a child that only the second page reaches. If the cursor loop
      // were dropped, the hash would be computed over a partial tree and this
      // change would go unnoticed — the exact silent-coverage failure the
      // pagination exists to prevent.
      h.fake.store.setBlockText(`wide-child-${WIDE_CHILD_COUNT - 1}`, 'edited by someone else')
      const after = await callTool(h.client, 'API-retrieve-a-block', { block_id: WIDE })

      expect(after.subtree_hash).not.toBe(before.subtree_hash)
    })
  })

  describe('update-a-block', () => {
    it('reads, verifies, then writes the block-type key at the body root', async () => {
      const { content_hash } = await hashesFor(LEAF)

      await callTool(h.client, 'API-update-a-block', {
        block_id: LEAF,
        expected_content_hash: content_hash,
        paragraph: { rich_text: [{ text: { content: 'rewritten' } }] },
      })

      expect(seq(h.requests)).toEqual([`GET /v1/blocks/${LEAF}`, `PATCH /v1/blocks/${LEAF}`])

      const patch = h.requests[1].body as Record<string, unknown>
      // The block-type key reaches Notion at the body root, unaltered.
      //
      // This is *not* the regression guard for issue #271, despite looking like
      // one. `executeOperation` forwards every non-path, non-query argument into
      // the body whatever the schema says, so the body shape here is decided by
      // what the caller passed, not by the spec — reverting the spec to its
      // broken `type`-wrapper shape leaves this test green. The guard for #271
      // lives in the spec snapshot and notion-markdown-tools tests, which is
      // the right place: the fix was to the guidance the model reads. What this
      // adds is the adjacent claim those cannot make — that nothing in the
      // request path rewraps or mangles the shape on its way out.
      expect(patch).toHaveProperty('paragraph')
      expect(patch).not.toHaveProperty('type')
      // The hash is ours. Forwarding it would have Notion reject the call.
      expect(patch).not.toHaveProperty('expected_content_hash')
    })

    it('issues no requests at all when the hash is missing', async () => {
      const result = await callTool(h.client, 'API-update-a-block', {
        block_id: LEAF,
        paragraph: { rich_text: [{ text: { content: 'rewritten' } }] },
      })

      expect(seq(h.requests)).toEqual([])
      expect(result.code).toBe('missing_content_hash')
      expect(result.status).toBe(400)
    })

    it('reads but does not write when the block changed since it was read', async () => {
      const { content_hash } = await hashesFor(LEAF)
      h.fake.store.setBlockText(LEAF, 'changed by someone else')

      const result = await callTool(h.client, 'API-update-a-block', {
        block_id: LEAF,
        expected_content_hash: content_hash,
        paragraph: { rich_text: [{ text: { content: 'rewritten' } }] },
      })

      expect(seq(h.requests)).toEqual([`GET /v1/blocks/${LEAF}`])
      expect(result.code).toBe('stale_content_hash')
      expect(result.status).toBe(409)
      // The caller is handed the current content so it can diff, decide and
      // retry in one round trip rather than being forced into a blind re-read.
      expect(result.current_content.paragraph.rich_text[0].plain_text).toBe('changed by someone else')
    })
  })

  describe('delete-a-block', () => {
    it('walks the subtree, then deletes, and never puts the hash in the query string', async () => {
      const { subtree_hash } = await hashesFor(TOGGLE)

      await callTool(h.client, 'API-delete-a-block', {
        block_id: TOGGLE,
        expected_subtree_hash: subtree_hash,
      })

      expect(seq(h.requests)).toEqual([
        `GET /v1/blocks/${TOGGLE}`,
        `GET /v1/blocks/${TOGGLE}/children`,
        `GET /v1/blocks/${TOGGLE_CHILD}/children`,
        `DELETE /v1/blocks/${TOGGLE}`,
      ])

      // DELETE declares no request body, so `executeOperation` promotes any
      // leftover parameter into the URL. If the strip regressed, the hash would
      // ride along in the query string of a live delete — and only a wire-level
      // assertion can see that.
      const del = h.requests[3]
      expect(del.query).not.toHaveProperty('expected_subtree_hash')
      expect(del.query).toEqual({})
    })

    it('issues no delete when a child arrived after the subtree was read', async () => {
      const { subtree_hash } = await hashesFor(TOGGLE)
      h.fake.store.appendChild(TOGGLE, 'late-arrival', 'added by someone else')

      const result = await callTool(h.client, 'API-delete-a-block', {
        block_id: TOGGLE,
        expected_subtree_hash: subtree_hash,
      })

      expect(seq(h.requests)).not.toContain(`DELETE /v1/blocks/${TOGGLE}`)
      expect(result.code).toBe('stale_subtree_hash')
      expect(result.status).toBe(409)
    })

    it('deletes a leaf without any children listing', async () => {
      const { subtree_hash } = await hashesFor(LEAF)

      await callTool(h.client, 'API-delete-a-block', {
        block_id: LEAF,
        expected_subtree_hash: subtree_hash,
      })

      expect(seq(h.requests)).toEqual([`GET /v1/blocks/${LEAF}`, `DELETE /v1/blocks/${LEAF}`])
    })
  })

  describe('patch-block-children', () => {
    it('appends with no precondition read when there is no anchor', async () => {
      await callTool(h.client, 'API-patch-block-children', {
        block_id: TOGGLE,
        children: [{ paragraph: { rich_text: [{ text: { content: 'appended' } }] } }],
      })

      // Appending destroys nothing, so it is unguarded by design.
      expect(seq(h.requests)).toEqual([`PATCH /v1/blocks/${TOGGLE}/children`])
    })

    it('verifies the anchor before an anchored insert', async () => {
      const { content_hash } = await hashesFor(GRANDCHILD)

      await callTool(h.client, 'API-patch-block-children', {
        block_id: TOGGLE_CHILD,
        after: GRANDCHILD,
        expected_anchor_hash: content_hash,
        children: [{ paragraph: { rich_text: [{ text: { content: 'inserted' } }] } }],
      })

      expect(seq(h.requests)).toEqual([`GET /v1/blocks/${GRANDCHILD}`, `PATCH /v1/blocks/${TOGGLE_CHILD}/children`])

      const patch = h.requests[1].body as Record<string, unknown>
      expect(patch.after).toBe(GRANDCHILD)
      expect(patch).not.toHaveProperty('expected_anchor_hash')
    })

    it('issues no requests for an anchored insert with no anchor hash', async () => {
      const result = await callTool(h.client, 'API-patch-block-children', {
        block_id: TOGGLE_CHILD,
        after: GRANDCHILD,
        children: [{ paragraph: { rich_text: [{ text: { content: 'inserted' } }] } }],
      })

      expect(seq(h.requests)).toEqual([])
      expect(result.code).toBe('missing_content_hash')
    })

    it('refuses an anchored insert when the anchor changed since it was read', async () => {
      const { content_hash } = await hashesFor(GRANDCHILD)
      h.fake.store.setBlockText(GRANDCHILD, 'the anchor moved under you')

      const result = await callTool(h.client, 'API-patch-block-children', {
        block_id: TOGGLE_CHILD,
        after: GRANDCHILD,
        expected_anchor_hash: content_hash,
        children: [{ paragraph: { rich_text: [{ text: { content: 'inserted' } }] } }],
      })

      expect(seq(h.requests)).toEqual([`GET /v1/blocks/${GRANDCHILD}`])
      expect(result.code).toBe('stale_anchor_hash')
    })
  })

  describe('update-page-markdown', () => {
    it('sends nothing when a batch would silently destroy content', async () => {
      // The second edit's anchor is text the first edit produces. Applied in
      // order against an already-mutated document, this replaces the wrong
      // content and returns cleanly — the shape that destroyed three bullets.
      //
      // Note the asymmetry this pins: the precondition guard returns a
      // structured tool result, whereas `validateContentUpdates` throws and so
      // surfaces as a JSON-RPC error. Both refuse the write, which is what
      // matters here, but only one is machine-readable by the caller. Asserted
      // as-is rather than adjusted, so a future decision to align them is a
      // deliberate change and not a silent one.
      await expect(
        callTool(h.client, 'API-update-page-markdown', {
          page_id: PAGE_ID,
          type: 'update_content',
          update_content: {
            content_updates: [
              { old_str: 'Some content.', new_str: 'Replaced heading text.' },
              { old_str: 'Replaced heading text.', new_str: 'Something else entirely.' },
            ],
          },
        }),
      ).rejects.toThrow(/appears in the new_str of content_updates\[0\]/)

      // "Nothing was written" is only observable here.
      expect(seq(h.requests)).toEqual([])
    })

    it('forwards a valid batch with the version this endpoint requires', async () => {
      await callTool(h.client, 'API-update-page-markdown', {
        page_id: PAGE_ID,
        type: 'update_content',
        update_content: {
          content_updates: [
            { old_str: '# Page', new_str: '# Renamed' },
            { old_str: 'Some content.', new_str: 'Other content.' },
          ],
        },
      })

      expect(seq(h.requests)).toEqual([`PATCH /v1/pages/${PAGE_ID}/markdown`])
      // The markdown endpoints pin a later API version than the rest of the
      // spec, sourced per-operation from the header parameter's default.
      expect(h.requests[0].headers['notion-version']).toBe('2026-03-11')
    })

    it('leaves block operations on the default API version', async () => {
      await callTool(h.client, 'API-retrieve-a-block', { block_id: LEAF })
      expect(h.requests[0].headers['notion-version']).toBe('2025-09-03')
    })
  })

  describe('cross-cutting', () => {
    it('authenticates every request, including the reads made on the caller behalf', async () => {
      const { subtree_hash } = await hashesFor(TOGGLE)
      await callTool(h.client, 'API-delete-a-block', { block_id: TOGGLE, expected_subtree_hash: subtree_hash })

      expect(h.requests.length).toBeGreaterThan(1)
      for (const request of h.requests) {
        expect(request.headers.authorization).toBe('Bearer test-token')
      }
    })

    it('returns a backend error as structured content rather than throwing', async () => {
      h.fake.failNext(404, { object: 'error', status: 404, code: 'object_not_found', message: 'Could not find block.' })

      const result = await callTool(h.client, 'API-retrieve-a-block', { block_id: LEAF })

      expect(result.code).toBe('object_not_found')
      expect(result.message).toBe('Could not find block.')
      // The error branch builds `{ status: 'error', ...notionErrorBody }`, and
      // Notion's body carries its own numeric `status` — so the spread always
      // clobbers the literal. Pinned as the behaviour actually is; the marker
      // that survives for callers is `code`, not `status`.
      expect(result.status).toBe(404)
    })
  })
})
