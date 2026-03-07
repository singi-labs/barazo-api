import { describe, it, expect, vi } from 'vitest'
import { ReplyIndexer } from '../../../../src/firehose/indexers/reply.js'

function createMockDb() {
  const mockTx = {
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
      }),
    }),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      }),
    }),
    delete: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue([{ uri: 'deleted' }]),
    }),
  }

  return {
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
      }),
    }),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      }),
    }),
    delete: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue([{ uri: 'deleted' }]),
    }),
    transaction: vi
      .fn()
      .mockImplementation(async (fn: (tx: typeof mockTx) => Promise<void>) => fn(mockTx)),
    _tx: mockTx,
  }
}

function createMockLogger() {
  return {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  }
}

describe('ReplyIndexer', () => {
  const baseParams = {
    uri: 'at://did:plc:test/forum.barazo.topic.reply/reply1',
    rkey: 'reply1',
    did: 'did:plc:test',
    cid: 'bafyreply',
    live: true,
  }

  describe('handleCreate', () => {
    it('inserts a reply and increments topic reply count in a transaction', async () => {
      const db = createMockDb()
      const logger = createMockLogger()
      const indexer = new ReplyIndexer(db as never, logger as never)

      await indexer.handleCreate({
        ...baseParams,
        record: {
          content: { $type: 'forum.barazo.richtext#markdown' as const, value: 'A reply' },
          root: { uri: 'at://did:plc:test/forum.barazo.topic.post/topic1', cid: 'bafytopic' },
          parent: { uri: 'at://did:plc:test/forum.barazo.topic.post/topic1', cid: 'bafytopic' },
          community: 'did:plc:community',
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      })

      expect(db.transaction).toHaveBeenCalledTimes(1)
    })

    it('sets depth to 1 for direct replies to topic', async () => {
      const insertValuesMock = vi.fn().mockReturnValue({
        onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
      })
      const mockTx = {
        insert: vi.fn().mockReturnValue({ values: insertValuesMock }),
        update: vi.fn().mockReturnValue({
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue(undefined),
          }),
        }),
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([]),
          }),
        }),
      }
      const db = {
        ...createMockDb(),
        transaction: vi
          .fn()
          .mockImplementation(async (fn: (tx: typeof mockTx) => Promise<void>) => fn(mockTx)),
      }
      const logger = createMockLogger()
      const indexer = new ReplyIndexer(db as never, logger as never)

      const topicUri = 'at://did:plc:test/forum.barazo.topic.post/topic1'
      await indexer.handleCreate({
        ...baseParams,
        record: {
          content: { $type: 'forum.barazo.richtext#markdown' as const, value: 'Direct reply' },
          root: { uri: topicUri, cid: 'bafytopic' },
          parent: { uri: topicUri, cid: 'bafytopic' },
          community: 'did:plc:community',
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      })

      const values = insertValuesMock.mock.calls[0][0] as Record<string, unknown>
      expect(values.depth).toBe(1)
    })

    it('computes depth from parent for nested replies', async () => {
      const insertValuesMock = vi.fn().mockReturnValue({
        onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
      })
      const mockTx = {
        insert: vi.fn().mockReturnValue({ values: insertValuesMock }),
        update: vi.fn().mockReturnValue({
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue(undefined),
          }),
        }),
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([{ depth: 2 }]),
          }),
        }),
      }
      const db = {
        ...createMockDb(),
        transaction: vi
          .fn()
          .mockImplementation(async (fn: (tx: typeof mockTx) => Promise<void>) => fn(mockTx)),
      }
      const logger = createMockLogger()
      const indexer = new ReplyIndexer(db as never, logger as never)

      await indexer.handleCreate({
        ...baseParams,
        record: {
          content: { $type: 'forum.barazo.richtext#markdown' as const, value: 'Nested reply' },
          root: { uri: 'at://did:plc:test/forum.barazo.topic.post/topic1', cid: 'bafytopic' },
          parent: { uri: 'at://did:plc:test/forum.barazo.topic.reply/reply2', cid: 'bafyreply2' },
          community: 'did:plc:community',
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      })

      const values = insertValuesMock.mock.calls[0][0] as Record<string, unknown>
      expect(values.depth).toBe(3)
    })

    it('defaults depth to 1 when parent reply not found', async () => {
      const insertValuesMock = vi.fn().mockReturnValue({
        onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
      })
      const mockTx = {
        insert: vi.fn().mockReturnValue({ values: insertValuesMock }),
        update: vi.fn().mockReturnValue({
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue(undefined),
          }),
        }),
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([]),
          }),
        }),
      }
      const db = {
        ...createMockDb(),
        transaction: vi
          .fn()
          .mockImplementation(async (fn: (tx: typeof mockTx) => Promise<void>) => fn(mockTx)),
      }
      const logger = createMockLogger()
      const indexer = new ReplyIndexer(db as never, logger as never)

      await indexer.handleCreate({
        ...baseParams,
        record: {
          content: {
            $type: 'forum.barazo.richtext#markdown' as const,
            value: 'Orphaned nested reply',
          },
          root: { uri: 'at://did:plc:test/forum.barazo.topic.post/topic1', cid: 'bafytopic' },
          parent: {
            uri: 'at://did:plc:test/forum.barazo.topic.reply/missing',
            cid: 'bafymissing',
          },
          community: 'did:plc:community',
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      })

      const values = insertValuesMock.mock.calls[0][0] as Record<string, unknown>
      expect(values.depth).toBe(1)
    })
  })

  describe('handleUpdate', () => {
    it('updates reply content', async () => {
      const db = createMockDb()
      const logger = createMockLogger()
      const indexer = new ReplyIndexer(db as never, logger as never)

      await indexer.handleUpdate({
        ...baseParams,
        record: {
          content: { $type: 'forum.barazo.richtext#markdown' as const, value: 'Updated reply' },
          root: { uri: 'at://did:plc:test/forum.barazo.topic.post/topic1', cid: 'bafytopic' },
          parent: { uri: 'at://did:plc:test/forum.barazo.topic.post/topic1', cid: 'bafytopic' },
          community: 'did:plc:community',
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      })

      expect(db.update).toHaveBeenCalledTimes(1)
    })
  })

  describe('sanitization', () => {
    it('sanitizes content (strips scripts) on create', async () => {
      const insertValuesMock = vi.fn().mockReturnValue({
        onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
      })
      const mockTx = {
        insert: vi.fn().mockReturnValue({ values: insertValuesMock }),
        update: vi.fn().mockReturnValue({
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue(undefined),
          }),
        }),
      }
      const db = {
        ...createMockDb(),
        transaction: vi
          .fn()
          .mockImplementation(async (fn: (tx: typeof mockTx) => Promise<void>) => fn(mockTx)),
      }
      const logger = createMockLogger()
      const indexer = new ReplyIndexer(db as never, logger as never)

      await indexer.handleCreate({
        ...baseParams,
        record: {
          content: {
            $type: 'forum.barazo.richtext#markdown' as const,
            value: '<p>Reply</p><script>evil()</script>',
          },
          root: { uri: 'at://did:plc:test/forum.barazo.topic.post/topic1', cid: 'bafytopic' },
          parent: { uri: 'at://did:plc:test/forum.barazo.topic.post/topic1', cid: 'bafytopic' },
          community: 'did:plc:community',
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      })

      const values = insertValuesMock.mock.calls[0][0] as Record<string, unknown>
      expect(values.content).toContain('<p>Reply</p>')
      expect(values.content).not.toContain('<script>')
    })

    it('sanitizes content on update', async () => {
      const setMock = vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      })
      const db = {
        ...createMockDb(),
        update: vi.fn().mockReturnValue({ set: setMock }),
      }
      const logger = createMockLogger()
      const indexer = new ReplyIndexer(db as never, logger as never)

      await indexer.handleUpdate({
        ...baseParams,
        record: {
          content: {
            $type: 'forum.barazo.richtext#markdown' as const,
            value: '<p>Safe</p><iframe src="evil.com"></iframe>',
          },
          root: { uri: 'at://did:plc:test/forum.barazo.topic.post/topic1', cid: 'bafytopic' },
          parent: { uri: 'at://did:plc:test/forum.barazo.topic.post/topic1', cid: 'bafytopic' },
          community: 'did:plc:community',
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      })

      const setValues = setMock.mock.calls[0][0] as Record<string, unknown>
      expect(setValues.content).toContain('<p>Safe</p>')
      expect(setValues.content).not.toContain('<iframe')
    })

    it('strips bidi override characters from content', async () => {
      const insertValuesMock = vi.fn().mockReturnValue({
        onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
      })
      const mockTx = {
        insert: vi.fn().mockReturnValue({ values: insertValuesMock }),
        update: vi.fn().mockReturnValue({
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue(undefined),
          }),
        }),
      }
      const db = {
        ...createMockDb(),
        transaction: vi
          .fn()
          .mockImplementation(async (fn: (tx: typeof mockTx) => Promise<void>) => fn(mockTx)),
      }
      const logger = createMockLogger()
      const indexer = new ReplyIndexer(db as never, logger as never)

      await indexer.handleCreate({
        ...baseParams,
        record: {
          content: {
            $type: 'forum.barazo.richtext#markdown' as const,
            value: '<p>\u202AHello\u202E World\u200F</p>',
          },
          root: { uri: 'at://did:plc:test/forum.barazo.topic.post/topic1', cid: 'bafytopic' },
          parent: { uri: 'at://did:plc:test/forum.barazo.topic.post/topic1', cid: 'bafytopic' },
          community: 'did:plc:community',
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      })

      const values = insertValuesMock.mock.calls[0][0] as Record<string, unknown>
      expect(values.content).not.toMatch(/[\u202A-\u202E\u2066-\u2069\u200E\u200F]/)
    })
  })

  describe('handleDelete', () => {
    it('deletes a reply and decrements count in a transaction', async () => {
      const db = createMockDb()
      const logger = createMockLogger()
      const indexer = new ReplyIndexer(db as never, logger as never)

      await indexer.handleDelete({
        uri: baseParams.uri,
        rkey: baseParams.rkey,
        did: baseParams.did,
        rootUri: 'at://did:plc:test/forum.barazo.topic.post/topic1',
      })

      expect(db.transaction).toHaveBeenCalledTimes(1)
    })
  })
})
