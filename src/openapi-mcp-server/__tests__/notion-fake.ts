// Handlers are annotated `as RequestHandler` because express's `app.get`
// overloads reject a handler whose body returns a value on some paths; the
// alternative used elsewhere in this repo is `(req: any, res: any)`, which
// gives up type checking inside the handler entirely.
import express, { type Express, type RequestHandler, type Response } from 'express'

/**
 * A fake Notion HTTP backend for wire-level tests, plus a recorder of every
 * request it receives.
 *
 * This exists because a single MCP tool call is no longer a single backend
 * call. `enforcePrecondition` reads before it writes, `annotateReadResponse`
 * walks a subtree after it reads, and `blockReader().listChildren` follows a
 * pagination cursor. The observable contract of the server is a *sequence* of
 * HTTP requests, and asserting on it needs something that actually receives
 * them.
 *
 * What this cannot do: validate Notion's real semantics. The fake encodes our
 * belief about Notion's contract, and if that belief is wrong in the same
 * direction the code is wrong, both agree and the tests stay green. It pins
 * wiring — request sequence, body shape, parameter leakage, call counts — and
 * nothing more. A live-workspace run is still owed.
 */

export type Block = Record<string, any>

export interface RecordedRequest {
  method: string
  /** Pathname only; the query string is captured separately. */
  path: string
  query: Record<string, unknown>
  body: unknown
  headers: Record<string, string | undefined>
}

/** Notion's rich-text shape, as returned by the API (not the request shape). */
export function richText(content: string): Block[] {
  return [
    {
      type: 'text',
      text: { content, link: null },
      annotations: {
        bold: false,
        italic: false,
        strikethrough: false,
        underline: false,
        code: false,
        color: 'default',
      },
      plain_text: content,
      href: null,
    },
  ]
}

function block(id: string, type: string, content: string, extra: Block = {}): Block {
  return {
    object: 'block',
    id,
    parent: { type: 'page_id', page_id: PAGE_ID },
    created_time: '2026-01-01T00:00:00.000Z',
    last_edited_time: '2026-01-01T00:00:00.000Z',
    created_by: { object: 'user', id: 'user-1' },
    last_edited_by: { object: 'user', id: 'user-1' },
    has_children: false,
    archived: false,
    in_trash: false,
    type,
    [type]: { rich_text: richText(content), color: 'default', ...extra },
  }
}

/** `page_id` is declared `format: uuid` in the spec, so use a real one. */
export const PAGE_ID = '11111111-2222-3333-4444-555555555555'

export const LEAF = 'leaf-1'
export const TOGGLE = 'toggle-1'
export const TOGGLE_CHILD = 'toggle-child-1'
export const GRANDCHILD = 'grandchild-1'
export const WIDE = 'wide-1'
/** Deliberately more than one page of children, to exercise the cursor loop. */
export const WIDE_CHILD_COUNT = 150

export class FakeStore {
  blocks = new Map<string, Block>()
  /** Ordered child IDs, keyed by parent ID. */
  children = new Map<string, string[]>()

  constructor() {
    this.reset()
  }

  reset(): void {
    this.blocks.clear()
    this.children.clear()

    this.put(block(LEAF, 'paragraph', 'a leaf paragraph'))

    // A toggle with a child that itself has a child, so a subtree walk that
    // only descends one level is distinguishable from one that recurses.
    this.put({ ...block(TOGGLE, 'toggle', 'a toggle'), has_children: true })
    this.put({ ...block(TOGGLE_CHILD, 'bulleted_list_item', 'a child bullet'), has_children: true })
    this.put(block(GRANDCHILD, 'paragraph', 'a grandchild paragraph'))
    this.children.set(TOGGLE, [TOGGLE_CHILD])
    this.children.set(TOGGLE_CHILD, [GRANDCHILD])

    // Wide parent: >100 children forces a second `GET .../children` call.
    this.put({ ...block(WIDE, 'toggle', 'a wide toggle'), has_children: true })
    const wideChildren: string[] = []
    for (let i = 0; i < WIDE_CHILD_COUNT; i++) {
      const id = `wide-child-${i}`
      this.put(block(id, 'paragraph', `wide child ${i}`))
      wideChildren.push(id)
    }
    this.children.set(WIDE, wideChildren)
  }

  private put(b: Block): void {
    this.blocks.set(b.id, b)
  }

  get(id: string): Block | undefined {
    return this.blocks.get(id)
  }

  childrenOf(id: string): Block[] {
    return (this.children.get(id) ?? []).map((childId) => this.blocks.get(childId)!).filter(Boolean)
  }

  /** Simulate a concurrent writer editing a block's text. */
  setBlockText(id: string, content: string): void {
    const b = this.blocks.get(id)
    if (!b) throw new Error(`no such block in fake store: ${id}`)
    b[b.type] = { ...b[b.type], rich_text: richText(content) }
    b.last_edited_time = '2026-06-01T00:00:00.000Z'
  }

  /** Simulate a concurrent writer appending a child. */
  appendChild(parentId: string, id: string, content: string): void {
    const parent = this.blocks.get(parentId)
    if (!parent) throw new Error(`no such block in fake store: ${parentId}`)
    parent.has_children = true
    this.put(block(id, 'paragraph', content))
    this.children.set(parentId, [...(this.children.get(parentId) ?? []), id])
  }

