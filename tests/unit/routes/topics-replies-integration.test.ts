import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest'
import Fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import type { Env } from '../../../src/config/env.js'
import type { AuthMiddleware, RequestUser } from '../../../src/auth/middleware.js'
import type { SessionService } from '../../../src/auth/session.js'
import type { SetupService } from '../../../src/setup/service.js'
import { type DbChain, createChainableProxy, createMockDb } from '../../helpers/mock-db.js'

// ---------------------------------------------------------------------------
// Mock PDS client module (must be before importing routes)
// ---------------------------------------------------------------------------

const createRecordFn =
  vi.fn<
    (
      did: string,
      collection: string,
      record: Record<string, unknown>
    ) => Promise<{ uri: string; cid: string }>
  >()
const updateRecordFn =
  vi.fn<
    (
      did: string,
      collection: string,
      rkey: string,
      record: Record<string, unknown>
    ) => Promise<{ uri: string; cid: string }>
  >()
const deleteRecordFn = vi.fn<(did: string, collection: string, rkey: string) => Promise<void>>()

vi.mock('../../../src/lib/pds-client.js', () => ({
  createPdsClient: () => ({
    createRecord: createRecordFn,
    updateRecord: updateRecordFn,
    deleteRecord: deleteRecordFn,
  }),
}))

// Mock anti-spam module (tested separately in anti-spam.test.ts)
vi.mock('../../../src/lib/anti-spam.js', () => ({
  loadAntiSpamSettings: vi.fn().mockResolvedValue({
    wordFilter: [],
    firstPostQueueCount: 3,
    newAccountDays: 7,
    newAccountWriteRatePerMin: 3,
    establishedWriteRatePerMin: 10,
    linkHoldEnabled: true,
    topicCreationDelayEnabled: false,
    burstPostCount: 5,
    burstWindowMinutes: 10,
    trustedPostThreshold: 10,
  }),
  isNewAccount: vi.fn().mockResolvedValue(false),
  isAccountTrusted: vi.fn().mockResolvedValue(true),
  checkWriteRateLimit: vi.fn().mockResolvedValue(false),
  canCreateTopic: vi.fn().mockResolvedValue(true),
  runAntiSpamChecks: vi.fn().mockResolvedValue({ held: false, reasons: [] }),
}))

// Mock onboarding gate (tested separately in onboarding-gate.test.ts)
vi.mock('../../../src/lib/onboarding-gate.js', () => ({
  checkOnboardingComplete: vi.fn().mockResolvedValue({ complete: true, missingFields: [] }),
}))

// Import routes AFTER mocking
import { topicRoutes } from '../../../src/routes/topics.js'
import { replyRoutes } from '../../../src/routes/replies.js'

// ---------------------------------------------------------------------------
// Mock env
// ---------------------------------------------------------------------------

const mockEnv = {
  COMMUNITY_DID: 'did:plc:community123',
  RATE_LIMIT_WRITE: 10,
  RATE_LIMIT_READ_ANON: 100,
  RATE_LIMIT_READ_AUTH: 300,
} as Env

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const TEST_DID = 'did:plc:testuser123'
const TEST_HANDLE = 'jay.bsky.team'
const TEST_SID = 'a'.repeat(64)

const TEST_TOPIC_URI = `at://${TEST_DID}/forum.barazo.topic.post/topic001`
const TEST_TOPIC_CID = 'bafyreiatopic001'
const TEST_TOPIC_RKEY = 'topic001'

const TEST_REPLY_URI = `at://${TEST_DID}/forum.barazo.topic.reply/reply001`
const TEST_REPLY_CID = 'bafyreireply001'
const TEST_REPLY_RKEY = 'reply001'

const TEST_PARENT_REPLY_URI = `at://${TEST_DID}/forum.barazo.topic.reply/parentreply001`
const TEST_PARENT_REPLY_CID = 'bafyreiparentreply001'

const TEST_NOW = '2026-02-13T12:00:00.000Z'

// ---------------------------------------------------------------------------
// Mock user builder
// ---------------------------------------------------------------------------

