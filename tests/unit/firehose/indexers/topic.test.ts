import { describe, it, expect, vi } from 'vitest'
import { TopicIndexer } from '../../../../src/firehose/indexers/topic.js'

function createMockDb() {
  return {
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
      }),
    }),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      }),
    }),
    delete: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(undefined),
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

describe('TopicIndexer', () => {
  const baseParams = {
    uri: 'at://did:plc:test/forum.barazo.topic.post/abc123',
    rkey: 'abc123',
    did: 'did:plc:test',
    cid: 'bafyabc',
    live: true,
  }

  describe('handleCreate', () => {
    it('upserts a topic record', async () => {
      const db = createMockDb()
      const logger = createMockLogger()
      const indexer = new TopicIndexer(db as never, logger as never)

      await indexer.handleCreate({
        ...baseParams,
        record: {
          title: 'Test Topic',
          content: { $type: 'forum.barazo.richtext#markdown' as const, value: 'Content here' },
          community: 'did:plc:community',
          category: 'general',
          tags: ['test'],
          publishedAt: '2026-01-01T00:00:00.000Z',
        },
      })

      expect(db.insert).toHaveBeenCalledTimes(1)
    })

    it('includes labels when present', async () => {
      const db = createMockDb()
      const logger = createMockLogger()
      const indexer = new TopicIndexer(db as never, logger as never)

      await indexer.handleCreate({
        ...baseParams,
        record: {
          title: 'Test',
          content: { $type: 'forum.barazo.richtext#markdown' as const, value: 'Content' },
          community: 'did:plc:community',
          category: 'general',
          labels: { values: [{ val: 'nsfw' }] },
          publishedAt: '2026-01-01T00:00:00.000Z',
        },
      })

      expect(db.insert).toHaveBeenCalledTimes(1)
    })
  })

  describe('handleUpdate', () => {
    it('updates topic content', async () => {
      const db = createMockDb()
      const logger = createMockLogger()
      const indexer = new TopicIndexer(db as never, logger as never)

      await indexer.handleUpdate({
        ...baseParams,
        record: {
          title: 'Updated Title',
          content: { $type: 'forum.barazo.richtext#markdown' as const, value: 'Updated content' },
          community: 'did:plc:community',
          category: 'updated',
          tags: ['updated'],
          publishedAt: '2026-01-01T00:00:00.000Z',
        },
      })

      expect(db.update).toHaveBeenCalledTimes(1)
    })
  })

  describe('sanitization', () => {
    it('sanitizes title (strips HTML) and content (strips scripts) on create', async () => {
      const valuesMock = vi.fn().mockReturnValue({
        onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
      })
      const db = {
        ...createMockDb(),
        insert: vi.fn().mockReturnValue({ values: valuesMock }),
      }
      const logger = createMockLogger()
      const indexer = new TopicIndexer(db as never, logger as never)

      await indexer.handleCreate({
        ...baseParams,
        record: {
          title: '<b>Bold</b> Title<script>alert("xss")</script>',
          content: {
            $type: 'forum.barazo.richtext#markdown' as const,
            value: '<p>Good</p><script>alert("xss")</script>',
          },
          community: 'did:plc:community',
          category: 'general',
          publishedAt: '2026-01-01T00:00:00.000Z',
        },
      })

      const values = valuesMock.mock.calls[0][0] as Record<string, unknown>
      // Title should have ALL HTML stripped (plain text)
      expect(values.title).not.toContain('<b>')
      expect(values.title).not.toContain('<script>')
      expect(values.title).toContain('Bold')
      // Content should keep safe tags but strip scripts
      expect(values.content).toContain('<p>Good</p>')
      expect(values.content).not.toContain('<script>')
    })

    it('sanitizes title and content on update', async () => {
      const setMock = vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      })
      const db = {
        ...createMockDb(),
        update: vi.fn().mockReturnValue({ set: setMock }),
      }
      const logger = createMockLogger()
      const indexer = new TopicIndexer(db as never, logger as never)

      await indexer.handleUpdate({
        ...baseParams,
        record: {
          title: 'Clean <img src=x onerror=alert(1)>',
          content: {
            $type: 'forum.barazo.richtext#markdown' as const,
            value: '<p>Safe</p><iframe src="evil.com"></iframe>',
          },
          community: 'did:plc:community',
          category: 'general',
          publishedAt: '2026-01-01T00:00:00.000Z',
        },
      })

      const setValues = setMock.mock.calls[0][0] as Record<string, unknown>
      expect(setValues.title).not.toContain('<img')
      expect(setValues.title).not.toContain('onerror')
      expect(setValues.content).toContain('<p>Safe</p>')
      expect(setValues.content).not.toContain('<iframe')
    })

    it('strips bidi override characters from title and content', async () => {
      const valuesMock = vi.fn().mockReturnValue({
        onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
      })
      const db = {
        ...createMockDb(),
        insert: vi.fn().mockReturnValue({ values: valuesMock }),
      }
      const logger = createMockLogger()
      const indexer = new TopicIndexer(db as never, logger as never)

      await indexer.handleCreate({
        ...baseParams,
        record: {
          title: '\u202AHello\u202E World',
          content: {
            $type: 'forum.barazo.richtext#markdown' as const,
            value: '<p>\u2066Content\u2069</p>',
          },
          community: 'did:plc:community',
          category: 'general',
          publishedAt: '2026-01-01T00:00:00.000Z',
        },
      })

      const values = valuesMock.mock.calls[0][0] as Record<string, unknown>
      expect(values.title).not.toMatch(/[\u202A-\u202E\u2066-\u2069]/)
      expect(values.content).not.toMatch(/[\u202A-\u202E\u2066-\u2069]/)
    })
  })

  describe('handleDelete', () => {
    it('soft-deletes a topic by URI', async () => {
      const db = createMockDb()
      const logger = createMockLogger()
      const indexer = new TopicIndexer(db as never, logger as never)

      await indexer.handleDelete({
        uri: baseParams.uri,
        rkey: baseParams.rkey,
        did: baseParams.did,
      })

      expect(db.update).toHaveBeenCalledTimes(1)
      expect(db.delete).not.toHaveBeenCalled()
    })
  })
})