  removeBlock(id: string): void {
    this.blocks.delete(id)
    this.children.delete(id)
    for (const [parent, kids] of this.children) {
      this.children.set(
        parent,
        kids.filter((k) => k !== id),
      )
    }
  }
}

export interface FakeNotion {
  app: Express
  store: FakeStore
  requests: RecordedRequest[]
  /** Make the next request — whatever it is — fail with this status. */
  failNext(status: number, body: unknown): void
  reset(): void
}

export function createFakeNotion(): FakeNotion {
  const store = new FakeStore()
  const requests: RecordedRequest[] = []
  let pendingFailure: { status: number; body: unknown } | null = null

  const app = express()
  app.use(express.json())

  // Record before anything else, so even a request that goes on to 404 shows up
  // in the sequence. An unexpected call should fail an assertion, not vanish.
  app.use((req, _res, next) => {
    requests.push({
      method: req.method,
      path: req.path,
      query: { ...req.query },
      body: req.body,
      headers: {
        authorization: req.get('authorization'),
        'notion-version': req.get('notion-version'),
        'content-type': req.get('content-type'),
      },
    })
    next()
  })

  const injectFailure: RequestHandler = (_req, res, next) => {
    if (!pendingFailure) {
      next()
      return
    }
    const { status, body } = pendingFailure
    pendingFailure = null
    res.status(status).json(body)
  }
  app.use(injectFailure)

  const notFound = (res: Response, id: string): void => {
    res.status(404).json({ object: 'error', status: 404, code: 'object_not_found', message: `Could not find block ${id}.` })
  }

  app.get('/v1/blocks/:id/children', ((req, res) => {
    const { id } = req.params
    if (!store.get(id)) {
      notFound(res, id)
      return
    }

    const all = store.childrenOf(id)
    const pageSize = Math.min(Number(req.query.page_size ?? 100), 100)
    const cursor = req.query.start_cursor as string | undefined
    const start = cursor ? all.findIndex((b) => b.id === cursor) : 0
    if (cursor && start === -1) {
      res.status(400).json({ object: 'error', status: 400, code: 'validation_error', message: 'Invalid start_cursor.' })
      return
    }
    const slice = all.slice(start, start + pageSize)
    const next = all[start + pageSize]

    res.json({
      object: 'list',
      results: slice,
      next_cursor: next ? next.id : null,
      has_more: Boolean(next),
      type: 'block',
      block: {},
    })
  }) as RequestHandler)

  app.patch('/v1/blocks/:id/children', ((req, res) => {
    const { id } = req.params
    if (!store.get(id)) {
      notFound(res, id)
      return
    }
    const created = (req.body?.children ?? []).map((child: Block, i: number) => {
      const type = Object.keys(child).find((k) => k !== 'object' && k !== 'type') ?? 'paragraph'
      const newId = `appended-${i}`
      store.blocks.set(newId, { ...block(newId, type, ''), [type]: child[type] })
      return store.get(newId)
    })
    res.json({ object: 'list', results: created, next_cursor: null, has_more: false })
  }) as RequestHandler)

  app.get('/v1/blocks/:id', ((req, res) => {
    const b = store.get(req.params.id)
    if (!b) {
      notFound(res, req.params.id)
      return
    }
    res.json(b)
  }) as RequestHandler)

  app.patch('/v1/blocks/:id', ((req, res) => {
    const { id } = req.params
    const b = store.get(id)
    if (!b) {
      notFound(res, id)
      return
    }
    // Mirror Notion: the block-type key sits at the root of the body.
    const type = Object.keys(req.body ?? {}).find((k) => k === b.type)
    if (type) {
      b[type] = { ...b[type], ...req.body[type] }
      b.last_edited_time = '2026-07-01T00:00:00.000Z'
    }
    res.json(b)
  }) as RequestHandler)

  app.delete('/v1/blocks/:id', ((req, res) => {
    const { id } = req.params
    const b = store.get(id)
    if (!b) {
      notFound(res, id)
      return
    }
    store.removeBlock(id)
    res.json({ ...b, archived: true, in_trash: true })
  }) as RequestHandler)

  app.get('/v1/pages/:id/markdown', ((_req, res) => {
    res.json({ object: 'markdown', markdown: '# Page\n\nSome content.\n' })
  }) as RequestHandler)

  app.patch('/v1/pages/:id/markdown', ((_req, res) => {
    res.json({ object: 'markdown', markdown: '# Page\n\nEdited content.\n' })
  }) as RequestHandler)

  const unhandled: RequestHandler = (req, res) => {
    res.status(404).json({
      object: 'error',
      status: 404,
      code: 'unexpected_route',
      message: `Fake Notion received an unhandled request: ${req.method} ${req.path}`,
    })
  }
  app.use(unhandled)

  return {
    app,
    store,
    requests,
    failNext(status, body) {
      pendingFailure = { status, body }
    },
    reset() {
      store.reset()
      requests.length = 0
      pendingFailure = null
    },
  }
}
