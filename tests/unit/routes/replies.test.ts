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
  runAntiSpamChecks: vi.fn().mockResolvedValue({ held: false, reasons: [] }),
}))

// Import anti-spam mocks for per-test override
import {
  isAccountTrusted as isAccountTrustedMock,
  checkWriteRateLimit as checkWriteRateLimitMock,
  runAntiSpamChecks as runAntiSpamChecksMock,
  isNewAccount as isNewAccountMock,
} from '../../../src/lib/anti-spam.js'

// Mock onboarding gate (tested separately in onboarding-gate.test.ts)
const checkOnboardingCompleteFn = vi.fn().mockResolvedValue({ complete: true, missingFields: [] })
vi.mock('../../../src/lib/onboarding-gate.js', () => ({
  checkOnboardingComplete: (...args: unknown[]) => checkOnboardingCompleteFn(...args) as unknown,
}))

// Mock handle-to-DID resolver
const resolveHandleToDidFn = vi.fn<(handle: string) => Promise<string | null>>()
vi.mock('../../../src/lib/resolve-handle-to-did.js', () => ({
  resolveHandleToDid: (...args: unknown[]) => resolveHandleToDidFn(args[0] as string),
}))

// Import routes AFTER mocking
import { replyRoutes } from '../../../src/routes/replies.js'

// ---------------------------------------------------------------------------
// Mock env (minimal subset for reply routes)
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

const TEST_TOPIC_URI = `at://${TEST_DID}/forum.barazo.topic.post/abc123`
const TEST_TOPIC_CID = 'bafyreiatopic123'
const TEST_TOPIC_RKEY = 'abc123'

const TEST_REPLY_URI = `at://${TEST_DID}/forum.barazo.topic.reply/reply001`
const TEST_REPLY_CID = 'bafyreireply001'
const TEST_REPLY_RKEY = 'reply001'

const TEST_PARENT_REPLY_URI = `at://${TEST_DID}/forum.barazo.topic.reply/parentreply001`
const TEST_PARENT_REPLY_CID = 'bafyreiparentreply001'

const TEST_NOW = '2026-02-13T12:00:00.000Z'

const MOD_DID = 'did:plc:moderator999'
const OTHER_DID = 'did:plc:otheruser456'

// ---------------------------------------------------------------------------
// Mock user builders
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
// Auth middleware mocks
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

/**
 * Special auth middleware that passes through without setting user.
 * This tests the defensive `if (!user)` guards inside route handlers.
 */
