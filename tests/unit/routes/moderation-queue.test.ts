import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest'
import Fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import type { Env } from '../../../src/config/env.js'
import type { AuthMiddleware, RequestUser } from '../../../src/auth/middleware.js'
import type { SessionService } from '../../../src/auth/session.js'
import type { SetupService } from '../../../src/setup/service.js'
import { type DbChain, createChainableProxy, createMockDb } from '../../helpers/mock-db.js'

// ---------------------------------------------------------------------------
// Mock require-moderator
// ---------------------------------------------------------------------------

const mockRequireModerator = vi.fn()

vi.mock('../../../src/auth/require-moderator.js', () => ({
  createRequireModerator: () => mockRequireModerator,
}))

// Import routes AFTER mocking
import { moderationQueueRoutes } from '../../../src/routes/moderation-queue.js'

// ---------------------------------------------------------------------------
// Mock env
// ---------------------------------------------------------------------------

const mockEnv = {
  COMMUNITY_DID: 'did:plc:community123',
} as Env

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MOD_DID = 'did:plc:moderator999'
const AUTHOR_DID = 'did:plc:author123'
const CONTENT_URI = 'at://did:plc:author123/forum.barazo.topic.post/abc123'

function modUser(): RequestUser {
  return { did: MOD_DID, handle: 'mod.bsky.social', sid: 'a'.repeat(64) }
}

// ---------------------------------------------------------------------------
// Response types
// ---------------------------------------------------------------------------

interface QueueItem {
  id: number
  contentUri: string
  contentType: string
  authorDid: string
  communityDid: string
  queueReason: string
  matchedWords: string[] | null
  status: string
  reviewedBy: string | null
  createdAt: string
  reviewedAt: string | null
}

interface QueueListResponse {
  items: QueueItem[]
  cursor: string | null
}

interface WordFilterResponse {
  words: string[]
}

// ---------------------------------------------------------------------------
// Mock DB and cache
// ---------------------------------------------------------------------------

const mockDb = createMockDb()
const mockCache = {
  get: vi.fn().mockResolvedValue(null),
  set: vi.fn().mockResolvedValue('OK'),
  del: vi.fn().mockResolvedValue(1),
}

let insertChain: DbChain
let selectChain: DbChain
let updateChain: DbChain

function resetAllDbMocks(): void {
  insertChain = createChainableProxy()
  selectChain = createChainableProxy([])
  updateChain = createChainableProxy([])
  mockDb.insert.mockReturnValue(insertChain)
  mockDb.select.mockReturnValue(selectChain)
  mockDb.update.mockReturnValue(updateChain)
  // eslint-disable-next-line @typescript-eslint/no-misused-promises
  mockDb.transaction.mockImplementation(async (fn: (tx: typeof mockDb) => Promise<void>) => {
    await fn(mockDb)
  })
}

// ---------------------------------------------------------------------------
// App builder
// ---------------------------------------------------------------------------

function createMockAuthMiddleware(user?: RequestUser): AuthMiddleware {
  return {
    requireAuth: async (request, reply) => {
      if (!user) {
        await reply.status(401).send({ error: 'Authentication required' })
        return
      }
      request.user = user
    },
    optionalAuth: (request, _reply) => {
      if (user) {
        request.user = user
      }
      return Promise.resolve()
    },
  }
}

