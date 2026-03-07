import { describe, it, expect, vi, beforeEach } from 'vitest'
import { RecordHandler } from '../../../../src/firehose/handlers/record.js'
import type { RecordEvent } from '../../../../src/firehose/types.js'

function createMockIndexer() {
  return {
    handleCreate: vi.fn().mockResolvedValue(undefined),
    handleUpdate: vi.fn().mockResolvedValue(undefined),
    handleDelete: vi.fn().mockResolvedValue(undefined),
  }
}

function createMockDb() {
  return {
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
      }),
    }),
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    }),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      }),
    }),
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

function createMockAccountAgeService() {
  return {
    resolveCreationDate: vi.fn().mockResolvedValue(null),
    determineTrustStatus: vi.fn().mockReturnValue('trusted' as const),
  }
}

describe('RecordHandler', () => {
  let topicIndexer: ReturnType<typeof createMockIndexer>
  let replyIndexer: ReturnType<typeof createMockIndexer>
  let reactionIndexer: ReturnType<typeof createMockIndexer>
  let db: ReturnType<typeof createMockDb>
  let logger: ReturnType<typeof createMockLogger>
  let accountAgeService: ReturnType<typeof createMockAccountAgeService>
  let handler: RecordHandler

  beforeEach(() => {
    topicIndexer = createMockIndexer()
    replyIndexer = createMockIndexer()
    reactionIndexer = createMockIndexer()
    db = createMockDb()
    logger = createMockLogger()
    accountAgeService = createMockAccountAgeService()
    handler = new RecordHandler(
      {
        topic: topicIndexer,
        reply: replyIndexer,
        reaction: reactionIndexer,
      } as never,
      db as never,
      logger as never,
      accountAgeService as never
    )
  })

  describe('dispatch routing', () => {
    it('dispatches topic create to topic indexer', async () => {
      const event: RecordEvent = {
        id: 1,
        action: 'create',
        did: 'did:plc:test',
        rev: 'rev1',
        collection: 'forum.barazo.topic.post',
        rkey: 'abc123',
        record: {
          title: 'Test',
          content: { $type: 'forum.barazo.richtext#markdown', value: 'Content' },
          community: 'did:plc:community',
          category: 'general',
          publishedAt: '2026-01-01T00:00:00.000Z',
        },
        cid: 'bafyabc',
        live: true,
      }

      await handler.handle(event)

      expect(topicIndexer.handleCreate).toHaveBeenCalledTimes(1)
      expect(replyIndexer.handleCreate).not.toHaveBeenCalled()
    })

    it('dispatches reply create to reply indexer', async () => {
      const event: RecordEvent = {
        id: 2,
        action: 'create',
        did: 'did:plc:test',
        rev: 'rev1',
        collection: 'forum.barazo.topic.reply',
        rkey: 'reply1',
        record: {
          content: { $type: 'forum.barazo.richtext#markdown', value: 'Reply' },
          root: { uri: 'at://did:plc:test/forum.barazo.topic.post/t1', cid: 'bafyt' },
          parent: { uri: 'at://did:plc:test/forum.barazo.topic.post/t1', cid: 'bafyt' },
          community: 'did:plc:community',
          createdAt: '2026-01-01T00:00:00.000Z',
        },
        cid: 'bafyreply',
        live: true,
      }

      await handler.handle(event)

      expect(replyIndexer.handleCreate).toHaveBeenCalledTimes(1)
    })

    it('dispatches reaction create to reaction indexer', async () => {
      const event: RecordEvent = {
        id: 3,
        action: 'create',
        did: 'did:plc:test',
        rev: 'rev1',
        collection: 'forum.barazo.interaction.reaction',
        rkey: 'react1',
        record: {
          subject: { uri: 'at://did:plc:test/forum.barazo.topic.post/t1', cid: 'bafyt' },
          type: 'like',
          community: 'did:plc:community',
          createdAt: '2026-01-01T00:00:00.000Z',
        },
        cid: 'bafyreact',
        live: true,
      }

      await handler.handle(event)

      expect(reactionIndexer.handleCreate).toHaveBeenCalledTimes(1)
    })

    it('dispatches update to the correct indexer', async () => {
      const event: RecordEvent = {
        id: 4,
        action: 'update',
        did: 'did:plc:test',
        rev: 'rev2',
        collection: 'forum.barazo.topic.post',
        rkey: 'abc123',
        record: {
          title: 'Updated',
          content: { $type: 'forum.barazo.richtext#markdown', value: 'Updated content' },
          community: 'did:plc:community',
          category: 'general',
          publishedAt: '2026-01-01T00:00:00.000Z',
        },
        cid: 'bafynew',
        live: true,
      }

      await handler.handle(event)

      expect(topicIndexer.handleUpdate).toHaveBeenCalledTimes(1)
    })

    it('dispatches delete to the correct indexer', async () => {
      const event: RecordEvent = {
        id: 5,
        action: 'delete',
        did: 'did:plc:test',
        rev: 'rev3',
        collection: 'forum.barazo.topic.post',
        rkey: 'abc123',
        live: true,
      }

      await handler.handle(event)

      expect(topicIndexer.handleDelete).toHaveBeenCalledTimes(1)
    })
  })

  describe('validation rejection', () => {
    it('skips events for unsupported collections', async () => {
      const event: RecordEvent = {
        id: 6,
        action: 'create',
        did: 'did:plc:test',
        rev: 'rev1',
        collection: 'com.example.unknown',
        rkey: 'abc123',
        record: { foo: 'bar' },
        cid: 'bafyabc',
        live: true,
      }

      await handler.handle(event)

      expect(topicIndexer.handleCreate).not.toHaveBeenCalled()
      expect(replyIndexer.handleCreate).not.toHaveBeenCalled()
      expect(reactionIndexer.handleCreate).not.toHaveBeenCalled()
    })

    it('skips create events with invalid records', async () => {
      const event: RecordEvent = {
        id: 7,
        action: 'create',
        did: 'did:plc:test',
        rev: 'rev1',
        collection: 'forum.barazo.topic.post',
        rkey: 'abc123',
        record: { invalid: 'data' },
        cid: 'bafyabc',
        live: true,
      }

      await handler.handle(event)

      expect(topicIndexer.handleCreate).not.toHaveBeenCalled()
    })
  })

  describe('error catching', () => {
    it('catches and logs indexer errors without throwing', async () => {
      topicIndexer.handleCreate.mockRejectedValue(new Error('DB error'))

      const event: RecordEvent = {
        id: 8,
        action: 'create',
        did: 'did:plc:test',
        rev: 'rev1',
        collection: 'forum.barazo.topic.post',
        rkey: 'abc123',
        record: {
          title: 'Test',
          content: { $type: 'forum.barazo.richtext#markdown', value: 'Content' },
          community: 'did:plc:community',
          category: 'general',
          publishedAt: '2026-01-01T00:00:00.000Z',
        },
        cid: 'bafyabc',
        live: true,
      }

      // Should NOT throw
      await expect(handler.handle(event)).resolves.toBeUndefined()
      expect(logger.error).toHaveBeenCalled()
    })
  })

  describe('user upsert with trust check', () => {
    it('upserts a user stub on create events', async () => {
      const event: RecordEvent = {
        id: 9,
        action: 'create',
        did: 'did:plc:newuser',
        rev: 'rev1',
        collection: 'forum.barazo.topic.post',
        rkey: 'abc123',
        record: {
          title: 'Test',
          content: { $type: 'forum.barazo.richtext#markdown', value: 'Content' },
          community: 'did:plc:community',
          category: 'general',
          publishedAt: '2026-01-01T00:00:00.000Z',
        },
        cid: 'bafyabc',
        live: true,
      }

      await handler.handle(event)

      expect(db.select).toHaveBeenCalled()
      expect(accountAgeService.resolveCreationDate).toHaveBeenCalledWith('did:plc:newuser')
      expect(db.insert).toHaveBeenCalled()
    })

    it("passes trust status 'new' to indexer for new accounts", async () => {
      accountAgeService.determineTrustStatus.mockReturnValue('new')

      const event: RecordEvent = {
        id: 11,
        action: 'create',
        did: 'did:plc:brandnew',
        rev: 'rev1',
        collection: 'forum.barazo.topic.post',
        rkey: 'abc123',
        record: {
          title: 'Test',
          content: { $type: 'forum.barazo.richtext#markdown', value: 'Content' },
          community: 'did:plc:community',
          category: 'general',
          publishedAt: '2026-01-01T00:00:00.000Z',
        },
        cid: 'bafyabc',
        live: true,
      }

      await handler.handle(event)

      const call = topicIndexer.handleCreate.mock.calls[0] as [{ trustStatus: string }]
      expect(call[0].trustStatus).toBe('new')
    })

    it("passes trust status 'trusted' to indexer for established accounts", async () => {
      accountAgeService.determineTrustStatus.mockReturnValue('trusted')

      const event: RecordEvent = {
        id: 12,
        action: 'create',
        did: 'did:plc:established',
        rev: 'rev1',
        collection: 'forum.barazo.topic.post',
        rkey: 'abc123',
        record: {
          title: 'Test',
          content: { $type: 'forum.barazo.richtext#markdown', value: 'Content' },
          community: 'did:plc:community',
          category: 'general',
          publishedAt: '2026-01-01T00:00:00.000Z',
        },
        cid: 'bafyabc',
        live: true,
      }

      await handler.handle(event)

      const call = topicIndexer.handleCreate.mock.calls[0] as [{ trustStatus: string }]
      expect(call[0].trustStatus).toBe('trusted')
    })

    it('checks stored accountCreatedAt for existing users', async () => {
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000)
      db.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi
            .fn()
            .mockResolvedValue([{ did: 'did:plc:existing', accountCreatedAt: twoHoursAgo }]),
        }),
      })
      accountAgeService.determineTrustStatus.mockReturnValue('new')

      const event: RecordEvent = {
        id: 13,
        action: 'create',
        did: 'did:plc:existing',
        rev: 'rev1',
        collection: 'forum.barazo.topic.post',
        rkey: 'abc123',
        record: {
          title: 'Test',
          content: { $type: 'forum.barazo.richtext#markdown', value: 'Content' },
          community: 'did:plc:community',
          category: 'general',
          publishedAt: '2026-01-01T00:00:00.000Z',
        },
        cid: 'bafyabc',
        live: true,
      }

      await handler.handle(event)

      // Should use determineTrustStatus with the stored date, not resolve again
      expect(accountAgeService.determineTrustStatus).toHaveBeenCalledWith(twoHoursAgo)
      expect(accountAgeService.resolveCreationDate).not.toHaveBeenCalled()
    })

    it('resolves PLC creation date for existing users without accountCreatedAt', async () => {
      db.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{ did: 'did:plc:legacy', accountCreatedAt: null }]),
        }),
      })
      const resolvedDate = new Date('2026-01-01T00:00:00.000Z')
      accountAgeService.resolveCreationDate.mockResolvedValue(resolvedDate)

      const event: RecordEvent = {
        id: 14,
        action: 'create',
        did: 'did:plc:legacy',
        rev: 'rev1',
        collection: 'forum.barazo.topic.post',
        rkey: 'abc123',
        record: {
          title: 'Test',
          content: { $type: 'forum.barazo.richtext#markdown', value: 'Content' },
          community: 'did:plc:community',
          category: 'general',
          publishedAt: '2026-01-01T00:00:00.000Z',
        },
        cid: 'bafyabc',
        live: true,
      }

      await handler.handle(event)

      expect(accountAgeService.resolveCreationDate).toHaveBeenCalledWith('did:plc:legacy')
      expect(db.update).toHaveBeenCalled()
    })

    it('does not call accountAgeService for update events', async () => {
      const event: RecordEvent = {
        id: 15,
        action: 'update',
        did: 'did:plc:test',
        rev: 'rev2',
        collection: 'forum.barazo.topic.post',
        rkey: 'abc123',
        record: {
          title: 'Updated',
          content: { $type: 'forum.barazo.richtext#markdown', value: 'Updated content' },
          community: 'did:plc:community',
          category: 'general',
          publishedAt: '2026-01-01T00:00:00.000Z',
        },
        cid: 'bafynew',
        live: true,
      }

      await handler.handle(event)

      expect(accountAgeService.resolveCreationDate).not.toHaveBeenCalled()
    })

    it("defaults to 'trusted' when upsert fails", async () => {
      db.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockRejectedValue(new Error('DB error')),
        }),
      })

      const event: RecordEvent = {
        id: 16,
        action: 'create',
        did: 'did:plc:dberror',
        rev: 'rev1',
        collection: 'forum.barazo.topic.post',
        rkey: 'abc123',
        record: {
          title: 'Test',
          content: { $type: 'forum.barazo.richtext#markdown', value: 'Content' },
          community: 'did:plc:community',
          category: 'general',
          publishedAt: '2026-01-01T00:00:00.000Z',
        },
        cid: 'bafyabc',
        live: true,
      }

      await handler.handle(event)

      // Should still call the indexer with trusted (fail open)
      const call = topicIndexer.handleCreate.mock.calls[0] as [{ trustStatus: string }]
      expect(call[0].trustStatus).toBe('trusted')
    })
  })

  describe('delete with DB lookup', () => {
    it('resolves rootUri from DB for reply deletes', async () => {
      db.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi
            .fn()
            .mockResolvedValue([{ rootUri: 'at://did:plc:test/forum.barazo.topic.post/t1' }]),
        }),
      })

      const event: RecordEvent = {
        id: 20,
        action: 'delete',
        did: 'did:plc:test',
        rev: 'rev3',
        collection: 'forum.barazo.topic.reply',
        rkey: 'reply1',
        live: true,
      }

      await handler.handle(event)

      expect(replyIndexer.handleDelete).toHaveBeenCalledWith({
        uri: 'at://did:plc:test/forum.barazo.topic.reply/reply1',
        rkey: 'reply1',
        did: 'did:plc:test',
        rootUri: 'at://did:plc:test/forum.barazo.topic.post/t1',
      })
    })

    it('resolves subjectUri from DB for reaction deletes', async () => {
      db.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi
            .fn()
            .mockResolvedValue([{ subjectUri: 'at://did:plc:test/forum.barazo.topic.post/t1' }]),
        }),
      })

      const event: RecordEvent = {
        id: 21,
        action: 'delete',
        did: 'did:plc:test',
        rev: 'rev3',
        collection: 'forum.barazo.interaction.reaction',
        rkey: 'react1',
        live: true,
      }

      await handler.handle(event)

      expect(reactionIndexer.handleDelete).toHaveBeenCalledWith({
        uri: 'at://did:plc:test/forum.barazo.interaction.reaction/react1',
        rkey: 'react1',
        did: 'did:plc:test',
        subjectUri: 'at://did:plc:test/forum.barazo.topic.post/t1',
      })
    })

    it('passes empty rootUri when reply not found in DB', async () => {
      // Default mock returns [] — reply already deleted or never indexed
      const event: RecordEvent = {
        id: 22,
        action: 'delete',
        did: 'did:plc:test',
        rev: 'rev3',
        collection: 'forum.barazo.topic.reply',
        rkey: 'missing1',
        live: true,
      }

      await handler.handle(event)

      expect(replyIndexer.handleDelete).toHaveBeenCalledWith({
        uri: 'at://did:plc:test/forum.barazo.topic.reply/missing1',
        rkey: 'missing1',
        did: 'did:plc:test',
        rootUri: '',
      })
      expect(logger.debug).toHaveBeenCalled()
    })

    it('passes empty subjectUri when reaction not found in DB', async () => {
      // Default mock returns []
      const event: RecordEvent = {
        id: 23,
        action: 'delete',
        did: 'did:plc:test',
        rev: 'rev3',
        collection: 'forum.barazo.interaction.reaction',
        rkey: 'missing1',
        live: true,
      }

      await handler.handle(event)

      expect(reactionIndexer.handleDelete).toHaveBeenCalledWith({
        uri: 'at://did:plc:test/forum.barazo.interaction.reaction/missing1',
        rkey: 'missing1',
        did: 'did:plc:test',
        subjectUri: '',
      })
      expect(logger.debug).toHaveBeenCalled()
    })
  })

  describe('live flag', () => {
    it('passes live flag through to indexer', async () => {
      const event: RecordEvent = {
        id: 10,
        action: 'create',
        did: 'did:plc:test',
        rev: 'rev1',
        collection: 'forum.barazo.topic.post',
        rkey: 'abc123',
        record: {
          title: 'Test',
          content: { $type: 'forum.barazo.richtext#markdown', value: 'Content' },
          community: 'did:plc:community',
          category: 'general',
          publishedAt: '2026-01-01T00:00:00.000Z',
        },
        cid: 'bafyabc',
        live: false,
      }

      await handler.handle(event)

      const call = topicIndexer.handleCreate.mock.calls[0] as [{ live: boolean }]
      expect(call[0].live).toBe(false)
    })
  })
})