function createPassthroughAuthMiddleware(): AuthMiddleware {
  return {
    requireAuth: async (_request, _reply) => {
      // Intentionally does not set request.user or send 401
    },
    optionalAuth: (_request, _reply) => {
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
    depth: 1,
    createdAt: new Date(TEST_NOW),
    indexedAt: new Date(TEST_NOW),
    isAuthorDeleted: false,
    isModDeleted: false,
    embedding: null,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Helper: build app with mocked deps
// ---------------------------------------------------------------------------

interface BuildTestAppOptions {
  user?: RequestUser
  ozoneService?: {
    isSpamLabeled: ReturnType<typeof vi.fn>
    batchIsSpamLabeled: ReturnType<typeof vi.fn>
  }
  passthroughAuth?: boolean
}

async function buildTestApp(
  userOrOpts?: RequestUser | BuildTestAppOptions
): Promise<FastifyInstance> {
  // Support both old signature (user) and new signature (options object)
  let user: RequestUser | undefined
  let ozoneService: BuildTestAppOptions['ozoneService']
  let passthroughAuth = false
  if (userOrOpts && 'did' in userOrOpts) {
    user = userOrOpts
  } else if (userOrOpts && typeof userOrOpts === 'object' && !('did' in userOrOpts)) {
    user = userOrOpts.user
    ozoneService = userOrOpts.ozoneService
    passthroughAuth = userOrOpts.passthroughAuth ?? false
  }

  const app = Fastify({ logger: false })

  app.decorate('db', mockDb as never)
  app.decorate('env', mockEnv)
  app.decorate(
    'authMiddleware',
    passthroughAuth ? createPassthroughAuthMiddleware() : createMockAuthMiddleware(user)
  )
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
  if (ozoneService) {
    app.decorate('ozoneService', ozoneService as never)
  }
  app.decorateRequest('user', undefined as RequestUser | undefined)
  app.decorateRequest('communityDid', undefined as string | undefined)
  app.addHook('onRequest', (request, _reply, done) => {
    request.communityDid = 'did:plc:test'
    done()
  })

  await app.register(replyRoutes())
  await app.ready()

  return app
}

// ===========================================================================
// Test suite
// ===========================================================================

describe('reply routes', () => {
  // =========================================================================
  // POST /api/topics/:topicUri/replies
  // =========================================================================

  describe('POST /api/topics/:topicUri/replies', () => {
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

      // Default mocks for successful create
      createRecordFn.mockResolvedValue({ uri: TEST_REPLY_URI, cid: TEST_REPLY_CID })
      isTrackedFn.mockResolvedValue(true)
    })

    it('creates a reply to a topic and returns 201', async () => {
      // First select: look up topic
      selectChain.where.mockResolvedValueOnce([sampleTopicRow()])

      const encodedTopicUri = encodeURIComponent(TEST_TOPIC_URI)
      const response = await app.inject({
        method: 'POST',
        url: `/api/topics/${encodedTopicUri}/replies`,
        headers: { authorization: 'Bearer test-token' },
        payload: {
          content: 'This is my reply to the topic.',
        },
      })

      expect(response.statusCode).toBe(201)
      const body = response.json<{ uri: string; cid: string }>()
      expect(body.uri).toBe(TEST_REPLY_URI)
      expect(body.cid).toBe(TEST_REPLY_CID)

      // Should have called PDS createRecord
      expect(createRecordFn).toHaveBeenCalledOnce()
      expect(createRecordFn.mock.calls[0]?.[0]).toBe(TEST_DID)
      expect(createRecordFn.mock.calls[0]?.[1]).toBe('forum.barazo.topic.reply')

      // Verify record content
      const record = createRecordFn.mock.calls[0]?.[2] as Record<string, unknown>
      expect(record.content).toEqual({
        $type: 'forum.barazo.richtext#markdown',
        value: 'This is my reply to the topic.',
      })
      expect(record.community).toBe('did:plc:community123')
      expect((record.root as Record<string, unknown>).uri).toBe(TEST_TOPIC_URI)
      expect((record.root as Record<string, unknown>).cid).toBe(TEST_TOPIC_CID)
      // parent should also point to topic when no parentUri provided
      expect((record.parent as Record<string, unknown>).uri).toBe(TEST_TOPIC_URI)
      expect((record.parent as Record<string, unknown>).cid).toBe(TEST_TOPIC_CID)

      // Should have inserted into DB
      expect(mockDb.insert).toHaveBeenCalledOnce()

      // Should have updated topic replyCount + lastActivityAt
      expect(mockDb.update).toHaveBeenCalled()
    })

    it('creates a threaded reply (with parentUri) and returns 201', async () => {
      // First select: look up topic
      selectChain.where.mockResolvedValueOnce([sampleTopicRow()])
      // Second select: look up parent reply
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
          content: 'This is a threaded reply.',
          parentUri: TEST_PARENT_REPLY_URI,
        },
      })

      expect(response.statusCode).toBe(201)

      // Verify record has correct parent reference
      const record = createRecordFn.mock.calls[0]?.[2] as Record<string, unknown>
      expect((record.root as Record<string, unknown>).uri).toBe(TEST_TOPIC_URI)
      expect((record.parent as Record<string, unknown>).uri).toBe(TEST_PARENT_REPLY_URI)
      expect((record.parent as Record<string, unknown>).cid).toBe(TEST_PARENT_REPLY_CID)
    })

    it('returns 400 when parentUri reply not found', async () => {
      // First select: look up topic
      selectChain.where.mockResolvedValueOnce([sampleTopicRow()])
      // Second select: parent reply not found
      selectChain.where.mockResolvedValueOnce([])

      const encodedTopicUri = encodeURIComponent(TEST_TOPIC_URI)
      const response = await app.inject({
        method: 'POST',
        url: `/api/topics/${encodedTopicUri}/replies`,
        headers: { authorization: 'Bearer test-token' },
        payload: {
          content: 'Reply to missing parent.',
          parentUri: 'at://did:plc:nobody/forum.barazo.topic.reply/ghost',
        },
      })

      expect(response.statusCode).toBe(400)
    })

    it("tracks new user's repo on first post", async () => {
      isTrackedFn.mockResolvedValue(false)
      trackRepoFn.mockResolvedValue(undefined)
      selectChain.where.mockResolvedValueOnce([sampleTopicRow()])

      const encodedTopicUri = encodeURIComponent(TEST_TOPIC_URI)
      const response = await app.inject({
        method: 'POST',
        url: `/api/topics/${encodedTopicUri}/replies`,
        headers: { authorization: 'Bearer test-token' },
        payload: {
          content: 'First ever post reply.',
        },
      })

      expect(response.statusCode).toBe(201)
      expect(isTrackedFn).toHaveBeenCalledWith(TEST_DID)
      expect(trackRepoFn).toHaveBeenCalledWith(TEST_DID)
    })

    it('does not track already-tracked user', async () => {
      isTrackedFn.mockResolvedValue(true)
      selectChain.where.mockResolvedValueOnce([sampleTopicRow()])

      const encodedTopicUri = encodeURIComponent(TEST_TOPIC_URI)
      const response = await app.inject({
        method: 'POST',
        url: `/api/topics/${encodedTopicUri}/replies`,
        headers: { authorization: 'Bearer test-token' },
        payload: {
          content: 'Already tracked reply.',
        },
      })

      expect(response.statusCode).toBe(201)
      expect(isTrackedFn).toHaveBeenCalledWith(TEST_DID)
      expect(trackRepoFn).not.toHaveBeenCalled()
    })

    it('returns 404 when topic does not exist', async () => {
      selectChain.where.mockResolvedValueOnce([])

      const encodedTopicUri = encodeURIComponent(
        'at://did:plc:nobody/forum.barazo.topic.post/ghost'
      )
      const response = await app.inject({
        method: 'POST',
        url: `/api/topics/${encodedTopicUri}/replies`,
        headers: { authorization: 'Bearer test-token' },
        payload: {
          content: 'Reply to nonexistent topic.',
        },
      })

      expect(response.statusCode).toBe(404)
    })

    it('returns 400 for missing content', async () => {
      const encodedTopicUri = encodeURIComponent(TEST_TOPIC_URI)
      const response = await app.inject({
        method: 'POST',
        url: `/api/topics/${encodedTopicUri}/replies`,
        headers: { authorization: 'Bearer test-token' },
        payload: {},
      })

      expect(response.statusCode).toBe(400)
    })

    it('returns 400 for empty content', async () => {
      const encodedTopicUri = encodeURIComponent(TEST_TOPIC_URI)
      const response = await app.inject({
        method: 'POST',
        url: `/api/topics/${encodedTopicUri}/replies`,
        headers: { authorization: 'Bearer test-token' },
        payload: {
          content: '',
        },
      })

      expect(response.statusCode).toBe(400)
    })

    it('returns 400 for content exceeding max length', async () => {
      const encodedTopicUri = encodeURIComponent(TEST_TOPIC_URI)
      const response = await app.inject({
        method: 'POST',
        url: `/api/topics/${encodedTopicUri}/replies`,
        headers: { authorization: 'Bearer test-token' },
        payload: {
          content: 'A'.repeat(50001),
        },
      })

      expect(response.statusCode).toBe(400)
    })

    it('returns 502 when PDS write fails', async () => {
      selectChain.where.mockResolvedValueOnce([sampleTopicRow()])
      createRecordFn.mockRejectedValueOnce(new Error('PDS unreachable'))

      const encodedTopicUri = encodeURIComponent(TEST_TOPIC_URI)
      const response = await app.inject({
        method: 'POST',
        url: `/api/topics/${encodedTopicUri}/replies`,
        headers: { authorization: 'Bearer test-token' },
        payload: {
          content: 'Should fail because PDS is down.',
        },
      })

      expect(response.statusCode).toBe(502)
    })

    it('creates a reply with self-labels and includes them in PDS record and DB insert', async () => {
      const labels = { values: [{ val: 'nsfw' }, { val: 'spoiler' }] }
      selectChain.where.mockResolvedValueOnce([sampleTopicRow()])

      const encodedTopicUri = encodeURIComponent(TEST_TOPIC_URI)
      const response = await app.inject({
        method: 'POST',
        url: `/api/topics/${encodedTopicUri}/replies`,
        headers: { authorization: 'Bearer test-token' },
        payload: {
          content: 'This reply has self-labels.',
          labels,
        },
      })

      expect(response.statusCode).toBe(201)

      // Verify PDS record includes labels
      expect(createRecordFn).toHaveBeenCalledOnce()
      const pdsRecord = createRecordFn.mock.calls[0]?.[2] as Record<string, unknown>
      expect(pdsRecord.labels).toEqual(labels)

      // Verify DB insert includes labels
      expect(mockDb.insert).toHaveBeenCalledOnce()
      const insertValues = insertChain.values.mock.calls[0]?.[0] as Record<string, unknown>
      expect(insertValues.labels).toEqual(labels)
    })

    it('creates a reply without labels (backwards compatible)', async () => {
      selectChain.where.mockResolvedValueOnce([sampleTopicRow()])

      const encodedTopicUri = encodeURIComponent(TEST_TOPIC_URI)
      const response = await app.inject({
        method: 'POST',
        url: `/api/topics/${encodedTopicUri}/replies`,
        headers: { authorization: 'Bearer test-token' },
        payload: {
          content: 'This reply has no labels.',
        },
      })

      expect(response.statusCode).toBe(201)

      // Verify PDS record does NOT include labels key
      const pdsRecord = createRecordFn.mock.calls[0]?.[2] as Record<string, unknown>
      expect(pdsRecord).not.toHaveProperty('labels')

      // Verify DB insert has labels: null
      const insertValues = insertChain.values.mock.calls[0]?.[0] as Record<string, unknown>
      expect(insertValues.labels).toBeNull()
    })
  })

  describe('POST /api/topics/:topicUri/replies (unauthenticated)', () => {
    let app: FastifyInstance

    beforeAll(async () => {
      app = await buildTestApp(undefined)
    })

    afterAll(async () => {
      await app.close()
    })

    it('returns 401 without auth', async () => {
      const encodedTopicUri = encodeURIComponent(TEST_TOPIC_URI)
      const response = await app.inject({
        method: 'POST',
        url: `/api/topics/${encodedTopicUri}/replies`,
        payload: {
          content: 'Unauth reply.',
        },
      })

      expect(response.statusCode).toBe(401)
    })
  })

  // =========================================================================
  // GET /api/topics/:topicUri/replies
  // =========================================================================

  describe('GET /api/topics/:topicUri/replies', () => {
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
    })

    it('returns empty list when no replies exist', async () => {
      // First select: look up topic
      selectChain.where.mockResolvedValueOnce([sampleTopicRow()])
      // Second: replies query ends with .limit()
      selectChain.limit.mockResolvedValueOnce([])

      const encodedTopicUri = encodeURIComponent(TEST_TOPIC_URI)
      const response = await app.inject({
        method: 'GET',
        url: `/api/topics/${encodedTopicUri}/replies`,
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{ replies: unknown[]; cursor: string | null }>()
      expect(body.replies).toEqual([])
      expect(body.cursor).toBeNull()
    })

    it('returns replies with pagination cursor', async () => {
      // First: look up topic
      selectChain.where.mockResolvedValueOnce([sampleTopicRow()])

      // limit=2 means fetch 3 items
      const rows = [
        sampleReplyRow(),
        sampleReplyRow({
          uri: `at://${TEST_DID}/forum.barazo.topic.reply/reply002`,
          rkey: 'reply002',
        }),
        sampleReplyRow({
          uri: `at://${TEST_DID}/forum.barazo.topic.reply/reply003`,
          rkey: 'reply003',
        }),
      ]
      selectChain.limit.mockResolvedValueOnce(rows)

      const encodedTopicUri = encodeURIComponent(TEST_TOPIC_URI)
      const response = await app.inject({
        method: 'GET',
        url: `/api/topics/${encodedTopicUri}/replies?limit=2`,
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{ replies: unknown[]; cursor: string | null }>()
      expect(body.replies).toHaveLength(2)
      expect(body.cursor).toBeTruthy()
    })

    it('returns null cursor when fewer items than limit', async () => {
      selectChain.where.mockResolvedValueOnce([sampleTopicRow()])
      selectChain.limit.mockResolvedValueOnce([sampleReplyRow()])

      const encodedTopicUri = encodeURIComponent(TEST_TOPIC_URI)
      const response = await app.inject({
        method: 'GET',
        url: `/api/topics/${encodedTopicUri}/replies?limit=25`,
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{ replies: unknown[]; cursor: string | null }>()
      expect(body.replies).toHaveLength(1)
      expect(body.cursor).toBeNull()
    })

    it('includes depth field in reply responses', async () => {
      selectChain.where.mockResolvedValueOnce([sampleTopicRow()])

      // A direct reply to topic has depth 1 (stored in DB)
      const directReply = sampleReplyRow({
        parentUri: TEST_TOPIC_URI,
        parentCid: TEST_TOPIC_CID,
        depth: 1,
      })
      // A nested reply has depth 2 (stored in DB)
      const nestedReply = sampleReplyRow({
        uri: `at://${TEST_DID}/forum.barazo.topic.reply/nested001`,
        rkey: 'nested001',
        parentUri: TEST_REPLY_URI,
        parentCid: TEST_REPLY_CID,
        depth: 2,
      })
      selectChain.limit.mockResolvedValueOnce([directReply, nestedReply])

      const encodedTopicUri = encodeURIComponent(TEST_TOPIC_URI)
      const response = await app.inject({
        method: 'GET',
        url: `/api/topics/${encodedTopicUri}/replies`,
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{ replies: Array<{ depth: number; parentUri: string }> }>()
      expect(body.replies).toHaveLength(2)
      expect(body.replies[0]?.depth).toBe(1)
      expect(body.replies[1]?.depth).toBe(2)
    })

    it('returns placeholder content for mod-deleted replies', async () => {
      selectChain.where.mockResolvedValueOnce([sampleTopicRow()])

      const modDeletedReply = sampleReplyRow({
        isModDeleted: true,
        content: 'Original content that was removed by moderator',
      })
      const normalReply = sampleReplyRow({
        uri: `at://${TEST_DID}/forum.barazo.topic.reply/normal001`,
        rkey: 'normal001',
        content: 'Normal reply content',
      })
      selectChain.limit.mockResolvedValueOnce([modDeletedReply, normalReply])

      const encodedTopicUri = encodeURIComponent(TEST_TOPIC_URI)
      const response = await app.inject({
        method: 'GET',
        url: `/api/topics/${encodedTopicUri}/replies`,
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{
        replies: Array<{ uri: string; content: string }>
      }>()
      expect(body.replies).toHaveLength(2)

      // Mod-deleted reply should show placeholder content
      const deletedReply = body.replies.find((r) => r.uri === modDeletedReply.uri)
      expect(deletedReply?.content).toBe('[Removed by moderator]')

      // Normal reply should show original content
      const normal = body.replies.find((r) => r.uri === normalReply.uri)
      expect(normal?.content).toBe('Normal reply content')
    })

    it('returns 404 when topic does not exist', async () => {
      selectChain.where.mockResolvedValueOnce([])

      const encodedTopicUri = encodeURIComponent(
        'at://did:plc:nobody/forum.barazo.topic.post/ghost'
      )
      const response = await app.inject({
        method: 'GET',
        url: `/api/topics/${encodedTopicUri}/replies`,
      })

      expect(response.statusCode).toBe(404)
    })

    it('returns 400 for invalid limit (over max)', async () => {
      const encodedTopicUri = encodeURIComponent(TEST_TOPIC_URI)
      const response = await app.inject({
        method: 'GET',
        url: `/api/topics/${encodedTopicUri}/replies?limit=999`,
      })

      expect(response.statusCode).toBe(400)
    })

    it('returns 400 for invalid limit (zero)', async () => {
      const encodedTopicUri = encodeURIComponent(TEST_TOPIC_URI)
      const response = await app.inject({
        method: 'GET',
        url: `/api/topics/${encodedTopicUri}/replies?limit=0`,
      })

      expect(response.statusCode).toBe(400)
    })

    it('returns 400 for non-numeric limit', async () => {
      const encodedTopicUri = encodeURIComponent(TEST_TOPIC_URI)
      const response = await app.inject({
        method: 'GET',
        url: `/api/topics/${encodedTopicUri}/replies?limit=abc`,
      })

      expect(response.statusCode).toBe(400)
    })

    it('accepts cursor parameter', async () => {
      selectChain.where.mockResolvedValueOnce([sampleTopicRow()])
      const cursor = Buffer.from(
        JSON.stringify({ createdAt: TEST_NOW, uri: TEST_REPLY_URI })
      ).toString('base64')
      selectChain.limit.mockResolvedValueOnce([])

      const encodedTopicUri = encodeURIComponent(TEST_TOPIC_URI)
      const response = await app.inject({
        method: 'GET',
        url: `/api/topics/${encodedTopicUri}/replies?cursor=${encodeURIComponent(cursor)}`,
      })

      expect(response.statusCode).toBe(200)
    })

    it('works without authentication (public endpoint)', async () => {
      const noAuthApp = await buildTestApp(undefined)
      selectChain.where.mockResolvedValueOnce([sampleTopicRow()])
      selectChain.limit.mockResolvedValueOnce([])

      const encodedTopicUri = encodeURIComponent(TEST_TOPIC_URI)
      const response = await noAuthApp.inject({
        method: 'GET',
        url: `/api/topics/${encodedTopicUri}/replies`,
      })

      expect(response.statusCode).toBe(200)
      await noAuthApp.close()
    })

    it('includes labels in reply list response', async () => {
      selectChain.where.mockResolvedValueOnce([sampleTopicRow()])
      const labels = { values: [{ val: 'nsfw' }] }
      const rows = [
        sampleReplyRow({ labels }),
        sampleReplyRow({
          uri: `at://${TEST_DID}/forum.barazo.topic.reply/nolabel`,
          rkey: 'nolabel',
          labels: null,
        }),
      ]
      selectChain.limit.mockResolvedValueOnce(rows)

      const encodedTopicUri = encodeURIComponent(TEST_TOPIC_URI)
      const response = await app.inject({
        method: 'GET',
        url: `/api/topics/${encodedTopicUri}/replies`,
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{
        replies: Array<{ uri: string; labels: { values: Array<{ val: string }> } | null }>
      }>()
      expect(body.replies).toHaveLength(2)
      expect(body.replies[0]?.labels).toEqual(labels)
      expect(body.replies[1]?.labels).toBeNull()
    })

    it('excludes replies by blocked users from list', async () => {
      const blockedDid = 'did:plc:blockeduser'

      // Query order for authenticated GET /api/topics/:topicUri/replies:
      // 1. Topic lookup (where)
      // 2. Category maturity (where)
      // 3. User profile (where) -- if authenticated
      // 4. Block/mute preferences (where)
      // 5. Replies query (limit)
      selectChain.where.mockResolvedValueOnce([sampleTopicRow()])
      // Category maturity
      selectChain.where.mockResolvedValueOnce([{ maturityRating: 'safe' }])
      // User profile
      selectChain.where.mockResolvedValueOnce([{ declaredAge: null, maturityPref: 'safe' }])
      // Community settings: ageThreshold
      selectChain.where.mockResolvedValueOnce([{ ageThreshold: 16 }])
      // Block/mute preferences
      selectChain.where.mockResolvedValueOnce([
        {
          blockedDids: [blockedDid],
          mutedDids: [],
        },
      ])

      // Return only non-blocked replies
      const rows = [sampleReplyRow({ authorDid: TEST_DID })]
      selectChain.limit.mockResolvedValueOnce(rows)

      const encodedTopicUri = encodeURIComponent(TEST_TOPIC_URI)
      const response = await app.inject({
        method: 'GET',
        url: `/api/topics/${encodedTopicUri}/replies`,
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{ replies: Array<{ authorDid: string; isMuted: boolean }> }>()
      expect(body.replies.every((r) => r.authorDid !== blockedDid)).toBe(true)
    })

    it('annotates replies by muted users with isMuted: true', async () => {
      const mutedDid = 'did:plc:muteduser'

      selectChain.where.mockResolvedValueOnce([sampleTopicRow()])
      // Category maturity
      selectChain.where.mockResolvedValueOnce([{ maturityRating: 'safe' }])
      // User profile
      selectChain.where.mockResolvedValueOnce([{ declaredAge: null, maturityPref: 'safe' }])
      // Community settings: ageThreshold
      selectChain.where.mockResolvedValueOnce([{ ageThreshold: 16 }])
      // Block/mute preferences
      selectChain.where.mockResolvedValueOnce([
        {
          blockedDids: [],
          mutedDids: [mutedDid],
        },
      ])

      const rows = [
        sampleReplyRow({
          authorDid: mutedDid,
          uri: `at://${mutedDid}/forum.barazo.topic.reply/m1`,
          rkey: 'm1',
        }),
        sampleReplyRow({ authorDid: TEST_DID }),
      ]
      selectChain.limit.mockResolvedValueOnce(rows)

      const encodedTopicUri = encodeURIComponent(TEST_TOPIC_URI)
      const response = await app.inject({
        method: 'GET',
        url: `/api/topics/${encodedTopicUri}/replies`,
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{ replies: Array<{ authorDid: string; isMuted: boolean }> }>()
      expect(body.replies).toHaveLength(2)

      const mutedReply = body.replies.find((r) => r.authorDid === mutedDid)
      const normalReply = body.replies.find((r) => r.authorDid === TEST_DID)
      expect(mutedReply?.isMuted).toBe(true)
      expect(normalReply?.isMuted).toBe(false)
    })

    it('includes author profile on each reply', async () => {
      resetAllDbMocks()

      // Mock chain for authenticated GET /api/topics/:topicUri/replies:
      //   1. Topic lookup .where (terminal)
      //   2. Category maturity .where (terminal)
      //   3. User profile .where (terminal)
      //   4. Community settings .where (terminal)
      //   5. loadBlockMuteLists .where (terminal)
      //   6. Replies .where (chained → .orderBy().limit())
      //   7. resolveAuthors users .where (terminal)
      //   8. loadMutedWords global .where (terminal)

      selectChain.where.mockResolvedValueOnce([sampleTopicRow()]) // 1: topic lookup
      selectChain.where.mockResolvedValueOnce([{ maturityRating: 'safe' }]) // 2: category maturity
      selectChain.where.mockResolvedValueOnce([{ declaredAge: null, maturityPref: 'safe' }]) // 3: user profile
      selectChain.where.mockResolvedValueOnce([{ ageThreshold: 16 }]) // 4: community settings
      selectChain.where.mockResolvedValueOnce([
        {
          // 5: block/mute
          blockedDids: [],
          mutedDids: [],
        },
      ])

      selectChain.where.mockImplementationOnce(() => selectChain) // 6: replies .where

      const rows = [
        sampleReplyRow({ authorDid: TEST_DID }),
        sampleReplyRow({
          authorDid: OTHER_DID,
          uri: `at://${OTHER_DID}/forum.barazo.topic.reply/o1`,
          rkey: 'o1',
        }),
      ]
      selectChain.limit.mockResolvedValueOnce(rows)

      selectChain.where.mockImplementationOnce(() => selectChain) // 6.5: child count query

      selectChain.where.mockResolvedValueOnce([
        // 7: resolveAuthors users
        {
          did: TEST_DID,
          handle: TEST_HANDLE,
          displayName: 'Jay',
          avatarUrl: 'https://cdn.example.com/jay.jpg',
          bannerUrl: null,
          bio: null,
        },
        {
          did: OTHER_DID,
          handle: 'alex.bsky.team',
          displayName: 'Alex',
          avatarUrl: null,
          bannerUrl: null,
          bio: null,
        },
      ])
      selectChain.where.mockResolvedValueOnce([]) // 8: loadMutedWords global

      const encodedTopicUri = encodeURIComponent(TEST_TOPIC_URI)
      const response = await app.inject({
        method: 'GET',
        url: `/api/topics/${encodedTopicUri}/replies`,
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{
        replies: Array<{
          authorDid: string
          author: {
            did: string
            handle: string
            displayName: string | null
            avatarUrl: string | null
          }
        }>
      }>()
      expect(body.replies).toHaveLength(2)

      // Verify resolved author profile data (not just DID fallback)
      const jayReply = body.replies.find((r) => r.authorDid === TEST_DID)
      expect(jayReply?.author).toEqual({
        did: TEST_DID,
        handle: TEST_HANDLE,
        displayName: 'Jay',
        avatarUrl: 'https://cdn.example.com/jay.jpg',
      })

      const alexReply = body.replies.find((r) => r.authorDid === OTHER_DID)
      expect(alexReply?.author).toEqual({
        did: OTHER_DID,
        handle: 'alex.bsky.team',
        displayName: 'Alex',
        avatarUrl: null,
      })
    })

    it('returns isMuted: false for all replies when unauthenticated', async () => {
      const noAuthApp = await buildTestApp(undefined)
      // For unauthenticated users, no user profile query
      selectChain.where.mockResolvedValueOnce([sampleTopicRow()])
      // Category maturity
      selectChain.where.mockResolvedValueOnce([{ maturityRating: 'safe' }])
      // No user profile or block/mute query for unauthenticated
      // Replies query
      const rows = [
        sampleReplyRow({ authorDid: TEST_DID }),
        sampleReplyRow({
          authorDid: OTHER_DID,
          uri: `at://${OTHER_DID}/forum.barazo.topic.reply/o1`,
          rkey: 'o1',
        }),
      ]
      selectChain.limit.mockResolvedValueOnce(rows)

      const encodedTopicUri = encodeURIComponent(TEST_TOPIC_URI)
      const response = await noAuthApp.inject({
        method: 'GET',
        url: `/api/topics/${encodedTopicUri}/replies`,
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{ replies: Array<{ authorDid: string; isMuted: boolean }> }>()
      expect(body.replies).toHaveLength(2)
      expect(body.replies.every((r) => !r.isMuted)).toBe(true)

      await noAuthApp.close()
    })
  })

  // =========================================================================
  // PUT /api/replies/:uri
  // =========================================================================

  describe('PUT /api/replies/:uri', () => {
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
      updateRecordFn.mockResolvedValue({ uri: TEST_REPLY_URI, cid: 'bafyreinewcid' })
    })

    it('updates a reply when user is the author', async () => {
      const existingRow = sampleReplyRow()
      selectChain.where.mockResolvedValueOnce([existingRow])
      const updatedRow = { ...existingRow, content: 'Updated reply content', cid: 'bafyreinewcid' }
      updateChain.returning.mockResolvedValueOnce([updatedRow])

      const encodedUri = encodeURIComponent(TEST_REPLY_URI)
      const response = await app.inject({
        method: 'PUT',
        url: `/api/replies/${encodedUri}`,
        headers: { authorization: 'Bearer test-token' },
        payload: {
          content: 'Updated reply content',
        },
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{ content: string }>()
      expect(body.content).toBe('Updated reply content')
      expect(updateRecordFn).toHaveBeenCalledOnce()
    })

    it('returns 403 when user is not the author', async () => {
      const existingRow = sampleReplyRow({ authorDid: OTHER_DID })
      selectChain.where.mockResolvedValueOnce([existingRow])

      const encodedUri = encodeURIComponent(TEST_REPLY_URI)
      const response = await app.inject({
        method: 'PUT',
        url: `/api/replies/${encodedUri}`,
        headers: { authorization: 'Bearer test-token' },
        payload: {
          content: 'Attempted edit by non-author.',
        },
      })

      expect(response.statusCode).toBe(403)
    })

    it('returns 404 when reply does not exist', async () => {
      selectChain.where.mockResolvedValueOnce([])

      const encodedUri = encodeURIComponent('at://did:plc:nobody/forum.barazo.topic.reply/ghost')
      const response = await app.inject({
        method: 'PUT',
        url: `/api/replies/${encodedUri}`,
        headers: { authorization: 'Bearer test-token' },
        payload: {
          content: 'Ghost reply edit.',
        },
      })

      expect(response.statusCode).toBe(404)
    })

    it('returns 400 for missing content', async () => {
      const encodedUri = encodeURIComponent(TEST_REPLY_URI)
      const response = await app.inject({
        method: 'PUT',
        url: `/api/replies/${encodedUri}`,
        headers: { authorization: 'Bearer test-token' },
        payload: {},
      })

      expect(response.statusCode).toBe(400)
    })

    it('returns 400 for empty content', async () => {
      const encodedUri = encodeURIComponent(TEST_REPLY_URI)
      const response = await app.inject({
        method: 'PUT',
        url: `/api/replies/${encodedUri}`,
        headers: { authorization: 'Bearer test-token' },
        payload: {
          content: '',
        },
      })

      expect(response.statusCode).toBe(400)
    })

    it('returns 400 for content exceeding max length', async () => {
      const encodedUri = encodeURIComponent(TEST_REPLY_URI)
      const response = await app.inject({
        method: 'PUT',
        url: `/api/replies/${encodedUri}`,
        headers: { authorization: 'Bearer test-token' },
        payload: {
          content: 'A'.repeat(50001),
        },
      })

      expect(response.statusCode).toBe(400)
    })

    it('returns 502 when PDS update fails', async () => {
      const existingRow = sampleReplyRow()
      selectChain.where.mockResolvedValueOnce([existingRow])
      updateRecordFn.mockRejectedValueOnce(new Error('PDS error'))

      const encodedUri = encodeURIComponent(TEST_REPLY_URI)
      const response = await app.inject({
        method: 'PUT',
        url: `/api/replies/${encodedUri}`,
        headers: { authorization: 'Bearer test-token' },
        payload: {
          content: 'Will fail to update.',
        },
      })

      expect(response.statusCode).toBe(502)
    })

    it('updates a reply with self-labels (PDS record + DB)', async () => {
      const existingRow = sampleReplyRow()
      selectChain.where.mockResolvedValueOnce([existingRow])
      const labels = { values: [{ val: 'nsfw' }, { val: 'spoiler' }] }
      const updatedRow = {
        ...existingRow,
        content: 'Updated with labels',
        labels,
        cid: 'bafyreinewcid',
      }
      updateChain.returning.mockResolvedValueOnce([updatedRow])

      const encodedUri = encodeURIComponent(TEST_REPLY_URI)
      const response = await app.inject({
        method: 'PUT',
        url: `/api/replies/${encodedUri}`,
        headers: { authorization: 'Bearer test-token' },
        payload: { content: 'Updated with labels', labels },
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{ labels: { values: Array<{ val: string }> } }>()
      expect(body.labels).toEqual(labels)

      // Verify PDS record includes labels
      expect(updateRecordFn).toHaveBeenCalledOnce()
      const pdsRecord = updateRecordFn.mock.calls[0]?.[3] as Record<string, unknown>
      expect(pdsRecord.labels).toEqual(labels)

      // Verify DB update includes labels
      const dbUpdateSet = updateChain.set.mock.calls[0]?.[0] as Record<string, unknown>
      expect(dbUpdateSet.labels).toEqual(labels)
    })

    it('does not change existing labels when labels field is omitted from update', async () => {
      const existingLabels = { values: [{ val: 'nsfw' }] }
      const existingRow = sampleReplyRow({ labels: existingLabels })
      selectChain.where.mockResolvedValueOnce([existingRow])
      const updatedRow = { ...existingRow, content: 'New content', cid: 'bafyreinewcid' }
      updateChain.returning.mockResolvedValueOnce([updatedRow])

      const encodedUri = encodeURIComponent(TEST_REPLY_URI)
      const response = await app.inject({
        method: 'PUT',
        url: `/api/replies/${encodedUri}`,
        headers: { authorization: 'Bearer test-token' },
        payload: { content: 'New content' },
      })

      expect(response.statusCode).toBe(200)

      // PDS record should preserve existing labels
      const pdsRecord = updateRecordFn.mock.calls[0]?.[3] as Record<string, unknown>
      expect(pdsRecord.labels).toEqual(existingLabels)

      // DB update should NOT include labels key (partial update)
      const dbUpdateSet = updateChain.set.mock.calls[0]?.[0] as Record<string, unknown>
      expect(dbUpdateSet).not.toHaveProperty('labels')
    })
  })

  describe('PUT /api/replies/:uri (unauthenticated)', () => {
    let app: FastifyInstance

    beforeAll(async () => {
      app = await buildTestApp(undefined)
    })

    afterAll(async () => {
      await app.close()
    })

    it('returns 401 without auth', async () => {
      const encodedUri = encodeURIComponent(TEST_REPLY_URI)
      const response = await app.inject({
        method: 'PUT',
        url: `/api/replies/${encodedUri}`,
        payload: { content: 'Unauth edit.' },
      })

      expect(response.statusCode).toBe(401)
    })
  })

  // =========================================================================
  // DELETE /api/replies/:uri
  // =========================================================================

  describe('DELETE /api/replies/:uri', () => {
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

    it('soft-deletes a reply when user is the author (deletes from PDS, soft-deletes in DB)', async () => {
      const existingRow = sampleReplyRow()
      selectChain.where.mockResolvedValueOnce([existingRow])

      const encodedUri = encodeURIComponent(TEST_REPLY_URI)
      const response = await app.inject({
        method: 'DELETE',
        url: `/api/replies/${encodedUri}`,
        headers: { authorization: 'Bearer test-token' },
      })

      expect(response.statusCode).toBe(204)

      // Should have deleted from PDS
      expect(deleteRecordFn).toHaveBeenCalledOnce()
      expect(deleteRecordFn.mock.calls[0]?.[0]).toBe(TEST_DID)

      // Should have soft-deleted in DB (update, not delete) + decremented replyCount
      expect(mockDb.update).toHaveBeenCalled()
      expect(mockDb.delete).not.toHaveBeenCalled()
    })

    it('soft-deletes reply as moderator (index-only soft-delete, not from PDS)', async () => {
      const modApp = await buildTestApp(testUser({ did: MOD_DID, handle: 'mod.bsky.social' }))

      const existingRow = sampleReplyRow({ authorDid: OTHER_DID })
      // First select: find reply
      selectChain.where.mockResolvedValueOnce([existingRow])
      // Second select: check user role
      selectChain.where.mockResolvedValueOnce([{ did: MOD_DID, role: 'moderator' }])

      const encodedUri = encodeURIComponent(TEST_REPLY_URI)
      const response = await modApp.inject({
        method: 'DELETE',
        url: `/api/replies/${encodedUri}`,
        headers: { authorization: 'Bearer test-token' },
      })

      expect(response.statusCode).toBe(204)
      expect(deleteRecordFn).not.toHaveBeenCalled()
      // Soft-delete: update instead of delete
      expect(mockDb.update).toHaveBeenCalled()
      expect(mockDb.delete).not.toHaveBeenCalled()

      await modApp.close()
    })

    it('deletes reply as admin (index-only delete, not from PDS)', async () => {
      const adminApp = await buildTestApp(testUser({ did: MOD_DID, handle: 'admin.bsky.social' }))

      const existingRow = sampleReplyRow({ authorDid: OTHER_DID })
      selectChain.where.mockResolvedValueOnce([existingRow])
      selectChain.where.mockResolvedValueOnce([{ did: MOD_DID, role: 'admin' }])

      const encodedUri = encodeURIComponent(TEST_REPLY_URI)
      const response = await adminApp.inject({
        method: 'DELETE',
        url: `/api/replies/${encodedUri}`,
        headers: { authorization: 'Bearer test-token' },
      })

      expect(response.statusCode).toBe(204)
      expect(deleteRecordFn).not.toHaveBeenCalled()

      await adminApp.close()
    })

    it('returns 403 when non-author regular user tries to delete', async () => {
      const existingRow = sampleReplyRow({ authorDid: OTHER_DID })
      selectChain.where.mockResolvedValueOnce([existingRow])
      selectChain.where.mockResolvedValueOnce([{ did: TEST_DID, role: 'user' }])

      const encodedUri = encodeURIComponent(TEST_REPLY_URI)
      const response = await app.inject({
        method: 'DELETE',
        url: `/api/replies/${encodedUri}`,
        headers: { authorization: 'Bearer test-token' },
      })

      expect(response.statusCode).toBe(403)
    })

    it('returns 404 when reply does not exist', async () => {
      selectChain.where.mockResolvedValueOnce([])

      const encodedUri = encodeURIComponent('at://did:plc:nobody/forum.barazo.topic.reply/ghost')
      const response = await app.inject({
        method: 'DELETE',
        url: `/api/replies/${encodedUri}`,
        headers: { authorization: 'Bearer test-token' },
      })

      expect(response.statusCode).toBe(404)
    })

    it('returns 502 when PDS delete fails', async () => {
      const existingRow = sampleReplyRow()
      selectChain.where.mockResolvedValueOnce([existingRow])
      deleteRecordFn.mockRejectedValueOnce(new Error('PDS delete failed'))

      const encodedUri = encodeURIComponent(TEST_REPLY_URI)
      const response = await app.inject({
        method: 'DELETE',
        url: `/api/replies/${encodedUri}`,
        headers: { authorization: 'Bearer test-token' },
      })

      expect(response.statusCode).toBe(502)
    })
  })

  describe('DELETE /api/replies/:uri (unauthenticated)', () => {
    let app: FastifyInstance

    beforeAll(async () => {
      app = await buildTestApp(undefined)
    })

    afterAll(async () => {
      await app.close()
    })

    it('returns 401 without auth', async () => {
      const encodedUri = encodeURIComponent(TEST_REPLY_URI)
      const response = await app.inject({
        method: 'DELETE',
        url: `/api/replies/${encodedUri}`,
        headers: {},
      })

      expect(response.statusCode).toBe(401)
    })
  })

  // =========================================================================
  // Additional branch coverage tests
  // =========================================================================

  describe('POST /api/topics/:topicUri/replies (onboarding gate)', () => {
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
      createRecordFn.mockResolvedValue({ uri: TEST_REPLY_URI, cid: TEST_REPLY_CID })
      isTrackedFn.mockResolvedValue(true)
    })

    it('returns 403 when onboarding is incomplete', async () => {
      // Topic lookup
      selectChain.where.mockResolvedValueOnce([sampleTopicRow()])
      // Override onboarding gate to return incomplete
      checkOnboardingCompleteFn.mockResolvedValueOnce({
        complete: false,
        missingFields: [{ id: 'field1', label: 'Accept Rules', fieldType: 'checkbox' }],
      })

      const encodedTopicUri = encodeURIComponent(TEST_TOPIC_URI)
      const response = await app.inject({
        method: 'POST',
        url: `/api/topics/${encodedTopicUri}/replies`,
        headers: { authorization: 'Bearer test-token' },
        payload: { content: 'My reply.' },
      })

      expect(response.statusCode).toBe(403)
      const body = response.json<{ error: string }>()
      expect(body.error).toBe('Onboarding required')
    })
  })

  describe('POST /api/topics/:topicUri/replies (anti-spam branches)', () => {
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
      createRecordFn.mockResolvedValue({ uri: TEST_REPLY_URI, cid: TEST_REPLY_CID })
      isTrackedFn.mockResolvedValue(true)
    })

    it('returns 429 when write rate limit is exceeded for untrusted user', async () => {
      // Topic lookup
      selectChain.where.mockResolvedValueOnce([sampleTopicRow()])

      // Override anti-spam mocks for this test
      vi.mocked(isAccountTrustedMock).mockResolvedValueOnce(false)
      vi.mocked(isNewAccountMock).mockResolvedValueOnce(true)
      vi.mocked(checkWriteRateLimitMock).mockResolvedValueOnce(true)

      const encodedTopicUri = encodeURIComponent(TEST_TOPIC_URI)
      const response = await app.inject({
        method: 'POST',
        url: `/api/topics/${encodedTopicUri}/replies`,
        headers: { authorization: 'Bearer test-token' },
        payload: { content: 'Rate limited reply.' },
      })

      expect(response.statusCode).toBe(429)
    })

    it('holds reply for moderation when anti-spam check flags content', async () => {
      // Topic lookup
      selectChain.where.mockResolvedValueOnce([sampleTopicRow()])

      // Anti-spam: content held
      vi.mocked(runAntiSpamChecksMock).mockResolvedValueOnce({
        held: true,
        reasons: [
          { reason: 'word_filter', matchedWords: ['spam'] },
          { reason: 'first_post_queue' },
        ],
      })

      const encodedTopicUri = encodeURIComponent(TEST_TOPIC_URI)
      const response = await app.inject({
        method: 'POST',
        url: `/api/topics/${encodedTopicUri}/replies`,
        headers: { authorization: 'Bearer test-token' },
        payload: { content: 'Spam content here.' },
      })

      expect(response.statusCode).toBe(201)
      const body = response.json<{ moderationStatus: string }>()
      expect(body.moderationStatus).toBe('held')

      // Verify moderation queue entries were inserted
      // insert is called twice: once for reply, once for moderation queue
      expect(mockDb.insert).toHaveBeenCalledTimes(2)

      // Verify topic replyCount was NOT updated (held replies are not counted)
      expect(mockDb.update).not.toHaveBeenCalled()
    })

    it('creates approved reply and updates topic replyCount when not held', async () => {
      // Topic lookup
      selectChain.where.mockResolvedValueOnce([sampleTopicRow()])

      vi.mocked(runAntiSpamChecksMock).mockResolvedValueOnce({
        held: false,
        reasons: [],
      })

      const encodedTopicUri = encodeURIComponent(TEST_TOPIC_URI)
      const response = await app.inject({
        method: 'POST',
        url: `/api/topics/${encodedTopicUri}/replies`,
        headers: { authorization: 'Bearer test-token' },
        payload: { content: 'Approved reply.' },
      })

      expect(response.statusCode).toBe(201)
      const body = response.json<{ moderationStatus: string }>()
      expect(body.moderationStatus).toBe('approved')

      // Topic replyCount should have been updated
      expect(mockDb.update).toHaveBeenCalled()
    })

    it('untrusted user that is not new still gets anti-spam checks', async () => {
      // Topic lookup
      selectChain.where.mockResolvedValueOnce([sampleTopicRow()])

      // Not trusted but also not new, and not rate limited
      vi.mocked(isAccountTrustedMock).mockResolvedValueOnce(false)
      vi.mocked(isNewAccountMock).mockResolvedValueOnce(false)
      vi.mocked(checkWriteRateLimitMock).mockResolvedValueOnce(false)

      const encodedTopicUri = encodeURIComponent(TEST_TOPIC_URI)
      const response = await app.inject({
        method: 'POST',
        url: `/api/topics/${encodedTopicUri}/replies`,
        headers: { authorization: 'Bearer test-token' },
        payload: { content: 'Non-trusted, non-new reply.' },
      })

      expect(response.statusCode).toBe(201)
      expect(vi.mocked(isNewAccountMock)).toHaveBeenCalled()
      expect(vi.mocked(checkWriteRateLimitMock)).toHaveBeenCalled()
    })
  })

  describe('POST /api/topics/:topicUri/replies (ozone service)', () => {
    let app: FastifyInstance
    const mockOzoneService = {
      isSpamLabeled: vi.fn().mockResolvedValue(false),
      batchIsSpamLabeled: vi.fn().mockResolvedValue(new Map()),
    }

    beforeAll(async () => {
      app = await buildTestApp({
        user: testUser(),
        ozoneService: mockOzoneService,
      })
    })

    afterAll(async () => {
      await app.close()
    })

    beforeEach(() => {
      vi.clearAllMocks()
      resetAllDbMocks()
      createRecordFn.mockResolvedValue({ uri: TEST_REPLY_URI, cid: TEST_REPLY_CID })
      isTrackedFn.mockResolvedValue(true)
      mockOzoneService.isSpamLabeled.mockResolvedValue(false)
    })

    it('checks ozone spam label when ozone service is available', async () => {
      selectChain.where.mockResolvedValueOnce([sampleTopicRow()])

      const encodedTopicUri = encodeURIComponent(TEST_TOPIC_URI)
      const response = await app.inject({
        method: 'POST',
        url: `/api/topics/${encodedTopicUri}/replies`,
        headers: { authorization: 'Bearer test-token' },
        payload: { content: 'Reply with ozone check.' },
      })

      expect(response.statusCode).toBe(201)
      expect(mockOzoneService.isSpamLabeled).toHaveBeenCalledWith(TEST_DID)
    })

    it('treats ozone spam-labeled user as new (stricter rate limits)', async () => {
      selectChain.where.mockResolvedValueOnce([sampleTopicRow()])
      mockOzoneService.isSpamLabeled.mockResolvedValueOnce(true)

      // Spam-labeled means isAccountTrusted check returns false due to ozoneSpamLabeled
      vi.mocked(isAccountTrustedMock).mockResolvedValueOnce(false)
      // Rate limit not exceeded
      vi.mocked(checkWriteRateLimitMock).mockResolvedValueOnce(false)

      const encodedTopicUri = encodeURIComponent(TEST_TOPIC_URI)
      const response = await app.inject({
        method: 'POST',
        url: `/api/topics/${encodedTopicUri}/replies`,
        headers: { authorization: 'Bearer test-token' },
        payload: { content: 'Ozone spam labeled user reply.' },
      })

      expect(response.statusCode).toBe(201)
      // isNewAccount should NOT be called because ozoneSpamLabeled short-circuits to isNew = true
      expect(vi.mocked(isNewAccountMock)).not.toHaveBeenCalled()
    })
  })

  describe('POST /api/topics/:topicUri/replies (PDS and DB error re-throws)', () => {
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
      createRecordFn.mockResolvedValue({ uri: TEST_REPLY_URI, cid: TEST_REPLY_CID })
      isTrackedFn.mockResolvedValue(true)
    })

    it('re-throws PDS error with statusCode property', async () => {
      selectChain.where.mockResolvedValueOnce([sampleTopicRow()])
      const httpError = new Error('Upstream error') as Error & { statusCode: number }
      httpError.statusCode = 503
      createRecordFn.mockRejectedValueOnce(httpError)

      const encodedTopicUri = encodeURIComponent(TEST_TOPIC_URI)
      const response = await app.inject({
        method: 'POST',
        url: `/api/topics/${encodedTopicUri}/replies`,
        headers: { authorization: 'Bearer test-token' },
        payload: { content: 'PDS error with status code.' },
      })

      // The error with statusCode is re-thrown, Fastify converts it to that status
      expect(response.statusCode).toBe(503)
    })

    it('returns 500 when local DB save fails after PDS write', async () => {
      selectChain.where.mockResolvedValueOnce([sampleTopicRow()])
      createRecordFn.mockResolvedValueOnce({ uri: TEST_REPLY_URI, cid: TEST_REPLY_CID })
      isTrackedFn.mockResolvedValueOnce(true)

      // Make the DB insert throw
      insertChain.values.mockImplementationOnce(() => {
        throw new Error('DB connection lost')
      })

      const encodedTopicUri = encodeURIComponent(TEST_TOPIC_URI)
      const response = await app.inject({
        method: 'POST',
        url: `/api/topics/${encodedTopicUri}/replies`,
        headers: { authorization: 'Bearer test-token' },
        payload: { content: 'DB will fail.' },
      })

      expect(response.statusCode).toBe(500)
    })

    it('re-throws DB error with statusCode property in post-PDS catch block', async () => {
      selectChain.where.mockResolvedValueOnce([sampleTopicRow()])
      createRecordFn.mockResolvedValueOnce({ uri: TEST_REPLY_URI, cid: TEST_REPLY_CID })
      isTrackedFn.mockResolvedValueOnce(true)

      const httpError = new Error('Already exists') as Error & { statusCode: number }
      httpError.statusCode = 409
      insertChain.values.mockImplementationOnce(() => {
        throw httpError
      })

      const encodedTopicUri = encodeURIComponent(TEST_TOPIC_URI)
      const response = await app.inject({
        method: 'POST',
        url: `/api/topics/${encodedTopicUri}/replies`,
        headers: { authorization: 'Bearer test-token' },
        payload: { content: 'DB error with status.' },
      })

      expect(response.statusCode).toBe(409)
    })
  })

  describe('GET /api/topics/:topicUri/replies (maturity filtering)', () => {
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
    })

    it('returns 403 when category maturity exceeds user max maturity', async () => {
      // Topic lookup
      selectChain.where.mockResolvedValueOnce([sampleTopicRow({ category: 'adult-content' })])
      // Category maturity: adult
      selectChain.where.mockResolvedValueOnce([{ maturityRating: 'adult' }])
      // User profile: safe maturity pref
      selectChain.where.mockResolvedValueOnce([{ declaredAge: 25, maturityPref: 'safe' }])
      // Community settings
      selectChain.where.mockResolvedValueOnce([{ ageThreshold: 16 }])

      const encodedTopicUri = encodeURIComponent(TEST_TOPIC_URI)
      const response = await app.inject({
        method: 'GET',
        url: `/api/topics/${encodedTopicUri}/replies`,
      })

      expect(response.statusCode).toBe(403)
    })

    it('defaults category maturity to safe when category not found', async () => {
      // Topic lookup
      selectChain.where.mockResolvedValueOnce([sampleTopicRow()])
      // Category maturity: empty (not found)
      selectChain.where.mockResolvedValueOnce([])
      // User profile
      selectChain.where.mockResolvedValueOnce([{ declaredAge: 25, maturityPref: 'safe' }])
      // Community settings
      selectChain.where.mockResolvedValueOnce([{ ageThreshold: 16 }])
      // Block/mute
      selectChain.where.mockResolvedValueOnce([])
      // Replies
      selectChain.limit.mockResolvedValueOnce([])

      const encodedTopicUri = encodeURIComponent(TEST_TOPIC_URI)
      const response = await app.inject({
        method: 'GET',
        url: `/api/topics/${encodedTopicUri}/replies`,
      })

      // Should still succeed because default maturity is 'safe' which passes
      expect(response.statusCode).toBe(200)
    })

    it('defaults ageThreshold to 16 when community settings not found', async () => {
      // Topic lookup
      selectChain.where.mockResolvedValueOnce([sampleTopicRow()])
      // Category maturity
      selectChain.where.mockResolvedValueOnce([{ maturityRating: 'safe' }])
      // User profile
      selectChain.where.mockResolvedValueOnce([{ declaredAge: 25, maturityPref: 'safe' }])
      // Community settings: not found (empty)
      selectChain.where.mockResolvedValueOnce([])
      // Block/mute
      selectChain.where.mockResolvedValueOnce([])
      // Replies
      selectChain.limit.mockResolvedValueOnce([])

      const encodedTopicUri = encodeURIComponent(TEST_TOPIC_URI)
      const response = await app.inject({
        method: 'GET',
        url: `/api/topics/${encodedTopicUri}/replies`,
      })

      expect(response.statusCode).toBe(200)
    })

    it('handles unauthenticated user with safe maturity only', async () => {
      const noAuthApp = await buildTestApp(undefined)

      // Topic lookup
      selectChain.where.mockResolvedValueOnce([sampleTopicRow()])
      // Category maturity: safe
      selectChain.where.mockResolvedValueOnce([{ maturityRating: 'safe' }])
      // No user profile query for unauthenticated
      // Community settings
      selectChain.where.mockResolvedValueOnce([{ ageThreshold: 16 }])
      // No block/mute for unauthenticated
      // Replies
      selectChain.limit.mockResolvedValueOnce([])

      const encodedTopicUri = encodeURIComponent(TEST_TOPIC_URI)
      const response = await noAuthApp.inject({
        method: 'GET',
        url: `/api/topics/${encodedTopicUri}/replies`,
      })

      expect(response.statusCode).toBe(200)
      await noAuthApp.close()
    })

    it('handles user with no profile row in DB', async () => {
      // Topic lookup
      selectChain.where.mockResolvedValueOnce([sampleTopicRow()])
      // Category maturity
      selectChain.where.mockResolvedValueOnce([{ maturityRating: 'safe' }])
      // User profile: not found (empty)
      selectChain.where.mockResolvedValueOnce([])
      // Community settings
      selectChain.where.mockResolvedValueOnce([{ ageThreshold: 16 }])
      // Block/mute
      selectChain.where.mockResolvedValueOnce([])
      // Replies
      selectChain.limit.mockResolvedValueOnce([])

      const encodedTopicUri = encodeURIComponent(TEST_TOPIC_URI)
      const response = await app.inject({
        method: 'GET',
        url: `/api/topics/${encodedTopicUri}/replies`,
      })

      // User profile not found means userProfile is undefined -> resolveMaxMaturity returns 'safe'
      expect(response.statusCode).toBe(200)
    })
  })

  describe('GET /api/topics/:topicUri/replies (cursor edge cases)', () => {
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
    })

    it('ignores invalid cursor (malformed base64)', async () => {
      selectChain.where.mockResolvedValueOnce([sampleTopicRow()])
      selectChain.limit.mockResolvedValueOnce([])

      const encodedTopicUri = encodeURIComponent(TEST_TOPIC_URI)
      const response = await app.inject({
        method: 'GET',
        url: `/api/topics/${encodedTopicUri}/replies?cursor=not-valid-base64!!!`,
      })

      expect(response.statusCode).toBe(200)
    })

    it('ignores cursor with missing fields', async () => {
      selectChain.where.mockResolvedValueOnce([sampleTopicRow()])
      selectChain.limit.mockResolvedValueOnce([])

      // Valid base64 but missing required fields
      const badCursor = Buffer.from(JSON.stringify({ foo: 'bar' })).toString('base64')
      const encodedTopicUri = encodeURIComponent(TEST_TOPIC_URI)
      const response = await app.inject({
        method: 'GET',
        url: `/api/topics/${encodedTopicUri}/replies?cursor=${encodeURIComponent(badCursor)}`,
      })

      expect(response.statusCode).toBe(200)
    })

    it('ignores cursor with non-string field values', async () => {
      selectChain.where.mockResolvedValueOnce([sampleTopicRow()])
      selectChain.limit.mockResolvedValueOnce([])

      // Valid base64 JSON but createdAt is a number
      const badCursor = Buffer.from(JSON.stringify({ createdAt: 123, uri: 'at://...' })).toString(
        'base64'
      )
      const encodedTopicUri = encodeURIComponent(TEST_TOPIC_URI)
      const response = await app.inject({
        method: 'GET',
        url: `/api/topics/${encodedTopicUri}/replies?cursor=${encodeURIComponent(badCursor)}`,
      })

      expect(response.statusCode).toBe(200)
    })
  })

  describe('GET /api/topics/:topicUri/replies (ozone annotation)', () => {
    let app: FastifyInstance
    const mockOzoneService = {
      isSpamLabeled: vi.fn().mockResolvedValue(false),
      batchIsSpamLabeled: vi.fn().mockResolvedValue(new Map()),
    }

    beforeAll(async () => {
      app = await buildTestApp({
        user: testUser(),
        ozoneService: mockOzoneService,
      })
    })

    afterAll(async () => {
      await app.close()
    })

    beforeEach(() => {
      vi.clearAllMocks()
      resetAllDbMocks()
    })

    it('annotates replies with ozone spam labels when service is available', async () => {
      const spamDid = 'did:plc:spammer'

      selectChain.where.mockResolvedValueOnce([sampleTopicRow()])
      // Category maturity
      selectChain.where.mockResolvedValueOnce([{ maturityRating: 'safe' }])
      // User profile
      selectChain.where.mockResolvedValueOnce([{ declaredAge: 25, maturityPref: 'safe' }])
      // Community settings
      selectChain.where.mockResolvedValueOnce([{ ageThreshold: 16 }])
      // Block/mute (loadBlockMuteLists)
      selectChain.where.mockResolvedValueOnce([])

      // Replies query uses .where -> chain -> .orderBy -> .limit
      selectChain.where.mockImplementationOnce(() => selectChain)
      const rows = [
        sampleReplyRow({
          authorDid: spamDid,
          uri: `at://${spamDid}/forum.barazo.topic.reply/s1`,
          rkey: 's1',
        }),
        sampleReplyRow({ authorDid: TEST_DID }),
      ]
      selectChain.limit.mockResolvedValueOnce(rows)

      selectChain.where.mockImplementationOnce(() => selectChain) // child count query

      // Ozone batch: spamDid is spam-labeled, TEST_DID is not
      mockOzoneService.batchIsSpamLabeled.mockResolvedValueOnce(
        new Map([
          [spamDid, true],
          [TEST_DID, false],
        ])
      )

      // resolveAuthors: users table query
      selectChain.where.mockResolvedValueOnce([
        {
          did: spamDid,
          handle: 'spammer.bsky.social',
          displayName: 'Spammer',
          avatarUrl: null,
          bannerUrl: null,
          bio: null,
        },
        {
          did: TEST_DID,
          handle: TEST_HANDLE,
          displayName: 'Jay',
          avatarUrl: null,
          bannerUrl: null,
          bio: null,
        },
      ])
      // resolveAuthors: community profiles query
      selectChain.where.mockResolvedValueOnce([])
      // loadMutedWords: global
      selectChain.where.mockResolvedValueOnce([])
      // loadMutedWords: community
      selectChain.where.mockResolvedValueOnce([])

      const encodedTopicUri = encodeURIComponent(TEST_TOPIC_URI)
      const response = await app.inject({
        method: 'GET',
        url: `/api/topics/${encodedTopicUri}/replies`,
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{
        replies: Array<{ authorDid: string; ozoneLabel: string | null }>
      }>()
      expect(body.replies).toHaveLength(2)

      const spamReply = body.replies.find((r) => r.authorDid === spamDid)
      expect(spamReply?.ozoneLabel).toBe('spam')

      const normalReply = body.replies.find((r) => r.authorDid === TEST_DID)
      expect(normalReply?.ozoneLabel).toBeNull()
    })
  })

  describe('GET /api/topics/:topicUri/replies (serializeReply branches)', () => {
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
    })

    it('returns placeholder content for author-deleted replies', async () => {
      selectChain.where.mockResolvedValueOnce([sampleTopicRow()])

      const authorDeletedReply = sampleReplyRow({
        isAuthorDeleted: true,
        content: 'Original content before deletion',
      })
      selectChain.limit.mockResolvedValueOnce([authorDeletedReply])

      const encodedTopicUri = encodeURIComponent(TEST_TOPIC_URI)
      const response = await app.inject({
        method: 'GET',
        url: `/api/topics/${encodedTopicUri}/replies`,
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{
        replies: Array<{ content: string }>
      }>()
      expect(body.replies).toHaveLength(1)
      // Author-deleted replies return placeholder content
      expect(body.replies[0]?.content).toBe('[Deleted by author]')
    })

    it('returns placeholder content for mod-deleted reply', async () => {
      selectChain.where.mockResolvedValueOnce([sampleTopicRow()])

      const modDeletedReply = sampleReplyRow({
        isModDeleted: true,
        isAuthorDeleted: false,
        content: 'Violating content',
      })
      selectChain.limit.mockResolvedValueOnce([modDeletedReply])

      const encodedTopicUri = encodeURIComponent(TEST_TOPIC_URI)
      const response = await app.inject({
        method: 'GET',
        url: `/api/topics/${encodedTopicUri}/replies`,
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{
        replies: Array<{ content: string }>
      }>()
      expect(body.replies).toHaveLength(1)
      expect(body.replies[0]?.content).toBe('[Removed by moderator]')
    })

    it('prioritizes mod-deleted placeholder over author-deleted when both are true', async () => {
      selectChain.where.mockResolvedValueOnce([sampleTopicRow()])

      const bothDeletedReply = sampleReplyRow({
        isAuthorDeleted: true,
        isModDeleted: true,
        content: 'Original content',
      })
      selectChain.limit.mockResolvedValueOnce([bothDeletedReply])

      const encodedTopicUri = encodeURIComponent(TEST_TOPIC_URI)
      const response = await app.inject({
        method: 'GET',
        url: `/api/topics/${encodedTopicUri}/replies`,
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{
        replies: Array<{ content: string }>
      }>()
      expect(body.replies).toHaveLength(1)
      expect(body.replies[0]?.content).toBe('[Removed by moderator]')
    })

    it('includes isModDeleted in serialized response', async () => {
      selectChain.where.mockResolvedValueOnce([sampleTopicRow()])

      const modDeletedReply = sampleReplyRow({
        isModDeleted: true,
        isAuthorDeleted: false,
      })
      selectChain.limit.mockResolvedValueOnce([modDeletedReply])

      const encodedTopicUri = encodeURIComponent(TEST_TOPIC_URI)
      const response = await app.inject({
        method: 'GET',
        url: `/api/topics/${encodedTopicUri}/replies`,
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{
        replies: Array<{ isAuthorDeleted: boolean; isModDeleted: boolean }>
      }>()
      expect(body.replies).toHaveLength(1)
      expect(body.replies[0]?.isModDeleted).toBe(true)
      expect(body.replies[0]?.isAuthorDeleted).toBe(false)
    })

    it('includes isAuthorDeleted and isModDeleted as false for normal replies', async () => {
      selectChain.where.mockResolvedValueOnce([sampleTopicRow()])

      const normalReply = sampleReplyRow({
        isAuthorDeleted: false,
        isModDeleted: false,
      })
      selectChain.limit.mockResolvedValueOnce([normalReply])

      const encodedTopicUri = encodeURIComponent(TEST_TOPIC_URI)
      const response = await app.inject({
        method: 'GET',
        url: `/api/topics/${encodedTopicUri}/replies`,
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{
        replies: Array<{ isAuthorDeleted: boolean; isModDeleted: boolean }>
      }>()
      expect(body.replies).toHaveLength(1)
      expect(body.replies[0]?.isModDeleted).toBe(false)
      expect(body.replies[0]?.isAuthorDeleted).toBe(false)
    })
  })

  describe('PUT /api/replies/:uri (error branches)', () => {
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
      updateRecordFn.mockResolvedValue({ uri: TEST_REPLY_URI, cid: 'bafyreinewcid' })
    })

    it('re-throws PDS error with statusCode property', async () => {
      const existingRow = sampleReplyRow()
      selectChain.where.mockResolvedValueOnce([existingRow])
      const httpError = new Error('PDS upstream error') as Error & { statusCode: number }
      httpError.statusCode = 503
      updateRecordFn.mockRejectedValueOnce(httpError)

      const encodedUri = encodeURIComponent(TEST_REPLY_URI)
      const response = await app.inject({
        method: 'PUT',
        url: `/api/replies/${encodedUri}`,
        headers: { authorization: 'Bearer test-token' },
        payload: { content: 'Will fail with statusCode.' },
      })

      expect(response.statusCode).toBe(503)
    })

    it('returns 500 when local DB update fails after PDS write', async () => {
      const existingRow = sampleReplyRow()
      selectChain.where.mockResolvedValueOnce([existingRow])

      // Make the DB update throw
      updateChain.set.mockImplementationOnce(() => {
        throw new Error('DB write failed')
      })

      const encodedUri = encodeURIComponent(TEST_REPLY_URI)
      const response = await app.inject({
        method: 'PUT',
        url: `/api/replies/${encodedUri}`,
        headers: { authorization: 'Bearer test-token' },
        payload: { content: 'DB will fail on update.' },
      })

      expect(response.statusCode).toBe(500)
    })

    it('re-throws DB error with statusCode property in post-PDS catch block', async () => {
      const existingRow = sampleReplyRow()
      selectChain.where.mockResolvedValueOnce([existingRow])

      const httpError = new Error('Conflict') as Error & { statusCode: number }
      httpError.statusCode = 409
      updateChain.set.mockImplementationOnce(() => {
        throw httpError
      })

      const encodedUri = encodeURIComponent(TEST_REPLY_URI)
      const response = await app.inject({
        method: 'PUT',
        url: `/api/replies/${encodedUri}`,
        headers: { authorization: 'Bearer test-token' },
        payload: { content: 'DB error with status code.' },
      })

      expect(response.statusCode).toBe(409)
    })

    it('returns 404 when reply is not found after DB update (returning is empty)', async () => {
      const existingRow = sampleReplyRow()
      selectChain.where.mockResolvedValueOnce([existingRow])
      // DB returning empty
      updateChain.returning.mockResolvedValueOnce([])

      const encodedUri = encodeURIComponent(TEST_REPLY_URI)
      const response = await app.inject({
        method: 'PUT',
        url: `/api/replies/${encodedUri}`,
        headers: { authorization: 'Bearer test-token' },
        payload: { content: 'Update but returning empty.' },
      })

      expect(response.statusCode).toBe(404)
    })

    it('resolves labels from existing row when labels field is omitted and existing labels are null', async () => {
      const existingRow = sampleReplyRow({ labels: null })
      selectChain.where.mockResolvedValueOnce([existingRow])
      const updatedRow = { ...existingRow, content: 'New content', cid: 'bafyreinewcid' }
      updateChain.returning.mockResolvedValueOnce([updatedRow])

      const encodedUri = encodeURIComponent(TEST_REPLY_URI)
      const response = await app.inject({
        method: 'PUT',
        url: `/api/replies/${encodedUri}`,
        headers: { authorization: 'Bearer test-token' },
        payload: { content: 'New content' },
      })

      expect(response.statusCode).toBe(200)

      // PDS record should NOT include labels key since resolvedLabels is null (falsy)
      const pdsRecord = updateRecordFn.mock.calls[0]?.[3] as Record<string, unknown>
      expect(pdsRecord).not.toHaveProperty('labels')
    })
  })

  describe('DELETE /api/replies/:uri (error branches)', () => {
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

    it('re-throws PDS error with statusCode property', async () => {
      const existingRow = sampleReplyRow()
      selectChain.where.mockResolvedValueOnce([existingRow])
      const httpError = new Error('PDS upstream') as Error & { statusCode: number }
      httpError.statusCode = 503
      deleteRecordFn.mockRejectedValueOnce(httpError)

      const encodedUri = encodeURIComponent(TEST_REPLY_URI)
      const response = await app.inject({
        method: 'DELETE',
        url: `/api/replies/${encodedUri}`,
        headers: { authorization: 'Bearer test-token' },
      })

      expect(response.statusCode).toBe(503)
    })

    it('returns 500 when DB transaction fails after PDS delete', async () => {
      const existingRow = sampleReplyRow()
      selectChain.where.mockResolvedValueOnce([existingRow])
      deleteRecordFn.mockResolvedValueOnce(undefined)

      // Make the transaction throw
      mockDb.transaction.mockImplementationOnce(() => {
        throw new Error('Transaction failed')
      })

      const encodedUri = encodeURIComponent(TEST_REPLY_URI)
      const response = await app.inject({
        method: 'DELETE',
        url: `/api/replies/${encodedUri}`,
        headers: { authorization: 'Bearer test-token' },
      })

      expect(response.statusCode).toBe(500)
    })

    it('re-throws DB error with statusCode property in delete catch block', async () => {
      const existingRow = sampleReplyRow()
      selectChain.where.mockResolvedValueOnce([existingRow])
      deleteRecordFn.mockResolvedValueOnce(undefined)

      const httpError = new Error('DB error') as Error & { statusCode: number }
      httpError.statusCode = 409
      mockDb.transaction.mockImplementationOnce(() => {
        throw httpError
      })

      const encodedUri = encodeURIComponent(TEST_REPLY_URI)
      const response = await app.inject({
        method: 'DELETE',
        url: `/api/replies/${encodedUri}`,
        headers: { authorization: 'Bearer test-token' },
      })

      expect(response.statusCode).toBe(409)
    })

    it('returns 403 when non-author and user row not found in DB', async () => {
      const existingRow = sampleReplyRow({ authorDid: OTHER_DID })
      selectChain.where.mockResolvedValueOnce([existingRow])
      // User lookup: empty (user not found in DB)
      selectChain.where.mockResolvedValueOnce([])

      const encodedUri = encodeURIComponent(TEST_REPLY_URI)
      const response = await app.inject({
        method: 'DELETE',
        url: `/api/replies/${encodedUri}`,
        headers: { authorization: 'Bearer test-token' },
      })

      // userRow is undefined, so isMod = (undefined?.role === 'moderator') = false
      expect(response.statusCode).toBe(403)
    })

    it('skips PDS deletion for moderator delete (moderator not author)', async () => {
      const modApp = await buildTestApp(testUser({ did: MOD_DID, handle: 'mod.bsky.social' }))

      const existingRow = sampleReplyRow({ authorDid: OTHER_DID })
      selectChain.where.mockResolvedValueOnce([existingRow])
      selectChain.where.mockResolvedValueOnce([{ did: MOD_DID, role: 'moderator' }])

      const encodedUri = encodeURIComponent(TEST_REPLY_URI)
      const response = await modApp.inject({
        method: 'DELETE',
        url: `/api/replies/${encodedUri}`,
        headers: { authorization: 'Bearer test-token' },
      })

      expect(response.statusCode).toBe(204)
      // PDS deleteRecord should NOT be called for mod deletes
      expect(deleteRecordFn).not.toHaveBeenCalled()
      // DB transaction should still be called for soft-delete
      expect(mockDb.transaction).toHaveBeenCalled()

      await modApp.close()
    })
  })

  // =========================================================================
  // Defensive guard branches (!user checks inside handlers)
  // =========================================================================

  describe('Defensive user guards (passthrough auth)', () => {
    let app: FastifyInstance

    beforeAll(async () => {
      app = await buildTestApp({ passthroughAuth: true })
    })

    afterAll(async () => {
      await app.close()
    })

    beforeEach(() => {
      vi.clearAllMocks()
      resetAllDbMocks()
    })

    it('POST returns 401 from handler-level guard when middleware does not set user', async () => {
      const encodedTopicUri = encodeURIComponent(TEST_TOPIC_URI)
      const response = await app.inject({
        method: 'POST',
        url: `/api/topics/${encodedTopicUri}/replies`,
        headers: { authorization: 'Bearer test-token' },
        payload: { content: 'No user set.' },
      })

      expect(response.statusCode).toBe(401)
      const body = response.json<{ error: string }>()
      expect(body.error).toBe('Authentication required')
    })

    it('PUT returns 401 from handler-level guard when middleware does not set user', async () => {
      const encodedUri = encodeURIComponent(TEST_REPLY_URI)
      const response = await app.inject({
        method: 'PUT',
        url: `/api/replies/${encodedUri}`,
        headers: { authorization: 'Bearer test-token' },
        payload: { content: 'No user set.' },
      })

      expect(response.statusCode).toBe(401)
      const body = response.json<{ error: string }>()
      expect(body.error).toBe('Authentication required')
    })

    it('DELETE returns 401 from handler-level guard when middleware does not set user', async () => {
      const encodedUri = encodeURIComponent(TEST_REPLY_URI)
      const response = await app.inject({
        method: 'DELETE',
        url: `/api/replies/${encodedUri}`,
        headers: { authorization: 'Bearer test-token' },
      })

      expect(response.statusCode).toBe(401)
      const body = response.json<{ error: string }>()
      expect(body.error).toBe('Authentication required')
    })
  })

  // =========================================================================
  // GET /api/replies/by-author-rkey/:handle/:rkey
  // =========================================================================

  describe('GET /api/replies/by-author-rkey/:handle/:rkey', () => {
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
    })

    it('returns a reply by author handle and rkey', async () => {
      resolveHandleToDidFn.mockResolvedValueOnce(TEST_DID)
      const row = sampleReplyRow()
      selectChain.where.mockResolvedValueOnce([row])

      const response = await app.inject({
        method: 'GET',
        url: `/api/replies/by-author-rkey/${TEST_HANDLE}/${TEST_REPLY_RKEY}`,
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{ uri: string; rkey: string; content: string }>()
      expect(body.uri).toBe(TEST_REPLY_URI)
      expect(body.rkey).toBe(TEST_REPLY_RKEY)
      expect(body.content).toBe('This is a test reply')
    })

    it('returns 404 when handle cannot be resolved', async () => {
      resolveHandleToDidFn.mockResolvedValueOnce(null)

      const response = await app.inject({
        method: 'GET',
        url: '/api/replies/by-author-rkey/unknown.handle/reply001',
      })

      expect(response.statusCode).toBe(404)
    })

    it('enriches author profile in by-author-rkey response', async () => {
      resolveHandleToDidFn.mockResolvedValueOnce(TEST_DID)
      const row = sampleReplyRow()
      // 1. find reply by authorDid + rkey
      selectChain.where.mockResolvedValueOnce([row])
      // 2. resolveAuthors: users table
      selectChain.where.mockResolvedValueOnce([
        {
          did: TEST_DID,
          handle: TEST_HANDLE,
          displayName: 'Jay',
          avatarUrl: 'https://cdn.example.com/jay.jpg',
          bannerUrl: null,
          bio: null,
        },
      ])
      // 3. resolveAuthors: community profiles
      selectChain.where.mockResolvedValueOnce([])

      const response = await app.inject({
        method: 'GET',
        url: `/api/replies/by-author-rkey/${TEST_HANDLE}/${TEST_REPLY_RKEY}`,
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{
        author: { did: string; handle: string; displayName: string; avatarUrl: string }
      }>()
      expect(body.author).toEqual({
        did: TEST_DID,
        handle: TEST_HANDLE,
        displayName: 'Jay',
        avatarUrl: 'https://cdn.example.com/jay.jpg',
      })
    })

    it('returns 404 when reply not found for author', async () => {
      resolveHandleToDidFn.mockResolvedValueOnce(TEST_DID)
      selectChain.where.mockResolvedValueOnce([])

      const response = await app.inject({
        method: 'GET',
        url: `/api/replies/by-author-rkey/${TEST_HANDLE}/nonexistent`,
      })

      expect(response.statusCode).toBe(404)
    })
  })
})