function testUser(overrides?: Partial<RequestUser>): RequestUser {
  return {
    did: TEST_DID,
    handle: TEST_HANDLE,
    sid: TEST_SID,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Mock firehose repo manager
// ---------------------------------------------------------------------------

const isTrackedFn = vi.fn<(did: string) => Promise<boolean>>()
const trackRepoFn = vi.fn<(did: string) => Promise<void>>()

const mockRepoManager = {
  isTracked: isTrackedFn,
  trackRepo: trackRepoFn,
  untrackRepo: vi.fn(),
  restoreTrackedRepos: vi.fn(),
}

const mockFirehose = {
  getRepoManager: () => mockRepoManager,
  start: vi.fn(),
  stop: vi.fn(),
  getStatus: vi.fn().mockReturnValue({ connected: true, lastEventId: null }),
}

// ---------------------------------------------------------------------------
// Chainable mock DB (shared helper)
// ---------------------------------------------------------------------------

const mockDb = createMockDb()

let insertChain: DbChain
let selectChain: DbChain
let updateChain: DbChain
let deleteChain: DbChain

function resetAllDbMocks(): void {
  insertChain = createChainableProxy()
  selectChain = createChainableProxy([])
  updateChain = createChainableProxy([])
  deleteChain = createChainableProxy()
  mockDb.insert.mockReturnValue(insertChain)
  mockDb.select.mockReturnValue(selectChain)
  mockDb.update.mockReturnValue(updateChain)
  mockDb.delete.mockReturnValue(deleteChain)
  // eslint-disable-next-line @typescript-eslint/no-misused-promises -- Intentionally async mock for Drizzle transaction
  mockDb.transaction.mockImplementation(async (fn: (tx: typeof mockDb) => Promise<void>) => {
    await fn(mockDb)
  })
}

// ---------------------------------------------------------------------------
// Auth middleware mock
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

// ---------------------------------------------------------------------------
// Sample row builders
// ---------------------------------------------------------------------------

function sampleTopicRow(overrides?: Record<string, unknown>) {
  return {
    uri: TEST_TOPIC_URI,
    rkey: TEST_TOPIC_RKEY,
    authorDid: TEST_DID,
    title: 'Test Topic Title',
    content: 'Test topic content goes here',
    category: 'general',
    tags: ['test', 'example'],
    communityDid: 'did:plc:community123',
    cid: TEST_TOPIC_CID,
    labels: null,
    replyCount: 0,
    reactionCount: 0,
    lastActivityAt: new Date(TEST_NOW),
    publishedAt: new Date(TEST_NOW),
    indexedAt: new Date(TEST_NOW),
    embedding: null,
    ...overrides,
  }
}

function sampleReplyRow(overrides?: Record<string, unknown>) {
  return {
    uri: TEST_REPLY_URI,
    rkey: TEST_REPLY_RKEY,
    authorDid: TEST_DID,
    content: 'This is a test reply',
    rootUri: TEST_TOPIC_URI,
    rootCid: TEST_TOPIC_CID,
    parentUri: TEST_TOPIC_URI,
    parentCid: TEST_TOPIC_CID,
    communityDid: 'did:plc:community123',
    cid: TEST_REPLY_CID,
    labels: null,
    reactionCount: 0,
    createdAt: new Date(TEST_NOW),
    indexedAt: new Date(TEST_NOW),
    embedding: null,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Helper: build app with BOTH topic and reply routes
// ---------------------------------------------------------------------------

async function buildTestApp(user?: RequestUser): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })

  app.decorate('db', mockDb as never)
  app.decorate('env', mockEnv)
  app.decorate('authMiddleware', createMockAuthMiddleware(user))
  app.decorate('firehose', mockFirehose as never)
  app.decorate('oauthClient', {} as never)
  app.decorate('sessionService', {} as SessionService)
  app.decorate('setupService', {} as SetupService)
  app.decorate('cache', {} as never)
  app.decorate('interactionGraphService', {
    recordReply: vi.fn().mockResolvedValue(undefined),
    recordReaction: vi.fn().mockResolvedValue(undefined),
    recordCoParticipation: vi.fn().mockResolvedValue(undefined),
  } as never)
  app.decorateRequest('user', undefined as RequestUser | undefined)
  app.decorateRequest('communityDid', undefined as string | undefined)
  app.addHook('onRequest', (request, _reply, done) => {
    request.communityDid = 'did:plc:test'
    done()
  })

  // Register BOTH route sets so we can test cross-endpoint behavior
  await app.register(topicRoutes())
  await app.register(replyRoutes())
  await app.ready()

  return app
}

// ===========================================================================
// Test suite: cross-endpoint topic + reply interactions
// ===========================================================================

describe('topics + replies cross-endpoint integration', () => {
  // =========================================================================
  // Create topic, then create reply -- verify replyCount increment
  // =========================================================================

  describe('create topic then create reply', () => {
    let app: FastifyInstance

    beforeAll(async () => {
      app = await buildTestApp(testUser())
    })

    afterAll(async () => {
      await app.close()
    })

    beforeEach(() => {
      vi.clearAllMocks()
      resetAllDbMocks()
      isTrackedFn.mockResolvedValue(true)
    })

    it('creating a reply calls update on topic (replyCount + lastActivityAt)', async () => {
      // Mock PDS: topic creation
      createRecordFn.mockResolvedValueOnce({ uri: TEST_TOPIC_URI, cid: TEST_TOPIC_CID })

      // Step 1: Create topic
      const topicResponse = await app.inject({
        method: 'POST',
        url: '/api/topics',
        headers: { authorization: 'Bearer test-token' },
        payload: {
          title: 'My Topic',
          content: 'Topic body content.',
          category: 'general',
        },
      })

      expect(topicResponse.statusCode).toBe(201)
      const topicBody = topicResponse.json<{ uri: string }>()
      expect(topicBody.uri).toBe(TEST_TOPIC_URI)

      // Reset mocks between topic and reply creation but keep chains fresh
      vi.clearAllMocks()
      resetAllDbMocks()
      isTrackedFn.mockResolvedValue(true)

      // Mock PDS: reply creation
      createRecordFn.mockResolvedValueOnce({ uri: TEST_REPLY_URI, cid: TEST_REPLY_CID })

      // Mock: topic lookup for reply creation
      selectChain.where.mockResolvedValueOnce([sampleTopicRow()])

      // Step 2: Create reply to the topic
      const encodedTopicUri = encodeURIComponent(TEST_TOPIC_URI)
      const replyResponse = await app.inject({
        method: 'POST',
        url: `/api/topics/${encodedTopicUri}/replies`,
        headers: { authorization: 'Bearer test-token' },
        payload: {
          content: 'This is my reply.',
        },
      })

      expect(replyResponse.statusCode).toBe(201)

      // Verify: reply was inserted into DB
      expect(mockDb.insert).toHaveBeenCalledOnce()

      // Verify: topic replyCount was updated (db.update was called)
      expect(mockDb.update).toHaveBeenCalled()

      // Verify: the update set includes replyCount increment
      expect(updateChain.set).toHaveBeenCalled()
      const setCall = updateChain.set.mock.calls[0]?.[0] as Record<string, unknown>
      expect(setCall).toBeDefined()
      // replyCount should be a SQL expression (not a plain number)
      expect(setCall.replyCount).toBeDefined()
      // lastActivityAt should be set
      expect(setCall.lastActivityAt).toBeDefined()
    })

    it('reply creation returns the reply URI and CID', async () => {
      createRecordFn.mockResolvedValueOnce({ uri: TEST_REPLY_URI, cid: TEST_REPLY_CID })
      selectChain.where.mockResolvedValueOnce([sampleTopicRow()])

      const encodedTopicUri = encodeURIComponent(TEST_TOPIC_URI)
      const response = await app.inject({
        method: 'POST',
        url: `/api/topics/${encodedTopicUri}/replies`,
        headers: { authorization: 'Bearer test-token' },
        payload: {
          content: 'Reply content here.',
        },
      })

      expect(response.statusCode).toBe(201)
      const body = response.json<{ uri: string; cid: string }>()
      expect(body.uri).toBe(TEST_REPLY_URI)
      expect(body.cid).toBe(TEST_REPLY_CID)
    })
  })

  // =========================================================================
  // Create topic, create reply, delete reply -- verify replyCount decrement
  // =========================================================================

  describe('create reply then delete reply', () => {
    let app: FastifyInstance

    beforeAll(async () => {
      app = await buildTestApp(testUser())
    })

    afterAll(async () => {
      await app.close()
    })

    beforeEach(() => {
      vi.clearAllMocks()
      resetAllDbMocks()
      isTrackedFn.mockResolvedValue(true)
      deleteRecordFn.mockResolvedValue(undefined)
    })

    it('soft-deleting a reply decrements replyCount using GREATEST', async () => {
      // Mock: reply lookup for delete
      const existingReply = sampleReplyRow()
      selectChain.where.mockResolvedValueOnce([existingReply])

      const encodedReplyUri = encodeURIComponent(TEST_REPLY_URI)
      const response = await app.inject({
        method: 'DELETE',
        url: `/api/replies/${encodedReplyUri}`,
        headers: { authorization: 'Bearer test-token' },
      })

      expect(response.statusCode).toBe(204)

      // Verify: reply was soft-deleted (update, not delete)
      expect(mockDb.update).toHaveBeenCalled()
      expect(mockDb.delete).not.toHaveBeenCalled()

      // Verify: topic replyCount was decremented
      expect(updateChain.set).toHaveBeenCalled()

      // One set call is the soft-delete (isAuthorDeleted), another is the replyCount decrement
      const setCalls = updateChain.set.mock.calls as Array<[Record<string, unknown>]>
      const replyCountCall = setCalls.find((c) => c[0].replyCount !== undefined)
      expect(replyCountCall).toBeDefined()
    })

    it('delete reply also deletes from PDS when user is author', async () => {
      const existingReply = sampleReplyRow()
      selectChain.where.mockResolvedValueOnce([existingReply])

      const encodedReplyUri = encodeURIComponent(TEST_REPLY_URI)
      const response = await app.inject({
        method: 'DELETE',
        url: `/api/replies/${encodedReplyUri}`,
        headers: { authorization: 'Bearer test-token' },
      })

      expect(response.statusCode).toBe(204)

      // Author delete: should delete from PDS
      expect(deleteRecordFn).toHaveBeenCalledOnce()
      expect(deleteRecordFn.mock.calls[0]?.[0]).toBe(TEST_DID)
      expect(deleteRecordFn.mock.calls[0]?.[1]).toBe('forum.barazo.topic.reply')
      expect(deleteRecordFn.mock.calls[0]?.[2]).toBe(TEST_REPLY_RKEY)
    })
  })

  // =========================================================================
  // Delete topic cascades replies
  // =========================================================================

  describe('delete topic preserves replies (soft-delete)', () => {
    let app: FastifyInstance

    beforeAll(async () => {
      app = await buildTestApp(testUser())
    })

    afterAll(async () => {
      await app.close()
    })

    beforeEach(() => {
      vi.clearAllMocks()
      resetAllDbMocks()
      deleteRecordFn.mockResolvedValue(undefined)
    })

    it('soft-deletes a topic without cascade-deleting replies', async () => {
      const existingTopic = sampleTopicRow()
      selectChain.where.mockResolvedValueOnce([existingTopic])

      const encodedUri = encodeURIComponent(TEST_TOPIC_URI)
      const response = await app.inject({
        method: 'DELETE',
        url: `/api/topics/${encodedUri}`,
        headers: { authorization: 'Bearer test-token' },
      })

      expect(response.statusCode).toBe(204)

      // Should have deleted from PDS (author delete)
      expect(deleteRecordFn).toHaveBeenCalledOnce()

      // Soft-delete: update isAuthorDeleted, no cascade delete of replies
      expect(mockDb.update).toHaveBeenCalled()
      // No transaction needed (no cascade)
      expect(mockDb.transaction).not.toHaveBeenCalled()
    })

    it('soft-delete sets isAuthorDeleted on topic only', async () => {
      const existingTopic = sampleTopicRow()
      selectChain.where.mockResolvedValueOnce([existingTopic])

      const encodedUri = encodeURIComponent(TEST_TOPIC_URI)
      const response = await app.inject({
        method: 'DELETE',
        url: `/api/topics/${encodedUri}`,
        headers: { authorization: 'Bearer test-token' },
      })

      expect(response.statusCode).toBe(204)

      // Verify the update was called with isAuthorDeleted
      expect(updateChain.set).toHaveBeenCalled()
      const setCall = updateChain.set.mock.calls[0]?.[0] as Record<string, unknown>
      expect(setCall.isAuthorDeleted).toBe(true)
    })
  })

  // =========================================================================
  // Reply to non-existent topic returns 404
  // =========================================================================

  describe('reply to non-existent topic', () => {
    let app: FastifyInstance

    beforeAll(async () => {
      app = await buildTestApp(testUser())
    })

    afterAll(async () => {
      await app.close()
    })

    beforeEach(() => {
      vi.clearAllMocks()
      resetAllDbMocks()
      isTrackedFn.mockResolvedValue(true)
    })

    it('returns 404 when topic does not exist', async () => {
      // Topic lookup returns empty
      selectChain.where.mockResolvedValueOnce([])

      const nonExistentUri = encodeURIComponent(
        'at://did:plc:nobody/forum.barazo.topic.post/nonexistent'
      )
      const response = await app.inject({
        method: 'POST',
        url: `/api/topics/${nonExistentUri}/replies`,
        headers: { authorization: 'Bearer test-token' },
        payload: {
          content: 'Reply to a ghost topic.',
        },
      })

      expect(response.statusCode).toBe(404)

      // Should NOT have written to PDS
      expect(createRecordFn).not.toHaveBeenCalled()

      // Should NOT have inserted into DB
      expect(mockDb.insert).not.toHaveBeenCalled()
    })

    it('returns 404 error body with descriptive message', async () => {
      selectChain.where.mockResolvedValueOnce([])

      const nonExistentUri = encodeURIComponent(
        'at://did:plc:nobody/forum.barazo.topic.post/nonexistent'
      )
      const response = await app.inject({
        method: 'POST',
        url: `/api/topics/${nonExistentUri}/replies`,
        headers: { authorization: 'Bearer test-token' },
        payload: {
          content: 'Reply to missing topic.',
        },
      })

      expect(response.statusCode).toBe(404)
      const body = response.json<{ error: string }>()
      expect(body.error).toBeDefined()
    })
  })

  // =========================================================================
  // Threaded reply with invalid parentUri returns 400
  // =========================================================================

  describe('threaded reply with invalid parentUri', () => {
    let app: FastifyInstance

    beforeAll(async () => {
      app = await buildTestApp(testUser())
    })

    afterAll(async () => {
      await app.close()
    })

    beforeEach(() => {
      vi.clearAllMocks()
      resetAllDbMocks()
      isTrackedFn.mockResolvedValue(true)
    })

    it('returns 400 when parentUri reply does not exist', async () => {
      // Topic lookup succeeds
      selectChain.where.mockResolvedValueOnce([sampleTopicRow()])
      // Parent reply lookup fails
      selectChain.where.mockResolvedValueOnce([])

      const encodedTopicUri = encodeURIComponent(TEST_TOPIC_URI)
      const response = await app.inject({
        method: 'POST',
        url: `/api/topics/${encodedTopicUri}/replies`,
        headers: { authorization: 'Bearer test-token' },
        payload: {
          content: 'Threaded reply to non-existent parent.',
          parentUri: 'at://did:plc:nobody/forum.barazo.topic.reply/ghost',
        },
      })

      expect(response.statusCode).toBe(400)

      // Should NOT have written to PDS
      expect(createRecordFn).not.toHaveBeenCalled()
    })

    it('returns 400 error body with descriptive message', async () => {
      selectChain.where.mockResolvedValueOnce([sampleTopicRow()])
      selectChain.where.mockResolvedValueOnce([])

      const encodedTopicUri = encodeURIComponent(TEST_TOPIC_URI)
      const response = await app.inject({
        method: 'POST',
        url: `/api/topics/${encodedTopicUri}/replies`,
        headers: { authorization: 'Bearer test-token' },
        payload: {
          content: 'Invalid parent reply reference.',
          parentUri: 'at://did:plc:ghost/forum.barazo.topic.reply/missing',
        },
      })

      expect(response.statusCode).toBe(400)
      const body = response.json<{ error: string }>()
      expect(body.error).toBeDefined()
    })

    it('succeeds when parentUri points to a valid reply', async () => {
      createRecordFn.mockResolvedValueOnce({ uri: TEST_REPLY_URI, cid: TEST_REPLY_CID })

      // Topic lookup succeeds
      selectChain.where.mockResolvedValueOnce([sampleTopicRow()])
      // Parent reply lookup succeeds
      selectChain.where.mockResolvedValueOnce([
        sampleReplyRow({
          uri: TEST_PARENT_REPLY_URI,
          cid: TEST_PARENT_REPLY_CID,
        }),
      ])

      const encodedTopicUri = encodeURIComponent(TEST_TOPIC_URI)
      const response = await app.inject({
        method: 'POST',
        url: `/api/topics/${encodedTopicUri}/replies`,
        headers: { authorization: 'Bearer test-token' },
        payload: {
          content: 'Valid threaded reply.',
          parentUri: TEST_PARENT_REPLY_URI,
        },
      })

      expect(response.statusCode).toBe(201)

      // Verify the PDS record has correct parent reference
      const record = createRecordFn.mock.calls[0]?.[2] as Record<string, unknown>
      const parentRef = record.parent as { uri: string; cid: string }
      expect(parentRef.uri).toBe(TEST_PARENT_REPLY_URI)
      expect(parentRef.cid).toBe(TEST_PARENT_REPLY_CID)

      // Root should still point to the topic
      const rootRef = record.root as { uri: string; cid: string }
      expect(rootRef.uri).toBe(TEST_TOPIC_URI)
      expect(rootRef.cid).toBe(TEST_TOPIC_CID)
    })
  })

  // =========================================================================
  // Full lifecycle: create topic -> reply -> get replies -> delete
  // =========================================================================

  describe('full topic-reply lifecycle', () => {
    let app: FastifyInstance

    beforeAll(async () => {
      app = await buildTestApp(testUser())
    })

    afterAll(async () => {
      await app.close()
    })

    beforeEach(() => {
      vi.clearAllMocks()
      resetAllDbMocks()
      isTrackedFn.mockResolvedValue(true)
    })

    it('can create a topic, add a reply, list replies, and delete topic', async () => {
      // Step 1: Create topic
      createRecordFn.mockResolvedValueOnce({ uri: TEST_TOPIC_URI, cid: TEST_TOPIC_CID })

      const topicResponse = await app.inject({
        method: 'POST',
        url: '/api/topics',
        headers: { authorization: 'Bearer test-token' },
        payload: {
          title: 'Lifecycle Topic',
          content: 'Testing the full lifecycle.',
          category: 'general',
        },
      })

      expect(topicResponse.statusCode).toBe(201)

      // Reset mocks for next step
      vi.clearAllMocks()
      resetAllDbMocks()
      isTrackedFn.mockResolvedValue(true)

      // Step 2: Create reply
      createRecordFn.mockResolvedValueOnce({ uri: TEST_REPLY_URI, cid: TEST_REPLY_CID })
      selectChain.where.mockResolvedValueOnce([sampleTopicRow()])

      const encodedTopicUri = encodeURIComponent(TEST_TOPIC_URI)
      const replyResponse = await app.inject({
        method: 'POST',
        url: `/api/topics/${encodedTopicUri}/replies`,
        headers: { authorization: 'Bearer test-token' },
        payload: {
          content: 'Lifecycle reply.',
        },
      })

      expect(replyResponse.statusCode).toBe(201)

      // Reset for next step
      vi.clearAllMocks()
      resetAllDbMocks()

      // Step 3: List replies
      selectChain.where.mockResolvedValueOnce([sampleTopicRow()])
      selectChain.limit.mockResolvedValueOnce([sampleReplyRow()])

      const listResponse = await app.inject({
        method: 'GET',
        url: `/api/topics/${encodedTopicUri}/replies`,
      })

      expect(listResponse.statusCode).toBe(200)
      const listBody = listResponse.json<{ replies: unknown[] }>()
      expect(listBody.replies).toHaveLength(1)

      // Reset for next step
      vi.clearAllMocks()
      resetAllDbMocks()
      deleteRecordFn.mockResolvedValue(undefined)

      // Step 4: Delete topic (soft-delete, no cascade)
      selectChain.where.mockResolvedValueOnce([sampleTopicRow()])

      const deleteResponse = await app.inject({
        method: 'DELETE',
        url: `/api/topics/${encodedTopicUri}`,
        headers: { authorization: 'Bearer test-token' },
      })

      expect(deleteResponse.statusCode).toBe(204)

      // Soft-delete: update isAuthorDeleted, replies preserved
      expect(mockDb.update).toHaveBeenCalled()
    })
  })
})