async function buildTestApp(user?: RequestUser): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })

  app.decorate('db', mockDb as never)
  app.decorate('env', mockEnv)
  app.decorate('authMiddleware', createMockAuthMiddleware(user))
  app.decorate('cache', mockCache as never)
  app.decorate('requireAdmin', mockRequireModerator)
  app.decorate('sessionService', {} as SessionService)
  app.decorate('setupService', {} as SetupService)
  app.decorateRequest('user', undefined as RequestUser | undefined)
  app.decorateRequest('communityDid', undefined as string | undefined)
  app.addHook('onRequest', async (request) => {
    request.communityDid = 'did:plc:test'
  })

  mockRequireModerator.mockImplementation((request: { user: RequestUser | undefined }) => {
    if (user) {
      request.user = user
    }
    return Promise.resolve()
  })

  await app.register(moderationQueueRoutes())
  await app.ready()

  return app
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('moderation queue routes', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    app = await buildTestApp(modUser())
  })

  afterAll(async () => {
    await app.close()
  })

  beforeEach(() => {
    resetAllDbMocks()
    vi.clearAllMocks()
    mockRequireModerator.mockImplementation((request: { user: RequestUser | undefined }) => {
      request.user = modUser()
      return Promise.resolve()
    })
  })

  describe('GET /api/moderation/queue', () => {
    it('returns empty queue when no pending items', async () => {
      selectChain = createChainableProxy([])
      mockDb.select.mockReturnValue(selectChain)

      const response = await app.inject({
        method: 'GET',
        url: '/api/moderation/queue',
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<QueueListResponse>()
      expect(body.items).toEqual([])
      expect(body.cursor).toBeNull()
    })

    it('returns queue items with cursor pagination', async () => {
      const now = new Date()
      const items = [
        {
          id: 2,
          contentUri: CONTENT_URI,
          contentType: 'topic',
          authorDid: AUTHOR_DID,
          communityDid: 'did:plc:community123',
          queueReason: 'word_filter',
          matchedWords: ['spam'],
          status: 'pending',
          reviewedBy: null,
          createdAt: now,
          reviewedAt: null,
        },
        {
          id: 1,
          contentUri: 'at://did:plc:author123/forum.barazo.topic.post/def456',
          contentType: 'reply',
          authorDid: AUTHOR_DID,
          communityDid: 'did:plc:community123',
          queueReason: 'first_post',
          matchedWords: null,
          status: 'pending',
          reviewedBy: null,
          createdAt: new Date(now.getTime() - 1000),
          reviewedAt: null,
        },
      ]

      selectChain = createChainableProxy(items)
      mockDb.select.mockReturnValue(selectChain)

      const response = await app.inject({
        method: 'GET',
        url: '/api/moderation/queue?status=pending',
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<QueueListResponse>()
      expect(body.items).toHaveLength(2)
      expect(body.items[0].queueReason).toBe('word_filter')
      expect(body.items[0].matchedWords).toEqual(['spam'])
    })

    it('filters by queueReason when provided', async () => {
      const now = new Date()
      const items = [
        {
          id: 3,
          contentUri: CONTENT_URI,
          contentType: 'topic',
          authorDid: AUTHOR_DID,
          communityDid: 'did:plc:community123',
          queueReason: 'word_filter',
          matchedWords: ['badword'],
          status: 'pending',
          reviewedBy: null,
          createdAt: now,
          reviewedAt: null,
        },
      ]

      selectChain = createChainableProxy(items)
      mockDb.select.mockReturnValue(selectChain)

      const response = await app.inject({
        method: 'GET',
        url: '/api/moderation/queue?status=pending&queueReason=word_filter',
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<QueueListResponse>()
      expect(body.items).toHaveLength(1)
      expect(body.items[0].queueReason).toBe('word_filter')
    })

    it('applies cursor-based pagination with a valid cursor', async () => {
      const now = new Date()
      const cursor = Buffer.from(JSON.stringify({ createdAt: now.toISOString(), id: 5 })).toString(
        'base64'
      )

      selectChain = createChainableProxy([])
      mockDb.select.mockReturnValue(selectChain)

      const response = await app.inject({
        method: 'GET',
        url: `/api/moderation/queue?status=pending&cursor=${cursor}`,
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<QueueListResponse>()
      expect(body.items).toEqual([])
      expect(body.cursor).toBeNull()
    })

    it('ignores an invalid (non-base64) cursor gracefully', async () => {
      selectChain = createChainableProxy([])
      mockDb.select.mockReturnValue(selectChain)

      const response = await app.inject({
        method: 'GET',
        url: '/api/moderation/queue?status=pending&cursor=not-valid-base64!!!',
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<QueueListResponse>()
      expect(body.items).toEqual([])
    })

    it('ignores a cursor with valid JSON but wrong shape', async () => {
      const badCursor = Buffer.from(JSON.stringify({ foo: 'bar' })).toString('base64')

      selectChain = createChainableProxy([])
      mockDb.select.mockReturnValue(selectChain)

      const response = await app.inject({
        method: 'GET',
        url: `/api/moderation/queue?status=pending&cursor=${badCursor}`,
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<QueueListResponse>()
      expect(body.items).toEqual([])
    })

    it('returns a next cursor when hasMore is true', async () => {
      const now = new Date()
      // Default limit is 25. Create 26 items so rows.length > limit triggers hasMore.
      const items = Array.from({ length: 26 }, (_, i) => ({
        id: 26 - i,
        contentUri: `at://did:plc:author123/forum.barazo.topic.post/item${String(26 - i)}`,
        contentType: 'topic',
        authorDid: AUTHOR_DID,
        communityDid: 'did:plc:community123',
        queueReason: 'first_post' as const,
        matchedWords: null,
        status: 'pending',
        reviewedBy: null,
        createdAt: new Date(now.getTime() - i * 1000),
        reviewedAt: null,
      }))

      selectChain = createChainableProxy(items)
      mockDb.select.mockReturnValue(selectChain)

      const response = await app.inject({
        method: 'GET',
        url: '/api/moderation/queue?status=pending',
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<QueueListResponse>()
      expect(body.items).toHaveLength(25)
      expect(body.cursor).not.toBeNull()
      // Cursor should be decodable back to the last item's data
      const decoded = JSON.parse(
        Buffer.from(body.cursor as string, 'base64').toString('utf-8')
      ) as { createdAt: string; id: number }
      expect(decoded.id).toBe(items[24].id)
    })

    it('returns a next cursor with custom limit', async () => {
      const now = new Date()
      // limit=2, so need 3 items to trigger hasMore
      const items = Array.from({ length: 3 }, (_, i) => ({
        id: 3 - i,
        contentUri: `at://did:plc:author123/forum.barazo.topic.post/item${String(3 - i)}`,
        contentType: 'topic',
        authorDid: AUTHOR_DID,
        communityDid: 'did:plc:community123',
        queueReason: 'first_post' as const,
        matchedWords: null,
        status: 'pending',
        reviewedBy: null,
        createdAt: new Date(now.getTime() - i * 1000),
        reviewedAt: null,
      }))

      selectChain = createChainableProxy(items)
      mockDb.select.mockReturnValue(selectChain)

      const response = await app.inject({
        method: 'GET',
        url: '/api/moderation/queue?status=pending&limit=2',
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<QueueListResponse>()
      expect(body.items).toHaveLength(2)
      expect(body.cursor).not.toBeNull()
    })

    it('returns 400 when Zod validation fails (limit=0 below min)', async () => {
      selectChain = createChainableProxy([])
      mockDb.select.mockReturnValue(selectChain)

      const response = await app.inject({
        method: 'GET',
        url: '/api/moderation/queue?status=pending&limit=0',
      })

      expect(response.statusCode).toBe(400)
    })

    it('returns 400 when Zod validation fails (limit exceeds max)', async () => {
      selectChain = createChainableProxy([])
      mockDb.select.mockReturnValue(selectChain)

      const response = await app.inject({
        method: 'GET',
        url: '/api/moderation/queue?status=pending&limit=999',
      })

      expect(response.statusCode).toBe(400)
    })

    it('filters by approved status', async () => {
      const now = new Date()
      const reviewedAt = new Date(now.getTime() + 1000)
      const items = [
        {
          id: 5,
          contentUri: CONTENT_URI,
          contentType: 'topic',
          authorDid: AUTHOR_DID,
          communityDid: 'did:plc:community123',
          queueReason: 'word_filter',
          matchedWords: ['spam'],
          status: 'approved',
          reviewedBy: MOD_DID,
          createdAt: now,
          reviewedAt,
        },
      ]

      selectChain = createChainableProxy(items)
      mockDb.select.mockReturnValue(selectChain)

      const response = await app.inject({
        method: 'GET',
        url: '/api/moderation/queue?status=approved',
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<QueueListResponse>()
      expect(body.items).toHaveLength(1)
      expect(body.items[0].status).toBe('approved')
      expect(body.items[0].reviewedBy).toBe(MOD_DID)
      expect(body.items[0].reviewedAt).toBe(reviewedAt.toISOString())
    })
  })

  describe('PUT /api/moderation/queue/:id', () => {
    it('approves a queued item', async () => {
      const now = new Date()
      const queueItem = {
        id: 1,
        contentUri: CONTENT_URI,
        contentType: 'topic',
        authorDid: AUTHOR_DID,
        communityDid: 'did:plc:community123',
        queueReason: 'word_filter',
        matchedWords: ['spam'],
        status: 'pending',
        reviewedBy: null,
        createdAt: now,
        reviewedAt: null,
      }

      // First select: fetch queue item
      const fetchChain = createChainableProxy([queueItem])
      mockDb.select.mockReturnValueOnce(fetchChain)

      // Inside transaction:
      // other pending items for same URI
      const otherPendingChain = createChainableProxy([])
      mockDb.select.mockReturnValueOnce(otherPendingChain)
      // existing trust record
      const trustChain = createChainableProxy([])
      mockDb.select.mockReturnValueOnce(trustChain)
      // community settings for threshold
      const settingsChain = createChainableProxy([
        {
          moderationThresholds: {
            trustedPostThreshold: 10,
          },
        },
      ])
      mockDb.select.mockReturnValueOnce(settingsChain)

      // Final select: updated queue item
      const updatedItem = { ...queueItem, status: 'approved', reviewedBy: MOD_DID, reviewedAt: now }
      const finalChain = createChainableProxy([updatedItem])
      mockDb.select.mockReturnValueOnce(finalChain)

      const response = await app.inject({
        method: 'PUT',
        url: '/api/moderation/queue/1',
        payload: { action: 'approve' },
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<QueueItem>()
      expect(body.status).toBe('approved')
      expect(body.reviewedBy).toBe(MOD_DID)
    })

    it('rejects already-reviewed items with 409', async () => {
      const queueItem = {
        id: 1,
        contentUri: CONTENT_URI,
        contentType: 'topic',
        authorDid: AUTHOR_DID,
        communityDid: 'did:plc:community123',
        queueReason: 'word_filter',
        matchedWords: null,
        status: 'approved',
        reviewedBy: MOD_DID,
        createdAt: new Date(),
        reviewedAt: new Date(),
      }

      const fetchChain = createChainableProxy([queueItem])
      mockDb.select.mockReturnValue(fetchChain)

      const response = await app.inject({
        method: 'PUT',
        url: '/api/moderation/queue/1',
        payload: { action: 'approve' },
      })

      expect(response.statusCode).toBe(409)
    })

    it('returns 404 for non-existent queue item', async () => {
      const fetchChain = createChainableProxy([])
      mockDb.select.mockReturnValue(fetchChain)

      const response = await app.inject({
        method: 'PUT',
        url: '/api/moderation/queue/999',
        payload: { action: 'approve' },
      })

      expect(response.statusCode).toBe(404)
    })

    it('returns 401 when user is not authenticated', async () => {
      // Override the preHandler to NOT set request.user
      mockRequireModerator.mockImplementation(() => {
        return Promise.resolve()
      })

      const fetchChain = createChainableProxy([])
      mockDb.select.mockReturnValue(fetchChain)

      const response = await app.inject({
        method: 'PUT',
        url: '/api/moderation/queue/1',
        payload: { action: 'approve' },
      })

      expect(response.statusCode).toBe(401)
    })

    it('returns 400 for non-numeric queue item ID', async () => {
      const response = await app.inject({
        method: 'PUT',
        url: '/api/moderation/queue/abc',
        payload: { action: 'approve' },
      })

      expect(response.statusCode).toBe(400)
    })

    it('returns 400 for invalid action in body', async () => {
      const response = await app.inject({
        method: 'PUT',
        url: '/api/moderation/queue/1',
        payload: { action: 'invalid_action' },
      })

      expect(response.statusCode).toBe(400)
    })

    it('rejects a queued item (sets status to rejected)', async () => {
      const now = new Date()
      const queueItem = {
        id: 2,
        contentUri: CONTENT_URI,
        contentType: 'topic',
        authorDid: AUTHOR_DID,
        communityDid: 'did:plc:community123',
        queueReason: 'word_filter',
        matchedWords: ['spam'],
        status: 'pending',
        reviewedBy: null,
        createdAt: now,
        reviewedAt: null,
      }

      // First select: fetch queue item
      const fetchChain = createChainableProxy([queueItem])
      mockDb.select.mockReturnValueOnce(fetchChain)

      // Final select: updated queue item
      const updatedItem = {
        ...queueItem,
        status: 'rejected',
        reviewedBy: MOD_DID,
        reviewedAt: now,
      }
      const finalChain = createChainableProxy([updatedItem])
      mockDb.select.mockReturnValueOnce(finalChain)

      const response = await app.inject({
        method: 'PUT',
        url: '/api/moderation/queue/2',
        payload: { action: 'reject' },
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<QueueItem>()
      expect(body.status).toBe('rejected')
      expect(body.reviewedBy).toBe(MOD_DID)
    })

    it('updates reply content (not topic) when contentType is reply', async () => {
      const now = new Date()
      const replyUri = 'at://did:plc:author123/forum.barazo.reply/reply1'
      const queueItem = {
        id: 3,
        contentUri: replyUri,
        contentType: 'reply',
        authorDid: AUTHOR_DID,
        communityDid: 'did:plc:community123',
        queueReason: 'first_post',
        matchedWords: null,
        status: 'pending',
        reviewedBy: null,
        createdAt: now,
        reviewedAt: null,
      }

      // First select: fetch queue item
      const fetchChain = createChainableProxy([queueItem])
      mockDb.select.mockReturnValueOnce(fetchChain)

      // Inside transaction:
      // other pending items for same URI
      const otherPendingChain = createChainableProxy([])
      mockDb.select.mockReturnValueOnce(otherPendingChain)
      // existing trust record
      const trustChain = createChainableProxy([])
      mockDb.select.mockReturnValueOnce(trustChain)
      // community settings for threshold
      const settingsChain = createChainableProxy([
        { moderationThresholds: { trustedPostThreshold: 10 } },
      ])
      mockDb.select.mockReturnValueOnce(settingsChain)

      // Final select: updated queue item
      const updatedItem = {
        ...queueItem,
        status: 'approved',
        reviewedBy: MOD_DID,
        reviewedAt: now,
      }
      const finalChain = createChainableProxy([updatedItem])
      mockDb.select.mockReturnValueOnce(finalChain)

      const response = await app.inject({
        method: 'PUT',
        url: '/api/moderation/queue/3',
        payload: { action: 'approve' },
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<QueueItem>()
      expect(body.status).toBe('approved')
      expect(body.contentType).toBe('reply')
      // Verify update was called (for both queue item update and reply update)
      expect(mockDb.update).toHaveBeenCalled()
    })

    it('bulk-approves other pending items for the same content URI on approve', async () => {
      const now = new Date()
      const queueItem = {
        id: 4,
        contentUri: CONTENT_URI,
        contentType: 'topic',
        authorDid: AUTHOR_DID,
        communityDid: 'did:plc:community123',
        queueReason: 'word_filter',
        matchedWords: ['spam'],
        status: 'pending',
        reviewedBy: null,
        createdAt: now,
        reviewedAt: null,
      }

      // First select: fetch queue item
      const fetchChain = createChainableProxy([queueItem])
      mockDb.select.mockReturnValueOnce(fetchChain)

      // Inside transaction:
      // other pending items for same URI -- return one existing pending item
      const otherPendingChain = createChainableProxy([{ id: 5 }])
      mockDb.select.mockReturnValueOnce(otherPendingChain)
      // existing trust record
      const trustChain = createChainableProxy([])
      mockDb.select.mockReturnValueOnce(trustChain)
      // community settings for threshold
      const settingsChain = createChainableProxy([
        { moderationThresholds: { trustedPostThreshold: 10 } },
      ])
      mockDb.select.mockReturnValueOnce(settingsChain)

      // Final select: updated queue item
      const updatedItem = {
        ...queueItem,
        status: 'approved',
        reviewedBy: MOD_DID,
        reviewedAt: now,
      }
      const finalChain = createChainableProxy([updatedItem])
      mockDb.select.mockReturnValueOnce(finalChain)

      const response = await app.inject({
        method: 'PUT',
        url: '/api/moderation/queue/4',
        payload: { action: 'approve' },
      })

      expect(response.statusCode).toBe(200)
      // update called for: queue item, topic content, bulk-approve other pending, account trust insert
      expect(mockDb.update).toHaveBeenCalled()
    })

    it('updates existing trust record and sets trustedAt when threshold met', async () => {
      const now = new Date()
      const queueItem = {
        id: 6,
        contentUri: CONTENT_URI,
        contentType: 'topic',
        authorDid: AUTHOR_DID,
        communityDid: 'did:plc:community123',
        queueReason: 'first_post',
        matchedWords: null,
        status: 'pending',
        reviewedBy: null,
        createdAt: now,
        reviewedAt: null,
      }

      // First select: fetch queue item
      const fetchChain = createChainableProxy([queueItem])
      mockDb.select.mockReturnValueOnce(fetchChain)

      // Inside transaction:
      // other pending items
      const otherPendingChain = createChainableProxy([])
      mockDb.select.mockReturnValueOnce(otherPendingChain)
      // existing trust record with approvedPostCount at 9 (threshold is 10, so 9+1=10 triggers trusted)
      const trustChain = createChainableProxy([
        {
          did: AUTHOR_DID,
          communityDid: 'did:plc:community123',
          approvedPostCount: 9,
          isTrusted: false,
          trustedAt: null,
        },
      ])
      mockDb.select.mockReturnValueOnce(trustChain)
      // community settings for threshold
      const settingsChain = createChainableProxy([
        { moderationThresholds: { trustedPostThreshold: 10 } },
      ])
      mockDb.select.mockReturnValueOnce(settingsChain)

      // Final select: updated queue item
      const updatedItem = {
        ...queueItem,
        status: 'approved',
        reviewedBy: MOD_DID,
        reviewedAt: now,
      }
      const finalChain = createChainableProxy([updatedItem])
      mockDb.select.mockReturnValueOnce(finalChain)

      const response = await app.inject({
        method: 'PUT',
        url: '/api/moderation/queue/6',
        payload: { action: 'approve' },
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<QueueItem>()
      expect(body.status).toBe('approved')
      // trust update should have been called
      expect(mockDb.update).toHaveBeenCalled()
    })

    it('updates existing trust record without setting trustedAt when already trusted', async () => {
      const now = new Date()
      const queueItem = {
        id: 7,
        contentUri: CONTENT_URI,
        contentType: 'topic',
        authorDid: AUTHOR_DID,
        communityDid: 'did:plc:community123',
        queueReason: 'first_post',
        matchedWords: null,
        status: 'pending',
        reviewedBy: null,
        createdAt: now,
        reviewedAt: null,
      }

      // First select: fetch queue item
      const fetchChain = createChainableProxy([queueItem])
      mockDb.select.mockReturnValueOnce(fetchChain)

      // Inside transaction:
      // other pending items
      const otherPendingChain = createChainableProxy([])
      mockDb.select.mockReturnValueOnce(otherPendingChain)
      // existing trust record already trusted
      const trustChain = createChainableProxy([
        {
          did: AUTHOR_DID,
          communityDid: 'did:plc:community123',
          approvedPostCount: 15,
          isTrusted: true,
          trustedAt: new Date('2026-01-01'),
        },
      ])
      mockDb.select.mockReturnValueOnce(trustChain)
      // community settings for threshold
      const settingsChain = createChainableProxy([
        { moderationThresholds: { trustedPostThreshold: 10 } },
      ])
      mockDb.select.mockReturnValueOnce(settingsChain)

      // Final select: updated queue item
      const updatedItem = {
        ...queueItem,
        status: 'approved',
        reviewedBy: MOD_DID,
        reviewedAt: now,
      }
      const finalChain = createChainableProxy([updatedItem])
      mockDb.select.mockReturnValueOnce(finalChain)

      const response = await app.inject({
        method: 'PUT',
        url: '/api/moderation/queue/7',
        payload: { action: 'approve' },
      })

      expect(response.statusCode).toBe(200)
      expect(response.json<QueueItem>().status).toBe('approved')
    })

    it('updates existing trust record below threshold (not yet trusted)', async () => {
      const now = new Date()
      const queueItem = {
        id: 8,
        contentUri: CONTENT_URI,
        contentType: 'topic',
        authorDid: AUTHOR_DID,
        communityDid: 'did:plc:community123',
        queueReason: 'first_post',
        matchedWords: null,
        status: 'pending',
        reviewedBy: null,
        createdAt: now,
        reviewedAt: null,
      }

      // First select: fetch queue item
      const fetchChain = createChainableProxy([queueItem])
      mockDb.select.mockReturnValueOnce(fetchChain)

      // Inside transaction:
      const otherPendingChain = createChainableProxy([])
      mockDb.select.mockReturnValueOnce(otherPendingChain)
      // existing trust record with low count
      const trustChain = createChainableProxy([
        {
          did: AUTHOR_DID,
          communityDid: 'did:plc:community123',
          approvedPostCount: 2,
          isTrusted: false,
          trustedAt: null,
        },
      ])
      mockDb.select.mockReturnValueOnce(trustChain)
      // community settings for threshold
      const settingsChain = createChainableProxy([
        { moderationThresholds: { trustedPostThreshold: 10 } },
      ])
      mockDb.select.mockReturnValueOnce(settingsChain)

      // Final select: updated queue item
      const updatedItem = {
        ...queueItem,
        status: 'approved',
        reviewedBy: MOD_DID,
        reviewedAt: now,
      }
      const finalChain = createChainableProxy([updatedItem])
      mockDb.select.mockReturnValueOnce(finalChain)

      const response = await app.inject({
        method: 'PUT',
        url: '/api/moderation/queue/8',
        payload: { action: 'approve' },
      })

      expect(response.statusCode).toBe(200)
      expect(response.json<QueueItem>().status).toBe('approved')
    })

    it('handles existing trust record with null approvedPostCount', async () => {
      const now = new Date()
      const queueItem = {
        id: 13,
        contentUri: CONTENT_URI,
        contentType: 'topic',
        authorDid: AUTHOR_DID,
        communityDid: 'did:plc:community123',
        queueReason: 'first_post',
        matchedWords: null,
        status: 'pending',
        reviewedBy: null,
        createdAt: now,
        reviewedAt: null,
      }

      // First select: fetch queue item
      const fetchChain = createChainableProxy([queueItem])
      mockDb.select.mockReturnValueOnce(fetchChain)

      // Inside transaction:
      const otherPendingChain = createChainableProxy([])
      mockDb.select.mockReturnValueOnce(otherPendingChain)
      // existing trust record with null approvedPostCount to trigger ?? 0 fallback
      const trustChain = createChainableProxy([
        {
          did: AUTHOR_DID,
          communityDid: 'did:plc:community123',
          approvedPostCount: null,
          isTrusted: false,
          trustedAt: null,
        },
      ])
      mockDb.select.mockReturnValueOnce(trustChain)
      // community settings for threshold
      const settingsChain = createChainableProxy([
        { moderationThresholds: { trustedPostThreshold: 10 } },
      ])
      mockDb.select.mockReturnValueOnce(settingsChain)

      // Final select: updated queue item
      const updatedItem = {
        ...queueItem,
        status: 'approved',
        reviewedBy: MOD_DID,
        reviewedAt: now,
      }
      const finalChain = createChainableProxy([updatedItem])
      mockDb.select.mockReturnValueOnce(finalChain)

      const response = await app.inject({
        method: 'PUT',
        url: '/api/moderation/queue/13',
        payload: { action: 'approve' },
      })

      expect(response.statusCode).toBe(200)
      expect(response.json<QueueItem>().status).toBe('approved')
    })

    it('inserts new trust record with trustedAt when threshold is 1', async () => {
      const now = new Date()
      const queueItem = {
        id: 9,
        contentUri: CONTENT_URI,
        contentType: 'topic',
        authorDid: AUTHOR_DID,
        communityDid: 'did:plc:community123',
        queueReason: 'first_post',
        matchedWords: null,
        status: 'pending',
        reviewedBy: null,
        createdAt: now,
        reviewedAt: null,
      }

      // First select: fetch queue item
      const fetchChain = createChainableProxy([queueItem])
      mockDb.select.mockReturnValueOnce(fetchChain)

      // Inside transaction:
      const otherPendingChain = createChainableProxy([])
      mockDb.select.mockReturnValueOnce(otherPendingChain)
      // No existing trust record
      const trustChain = createChainableProxy([])
      mockDb.select.mockReturnValueOnce(trustChain)
      // community settings with threshold of 1 (immediately trusted)
      const settingsChain = createChainableProxy([
        { moderationThresholds: { trustedPostThreshold: 1 } },
      ])
      mockDb.select.mockReturnValueOnce(settingsChain)

      // Final select: updated queue item
      const updatedItem = {
        ...queueItem,
        status: 'approved',
        reviewedBy: MOD_DID,
        reviewedAt: now,
      }
      const finalChain = createChainableProxy([updatedItem])
      mockDb.select.mockReturnValueOnce(finalChain)

      const response = await app.inject({
        method: 'PUT',
        url: '/api/moderation/queue/9',
        payload: { action: 'approve' },
      })

      expect(response.statusCode).toBe(200)
      expect(response.json<QueueItem>().status).toBe('approved')
      // insert should have been called for new trust record
      expect(mockDb.insert).toHaveBeenCalled()
    })

    it('uses default threshold of 10 when community settings are empty', async () => {
      const now = new Date()
      const queueItem = {
        id: 10,
        contentUri: CONTENT_URI,
        contentType: 'topic',
        authorDid: AUTHOR_DID,
        communityDid: 'did:plc:community123',
        queueReason: 'first_post',
        matchedWords: null,
        status: 'pending',
        reviewedBy: null,
        createdAt: now,
        reviewedAt: null,
      }

      // First select: fetch queue item
      const fetchChain = createChainableProxy([queueItem])
      mockDb.select.mockReturnValueOnce(fetchChain)

      // Inside transaction:
      const otherPendingChain = createChainableProxy([])
      mockDb.select.mockReturnValueOnce(otherPendingChain)
      // No existing trust record
      const trustChain = createChainableProxy([])
      mockDb.select.mockReturnValueOnce(trustChain)
      // Empty settings rows -- fallback to default threshold of 10
      const settingsChain = createChainableProxy([])
      mockDb.select.mockReturnValueOnce(settingsChain)

      // Final select: updated queue item
      const updatedItem = {
        ...queueItem,
        status: 'approved',
        reviewedBy: MOD_DID,
        reviewedAt: now,
      }
      const finalChain = createChainableProxy([updatedItem])
      mockDb.select.mockReturnValueOnce(finalChain)

      const response = await app.inject({
        method: 'PUT',
        url: '/api/moderation/queue/10',
        payload: { action: 'approve' },
      })

      expect(response.statusCode).toBe(200)
      expect(response.json<QueueItem>().status).toBe('approved')
    })

    it('returns 404 when updated item is not found after update', async () => {
      const now = new Date()
      const queueItem = {
        id: 11,
        contentUri: CONTENT_URI,
        contentType: 'topic',
        authorDid: AUTHOR_DID,
        communityDid: 'did:plc:community123',
        queueReason: 'word_filter',
        matchedWords: null,
        status: 'pending',
        reviewedBy: null,
        createdAt: now,
        reviewedAt: null,
      }

      // First select: fetch queue item
      const fetchChain = createChainableProxy([queueItem])
      mockDb.select.mockReturnValueOnce(fetchChain)

      // Inside transaction:
      const otherPendingChain = createChainableProxy([])
      mockDb.select.mockReturnValueOnce(otherPendingChain)
      const trustChain = createChainableProxy([])
      mockDb.select.mockReturnValueOnce(trustChain)
      const settingsChain = createChainableProxy([
        { moderationThresholds: { trustedPostThreshold: 10 } },
      ])
      mockDb.select.mockReturnValueOnce(settingsChain)

      // Final select: updated item NOT FOUND (empty)
      const finalChain = createChainableProxy([])
      mockDb.select.mockReturnValueOnce(finalChain)

      const response = await app.inject({
        method: 'PUT',
        url: '/api/moderation/queue/11',
        payload: { action: 'approve' },
      })

      expect(response.statusCode).toBe(404)
    })

    it('does not increment trust on reject', async () => {
      const now = new Date()
      const replyUri = 'at://did:plc:author123/forum.barazo.reply/reply2'
      const queueItem = {
        id: 12,
        contentUri: replyUri,
        contentType: 'reply',
        authorDid: AUTHOR_DID,
        communityDid: 'did:plc:community123',
        queueReason: 'link_hold',
        matchedWords: null,
        status: 'pending',
        reviewedBy: null,
        createdAt: now,
        reviewedAt: null,
      }

      // First select: fetch queue item
      const fetchChain = createChainableProxy([queueItem])
      mockDb.select.mockReturnValueOnce(fetchChain)

      // Final select: updated queue item (reject skips trust logic, so fewer selects)
      const updatedItem = {
        ...queueItem,
        status: 'rejected',
        reviewedBy: MOD_DID,
        reviewedAt: now,
      }
      const finalChain = createChainableProxy([updatedItem])
      mockDb.select.mockReturnValueOnce(finalChain)

      const response = await app.inject({
        method: 'PUT',
        url: '/api/moderation/queue/12',
        payload: { action: 'reject' },
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<QueueItem>()
      expect(body.status).toBe('rejected')
      // insert should NOT have been called (no trust upsert on reject)
      expect(mockDb.insert).not.toHaveBeenCalled()
    })
  })

  describe('GET /api/admin/moderation/word-filter', () => {
    it('returns current word filter list', async () => {
      const chain = createChainableProxy([{ wordFilter: ['spam', 'scam'] }])
      mockDb.select.mockReturnValue(chain)

      const response = await app.inject({
        method: 'GET',
        url: '/api/admin/moderation/word-filter',
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<WordFilterResponse>()
      expect(body.words).toEqual(['spam', 'scam'])
    })

    it('returns empty array when no filter set', async () => {
      const chain = createChainableProxy([{ wordFilter: [] }])
      mockDb.select.mockReturnValue(chain)

      const response = await app.inject({
        method: 'GET',
        url: '/api/admin/moderation/word-filter',
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<WordFilterResponse>()
      expect(body.words).toEqual([])
    })

    it('returns empty array when no settings row exists', async () => {
      const chain = createChainableProxy([])
      mockDb.select.mockReturnValue(chain)

      const response = await app.inject({
        method: 'GET',
        url: '/api/admin/moderation/word-filter',
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<WordFilterResponse>()
      expect(body.words).toEqual([])
    })
  })

  describe('PUT /api/admin/moderation/word-filter', () => {
    it('updates word filter list', async () => {
      const response = await app.inject({
        method: 'PUT',
        url: '/api/admin/moderation/word-filter',
        payload: { words: ['Spam', 'SCAM', 'fraud'] },
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<WordFilterResponse>()
      // Should be deduplicated and lowercased
      expect(body.words).toEqual(['spam', 'scam', 'fraud'])
      expect(mockDb.update).toHaveBeenCalled()
    })

    it('rejects invalid payload', async () => {
      const response = await app.inject({
        method: 'PUT',
        url: '/api/admin/moderation/word-filter',
        payload: { words: '' },
      })

      expect(response.statusCode).toBe(400)
    })

    it('deduplicates identical words after lowercasing', async () => {
      const response = await app.inject({
        method: 'PUT',
        url: '/api/admin/moderation/word-filter',
        payload: { words: ['Spam', 'spam', 'SPAM'] },
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<WordFilterResponse>()
      expect(body.words).toEqual(['spam'])
    })

    it('succeeds even when cache.del throws', async () => {
      mockCache.del.mockRejectedValueOnce(new Error('cache unavailable'))

      const response = await app.inject({
        method: 'PUT',
        url: '/api/admin/moderation/word-filter',
        payload: { words: ['test'] },
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<WordFilterResponse>()
      expect(body.words).toEqual(['test'])
    })

    it('handles empty word list', async () => {
      const response = await app.inject({
        method: 'PUT',
        url: '/api/admin/moderation/word-filter',
        payload: { words: [] },
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<WordFilterResponse>()
      expect(body.words).toEqual([])
    })
  })
})
