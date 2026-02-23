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
const deleteRecordFn = vi.fn<(did: string, collection: string, rkey: string) => Promise<void>>()

vi.mock('../../../src/lib/pds-client.js', () => ({
  createPdsClient: () => ({
    createRecord: createRecordFn,
    deleteRecord: deleteRecordFn,
    updateRecord: vi.fn(),
  }),
}))

// Import routes AFTER mocking
import { voteRoutes } from '../../../src/routes/votes.js'

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
const TEST_HANDLE = 'alice.bsky.social'
const TEST_SID = 'a'.repeat(64)
const OTHER_DID = 'did:plc:otheruser456'
const COMMUNITY_DID = 'did:plc:community123'

const TEST_TOPIC_URI = `at://${OTHER_DID}/forum.barazo.topic.post/topic123`
const TEST_TOPIC_CID = 'bafyreitopic123'
const TEST_REPLY_URI = `at://${OTHER_DID}/forum.barazo.topic.reply/reply123`
const TEST_REPLY_CID = 'bafyreireply123'

const TEST_VOTE_URI = `at://${TEST_DID}/forum.barazo.interaction.vote/vote123`
const TEST_VOTE_CID = 'bafyreivote123'
const TEST_NOW = '2026-02-13T12:00:00.000Z'

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
// Chainable mock DB
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
  mockDb.transaction.mockImplementation(async (fn: (tx: typeof mockDb) => Promise<unknown>) => {
    return await fn(mockDb)
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

// ---------------------------------------------------------------------------
// Sample data builders
// ---------------------------------------------------------------------------

function sampleVoteRow(overrides?: Record<string, unknown>) {
  return {
    uri: TEST_VOTE_URI,
    rkey: 'vote123',
    authorDid: TEST_DID,
    subjectUri: TEST_TOPIC_URI,
    subjectCid: TEST_TOPIC_CID,
    direction: 'up',
    communityDid: COMMUNITY_DID,
    cid: TEST_VOTE_CID,
    createdAt: new Date(TEST_NOW),
    indexedAt: new Date(TEST_NOW),
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Helper: build app with mocked deps
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
  app.decorateRequest('user', undefined as RequestUser | undefined)
  app.decorateRequest('communityDid', undefined as string | undefined)
  app.addHook('onRequest', async (request) => {
    request.communityDid = 'did:plc:test'
  })

  await app.register(voteRoutes())
  await app.ready()

  return app
}

// ===========================================================================
// Test suite
// ===========================================================================

describe('vote routes', () => {
  // =========================================================================
  // POST /api/votes
  // =========================================================================

  describe('POST /api/votes', () => {
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
      createRecordFn.mockResolvedValue({ uri: TEST_VOTE_URI, cid: TEST_VOTE_CID })
      isTrackedFn.mockResolvedValue(true)
    })

    it('creates a vote on a topic and returns 201', async () => {
      // 0. Onboarding gate: no mandatory fields
      selectChain.where.mockResolvedValueOnce([])
      // 1. Subject existence check -> topic found
      selectChain.where.mockResolvedValueOnce([{ uri: TEST_TOPIC_URI }])
      // 2. Insert returning
      insertChain.returning.mockResolvedValueOnce([sampleVoteRow()])

      const response = await app.inject({
        method: 'POST',
        url: '/api/votes',
        headers: { authorization: 'Bearer test-token' },
        payload: {
          subjectUri: TEST_TOPIC_URI,
          subjectCid: TEST_TOPIC_CID,
          direction: 'up',
        },
      })

      expect(response.statusCode).toBe(201)
      const body = response.json<{
        uri: string
        cid: string
        rkey: string
        direction: string
        subjectUri: string
      }>()
      expect(body.uri).toBe(TEST_VOTE_URI)
      expect(body.cid).toBe(TEST_VOTE_CID)
      expect(body.direction).toBe('up')
      expect(body.subjectUri).toBe(TEST_TOPIC_URI)

      // Should have called PDS createRecord
      expect(createRecordFn).toHaveBeenCalledOnce()
      expect(createRecordFn.mock.calls[0]?.[0]).toBe(TEST_DID)
      expect(createRecordFn.mock.calls[0]?.[1]).toBe('forum.barazo.interaction.vote')

      // Should have inserted into DB
      expect(mockDb.insert).toHaveBeenCalledOnce()
      // Should have incremented vote count
      expect(mockDb.update).toHaveBeenCalledOnce()
    })

    it('creates a vote on a reply and returns 201', async () => {
      // 0. Onboarding gate: no mandatory fields
      selectChain.where.mockResolvedValueOnce([])
      // 1. Subject existence check -> reply found
      selectChain.where.mockResolvedValueOnce([{ uri: TEST_REPLY_URI }])
      // 2. Insert returning
      const replyVote = sampleVoteRow({
        subjectUri: TEST_REPLY_URI,
        subjectCid: TEST_REPLY_CID,
      })
      insertChain.returning.mockResolvedValueOnce([replyVote])

      const response = await app.inject({
        method: 'POST',
        url: '/api/votes',
        headers: { authorization: 'Bearer test-token' },
        payload: {
          subjectUri: TEST_REPLY_URI,
          subjectCid: TEST_REPLY_CID,
          direction: 'up',
        },
      })

      expect(response.statusCode).toBe(201)
      const body = response.json<{ subjectUri: string }>()
      expect(body.subjectUri).toBe(TEST_REPLY_URI)
    })

    it("tracks new user's repo on first vote", async () => {
      isTrackedFn.mockResolvedValue(false)
      trackRepoFn.mockResolvedValue(undefined)

      // 0. Onboarding gate: no mandatory fields
      selectChain.where.mockResolvedValueOnce([])
      selectChain.where.mockResolvedValueOnce([{ uri: TEST_TOPIC_URI }])
      insertChain.returning.mockResolvedValueOnce([sampleVoteRow()])

      const response = await app.inject({
        method: 'POST',
        url: '/api/votes',
        headers: { authorization: 'Bearer test-token' },
        payload: {
          subjectUri: TEST_TOPIC_URI,
          subjectCid: TEST_TOPIC_CID,
          direction: 'up',
        },
      })

      expect(response.statusCode).toBe(201)
      expect(isTrackedFn).toHaveBeenCalledWith(TEST_DID)
      expect(trackRepoFn).toHaveBeenCalledWith(TEST_DID)
    })

    it('returns 400 for missing subjectUri', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/votes',
        headers: { authorization: 'Bearer test-token' },
        payload: {
          subjectCid: TEST_TOPIC_CID,
          direction: 'up',
        },
      })

      expect(response.statusCode).toBe(400)
    })

    it('returns 400 for missing subjectCid', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/votes',
        headers: { authorization: 'Bearer test-token' },
        payload: {
          subjectUri: TEST_TOPIC_URI,
          direction: 'up',
        },
      })

      expect(response.statusCode).toBe(400)
    })

    it('returns 400 for missing direction', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/votes',
        headers: { authorization: 'Bearer test-token' },
        payload: {
          subjectUri: TEST_TOPIC_URI,
          subjectCid: TEST_TOPIC_CID,
        },
      })

      expect(response.statusCode).toBe(400)
    })

    it('returns 400 for invalid direction', async () => {
      // 0. Onboarding gate: no mandatory fields
      selectChain.where.mockResolvedValueOnce([])

      const response = await app.inject({
        method: 'POST',
        url: '/api/votes',
        headers: { authorization: 'Bearer test-token' },
        payload: {
          subjectUri: TEST_TOPIC_URI,
          subjectCid: TEST_TOPIC_CID,
          direction: 'down',
        },
      })

      expect(response.statusCode).toBe(400)
    })

    it('returns 400 for empty body', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/votes',
        headers: { authorization: 'Bearer test-token' },
        payload: {},
      })

      expect(response.statusCode).toBe(400)
    })

    it('returns 404 when subject does not exist', async () => {
      // 0. Onboarding gate: no mandatory fields
      selectChain.where.mockResolvedValueOnce([])
      // Subject not found
      selectChain.where.mockResolvedValueOnce([])

      const response = await app.inject({
        method: 'POST',
        url: '/api/votes',
        headers: { authorization: 'Bearer test-token' },
        payload: {
          subjectUri: TEST_TOPIC_URI,
          subjectCid: TEST_TOPIC_CID,
          direction: 'up',
        },
      })

      expect(response.statusCode).toBe(404)
    })

    it('returns 404 when subject URI has unknown collection', async () => {
      // 0. Onboarding gate: no mandatory fields
      selectChain.where.mockResolvedValueOnce([])

      const response = await app.inject({
        method: 'POST',
        url: '/api/votes',
        headers: { authorization: 'Bearer test-token' },
        payload: {
          subjectUri: `at://${OTHER_DID}/some.unknown.collection/xyz123`,
          subjectCid: 'bafyreixyz',
          direction: 'up',
        },
      })

      expect(response.statusCode).toBe(404)
    })

    it('returns 409 when duplicate vote (unique constraint)', async () => {
      // 0. Onboarding gate: no mandatory fields
      selectChain.where.mockResolvedValueOnce([])
      selectChain.where.mockResolvedValueOnce([{ uri: TEST_TOPIC_URI }])
      // onConflictDoNothing -> returning() returns empty array
      insertChain.returning.mockResolvedValueOnce([])

      const response = await app.inject({
        method: 'POST',
        url: '/api/votes',
        headers: { authorization: 'Bearer test-token' },
        payload: {
          subjectUri: TEST_TOPIC_URI,
          subjectCid: TEST_TOPIC_CID,
          direction: 'up',
        },
      })

      expect(response.statusCode).toBe(409)
    })

    it('returns 502 when PDS write fails', async () => {
      // 0. Onboarding gate: no mandatory fields
      selectChain.where.mockResolvedValueOnce([])
      selectChain.where.mockResolvedValueOnce([{ uri: TEST_TOPIC_URI }])
      createRecordFn.mockRejectedValueOnce(new Error('PDS unreachable'))

      const response = await app.inject({
        method: 'POST',
        url: '/api/votes',
        headers: { authorization: 'Bearer test-token' },
        payload: {
          subjectUri: TEST_TOPIC_URI,
          subjectCid: TEST_TOPIC_CID,
          direction: 'up',
        },
      })

      expect(response.statusCode).toBe(502)
    })
  })

  describe('POST /api/votes (unauthenticated)', () => {
    let app: FastifyInstance

    beforeAll(async () => {
      app = await buildTestApp(undefined)
    })

    afterAll(async () => {
      await app.close()
    })

    it('returns 401 without auth', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/votes',
        payload: {
          subjectUri: TEST_TOPIC_URI,
          subjectCid: TEST_TOPIC_CID,
          direction: 'up',
        },
      })

      expect(response.statusCode).toBe(401)
    })
  })

  // =========================================================================
  // DELETE /api/votes/:uri
  // =========================================================================

  describe('DELETE /api/votes/:uri', () => {
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

    it('deletes a vote when user is the author', async () => {
      const existingVote = sampleVoteRow()
      selectChain.where.mockResolvedValueOnce([existingVote])

      const encodedUri = encodeURIComponent(TEST_VOTE_URI)
      const response = await app.inject({
        method: 'DELETE',
        url: `/api/votes/${encodedUri}`,
        headers: { authorization: 'Bearer test-token' },
      })

      expect(response.statusCode).toBe(204)

      // Should have deleted from PDS
      expect(deleteRecordFn).toHaveBeenCalledOnce()
      expect(deleteRecordFn.mock.calls[0]?.[0]).toBe(TEST_DID)
      expect(deleteRecordFn.mock.calls[0]?.[1]).toBe('forum.barazo.interaction.vote')
      expect(deleteRecordFn.mock.calls[0]?.[2]).toBe('vote123')

      // Should have used transaction for DB delete + count decrement
      expect(mockDb.transaction).toHaveBeenCalledOnce()
      expect(mockDb.delete).toHaveBeenCalled()
      expect(mockDb.update).toHaveBeenCalled()
    })

    it('decrements vote count on the subject topic', async () => {
      const existingVote = sampleVoteRow({
        subjectUri: TEST_TOPIC_URI,
      })
      selectChain.where.mockResolvedValueOnce([existingVote])

      const encodedUri = encodeURIComponent(TEST_VOTE_URI)
      const response = await app.inject({
        method: 'DELETE',
        url: `/api/votes/${encodedUri}`,
        headers: { authorization: 'Bearer test-token' },
      })

      expect(response.statusCode).toBe(204)
      expect(mockDb.update).toHaveBeenCalled()
    })

    it('decrements vote count on the subject reply', async () => {
      const existingVote = sampleVoteRow({
        subjectUri: TEST_REPLY_URI,
      })
      selectChain.where.mockResolvedValueOnce([existingVote])

      const encodedUri = encodeURIComponent(TEST_VOTE_URI)
      const response = await app.inject({
        method: 'DELETE',
        url: `/api/votes/${encodedUri}`,
        headers: { authorization: 'Bearer test-token' },
      })

      expect(response.statusCode).toBe(204)
      expect(mockDb.update).toHaveBeenCalled()
    })

    it('returns 403 when user is not the author', async () => {
      const existingVote = sampleVoteRow({ authorDid: OTHER_DID })
      selectChain.where.mockResolvedValueOnce([existingVote])

      const encodedUri = encodeURIComponent(TEST_VOTE_URI)
      const response = await app.inject({
        method: 'DELETE',
        url: `/api/votes/${encodedUri}`,
        headers: { authorization: 'Bearer test-token' },
      })

      expect(response.statusCode).toBe(403)
    })

    it('returns 404 when vote does not exist', async () => {
      selectChain.where.mockResolvedValueOnce([])

      const encodedUri = encodeURIComponent(
        'at://did:plc:nobody/forum.barazo.interaction.vote/ghost'
      )
      const response = await app.inject({
        method: 'DELETE',
        url: `/api/votes/${encodedUri}`,
        headers: { authorization: 'Bearer test-token' },
      })

      expect(response.statusCode).toBe(404)
    })

    it('returns 502 when PDS delete fails', async () => {
      const existingVote = sampleVoteRow()
      selectChain.where.mockResolvedValueOnce([existingVote])
      deleteRecordFn.mockRejectedValueOnce(new Error('PDS delete failed'))

      const encodedUri = encodeURIComponent(TEST_VOTE_URI)
      const response = await app.inject({
        method: 'DELETE',
        url: `/api/votes/${encodedUri}`,
        headers: { authorization: 'Bearer test-token' },
      })

      expect(response.statusCode).toBe(502)
    })
  })

  describe('DELETE /api/votes/:uri (unauthenticated)', () => {
    let app: FastifyInstance

    beforeAll(async () => {
      app = await buildTestApp(undefined)
    })

    afterAll(async () => {
      await app.close()
    })

    it('returns 401 without auth', async () => {
      const encodedUri = encodeURIComponent(TEST_VOTE_URI)
      const response = await app.inject({
        method: 'DELETE',
        url: `/api/votes/${encodedUri}`,
        headers: {},
      })

      expect(response.statusCode).toBe(401)
    })
  })

  // =========================================================================
  // GET /api/votes/status
  // =========================================================================

  describe('GET /api/votes/status', () => {
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

    it('returns voted=true when user has voted', async () => {
      selectChain.where.mockResolvedValueOnce([
        {
          uri: TEST_VOTE_URI,
          direction: 'up',
          createdAt: new Date(TEST_NOW),
        },
      ])

      const response = await app.inject({
        method: 'GET',
        url: `/api/votes/status?subjectUri=${encodeURIComponent(TEST_TOPIC_URI)}&did=${encodeURIComponent(TEST_DID)}`,
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{
        voted: boolean
        vote: { uri: string; direction: string; createdAt: string } | null
      }>()
      expect(body.voted).toBe(true)
      expect(body.vote).not.toBeNull()
      expect(body.vote?.uri).toBe(TEST_VOTE_URI)
      expect(body.vote?.direction).toBe('up')
      expect(body.vote?.createdAt).toBe(TEST_NOW)
    })

    it('returns voted=false when user has not voted', async () => {
      selectChain.where.mockResolvedValueOnce([])

      const response = await app.inject({
        method: 'GET',
        url: `/api/votes/status?subjectUri=${encodeURIComponent(TEST_TOPIC_URI)}&did=${encodeURIComponent(TEST_DID)}`,
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{ voted: boolean; vote: null }>()
      expect(body.voted).toBe(false)
      expect(body.vote).toBeNull()
    })

    it('returns 400 for missing subjectUri', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/votes/status?did=${encodeURIComponent(TEST_DID)}`,
      })

      expect(response.statusCode).toBe(400)
    })

    it('returns 400 for missing did', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/votes/status?subjectUri=${encodeURIComponent(TEST_TOPIC_URI)}`,
      })

      expect(response.statusCode).toBe(400)
    })

    it('works without authentication (public endpoint)', async () => {
      const noAuthApp = await buildTestApp(undefined)
      selectChain.where.mockResolvedValueOnce([])

      const response = await noAuthApp.inject({
        method: 'GET',
        url: `/api/votes/status?subjectUri=${encodeURIComponent(TEST_TOPIC_URI)}&did=${encodeURIComponent(TEST_DID)}`,
      })

      expect(response.statusCode).toBe(200)
      await noAuthApp.close()
    })
  })
})
