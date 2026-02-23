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
import { reactionRoutes } from '../../../src/routes/reactions.js'

// ---------------------------------------------------------------------------
// Mock env (minimal subset for reaction routes)
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

const TEST_REACTION_URI = `at://${TEST_DID}/forum.barazo.interaction.reaction/react123`
const TEST_REACTION_CID = 'bafyreireact123'
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

function sampleReactionRow(overrides?: Record<string, unknown>) {
  return {
    uri: TEST_REACTION_URI,
    rkey: 'react123',
    authorDid: TEST_DID,
    subjectUri: TEST_TOPIC_URI,
    subjectCid: TEST_TOPIC_CID,
    type: 'like',
    communityDid: COMMUNITY_DID,
    cid: TEST_REACTION_CID,
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
  app.decorate('interactionGraphService', {
    recordReply: vi.fn().mockResolvedValue(undefined),
    recordReaction: vi.fn().mockResolvedValue(undefined),
    recordCoParticipation: vi.fn().mockResolvedValue(undefined),
  } as never)
  app.decorateRequest('user', undefined as RequestUser | undefined)
  app.decorateRequest('communityDid', undefined as string | undefined)
  app.addHook('onRequest', async (request) => {
    request.communityDid = 'did:plc:test'
  })

  await app.register(reactionRoutes())
  await app.ready()

  return app
}

// ===========================================================================
// Test suite
// ===========================================================================

describe('reaction routes', () => {
  // =========================================================================
  // POST /api/reactions
  // =========================================================================

  describe('POST /api/reactions', () => {
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
      createRecordFn.mockResolvedValue({ uri: TEST_REACTION_URI, cid: TEST_REACTION_CID })
      isTrackedFn.mockResolvedValue(true)
    })

    it('creates a reaction on a topic and returns 201', async () => {
      // 0. Onboarding gate: no mandatory fields
      selectChain.where.mockResolvedValueOnce([])
      // 1. Community settings query -> reactionSet includes "like"
      selectChain.where.mockResolvedValueOnce([{ reactionSet: ['like', 'heart'] }])
      // 2. Subject existence check -> topic found
      selectChain.where.mockResolvedValueOnce([{ uri: TEST_TOPIC_URI }])
      // 3. Insert returning
      insertChain.returning.mockResolvedValueOnce([sampleReactionRow()])

      const response = await app.inject({
        method: 'POST',
        url: '/api/reactions',
        headers: { authorization: 'Bearer test-token' },
        payload: {
          subjectUri: TEST_TOPIC_URI,
          subjectCid: TEST_TOPIC_CID,
          type: 'like',
        },
      })

      expect(response.statusCode).toBe(201)
      const body = response.json<{
        uri: string
        cid: string
        rkey: string
        type: string
        subjectUri: string
      }>()
      expect(body.uri).toBe(TEST_REACTION_URI)
      expect(body.cid).toBe(TEST_REACTION_CID)
      expect(body.type).toBe('like')
      expect(body.subjectUri).toBe(TEST_TOPIC_URI)

      // Should have called PDS createRecord
      expect(createRecordFn).toHaveBeenCalledOnce()
      expect(createRecordFn.mock.calls[0]?.[0]).toBe(TEST_DID)
      expect(createRecordFn.mock.calls[0]?.[1]).toBe('forum.barazo.interaction.reaction')

      // Should have inserted into DB
      expect(mockDb.insert).toHaveBeenCalledOnce()
      // Should have incremented reaction count
      expect(mockDb.update).toHaveBeenCalledOnce()
    })

    it('creates a reaction on a reply and returns 201', async () => {
      // 0. Onboarding gate: no mandatory fields
      selectChain.where.mockResolvedValueOnce([])
      // 1. Community settings
      selectChain.where.mockResolvedValueOnce([{ reactionSet: ['like'] }])
      // 2. Subject existence check -> reply found
      selectChain.where.mockResolvedValueOnce([{ uri: TEST_REPLY_URI }])
      // 3. Insert returning
      const replyReaction = sampleReactionRow({
        subjectUri: TEST_REPLY_URI,
        subjectCid: TEST_REPLY_CID,
      })
      insertChain.returning.mockResolvedValueOnce([replyReaction])

      const response = await app.inject({
        method: 'POST',
        url: '/api/reactions',
        headers: { authorization: 'Bearer test-token' },
        payload: {
          subjectUri: TEST_REPLY_URI,
          subjectCid: TEST_REPLY_CID,
          type: 'like',
        },
      })

      expect(response.statusCode).toBe(201)
      const body = response.json<{ subjectUri: string }>()
      expect(body.subjectUri).toBe(TEST_REPLY_URI)
    })

    it("tracks new user's repo on first reaction", async () => {
      isTrackedFn.mockResolvedValue(false)
      trackRepoFn.mockResolvedValue(undefined)

      // 0. Onboarding gate: no mandatory fields
      selectChain.where.mockResolvedValueOnce([])
      selectChain.where.mockResolvedValueOnce([{ reactionSet: ['like'] }])
      selectChain.where.mockResolvedValueOnce([{ uri: TEST_TOPIC_URI }])
      insertChain.returning.mockResolvedValueOnce([sampleReactionRow()])

      const response = await app.inject({
        method: 'POST',
        url: '/api/reactions',
        headers: { authorization: 'Bearer test-token' },
        payload: {
          subjectUri: TEST_TOPIC_URI,
          subjectCid: TEST_TOPIC_CID,
          type: 'like',
        },
      })

      expect(response.statusCode).toBe(201)
      expect(isTrackedFn).toHaveBeenCalledWith(TEST_DID)
      expect(trackRepoFn).toHaveBeenCalledWith(TEST_DID)
    })

    it('returns 400 for missing subjectUri', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/reactions',
        headers: { authorization: 'Bearer test-token' },
        payload: {
          subjectCid: TEST_TOPIC_CID,
          type: 'like',
        },
      })

      expect(response.statusCode).toBe(400)
    })

    it('returns 400 for missing subjectCid', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/reactions',
        headers: { authorization: 'Bearer test-token' },
        payload: {
          subjectUri: TEST_TOPIC_URI,
          type: 'like',
        },
      })

      expect(response.statusCode).toBe(400)
    })

    it('returns 400 for missing type', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/reactions',
        headers: { authorization: 'Bearer test-token' },
        payload: {
          subjectUri: TEST_TOPIC_URI,
          subjectCid: TEST_TOPIC_CID,
        },
      })

      expect(response.statusCode).toBe(400)
    })

    it('returns 400 for type exceeding max length', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/reactions',
        headers: { authorization: 'Bearer test-token' },
        payload: {
          subjectUri: TEST_TOPIC_URI,
          subjectCid: TEST_TOPIC_CID,
          type: 'a'.repeat(31),
        },
      })

      expect(response.statusCode).toBe(400)
    })

    it('returns 400 for empty body', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/reactions',
        headers: { authorization: 'Bearer test-token' },
        payload: {},
      })

      expect(response.statusCode).toBe(400)
    })

    it("returns 400 when reaction type is not in community's reaction set", async () => {
      // 0. Onboarding gate: no mandatory fields
      selectChain.where.mockResolvedValueOnce([])
      // Community only allows "like"
      selectChain.where.mockResolvedValueOnce([{ reactionSet: ['like'] }])

      const response = await app.inject({
        method: 'POST',
        url: '/api/reactions',
        headers: { authorization: 'Bearer test-token' },
        payload: {
          subjectUri: TEST_TOPIC_URI,
          subjectCid: TEST_TOPIC_CID,
          type: 'heart',
        },
      })

      expect(response.statusCode).toBe(400)
    })

    it("uses default reaction set ['like'] when no settings exist", async () => {
      // 0. Onboarding gate: no mandatory fields
      selectChain.where.mockResolvedValueOnce([])
      // No settings row found
      selectChain.where.mockResolvedValueOnce([])
      // Subject exists
      selectChain.where.mockResolvedValueOnce([{ uri: TEST_TOPIC_URI }])
      insertChain.returning.mockResolvedValueOnce([sampleReactionRow()])

      const response = await app.inject({
        method: 'POST',
        url: '/api/reactions',
        headers: { authorization: 'Bearer test-token' },
        payload: {
          subjectUri: TEST_TOPIC_URI,
          subjectCid: TEST_TOPIC_CID,
          type: 'like',
        },
      })

      expect(response.statusCode).toBe(201)
    })

    it('returns 404 when subject does not exist', async () => {
      // 0. Onboarding gate: no mandatory fields
      selectChain.where.mockResolvedValueOnce([])
      selectChain.where.mockResolvedValueOnce([{ reactionSet: ['like'] }])
      // Subject not found
      selectChain.where.mockResolvedValueOnce([])

      const response = await app.inject({
        method: 'POST',
        url: '/api/reactions',
        headers: { authorization: 'Bearer test-token' },
        payload: {
          subjectUri: TEST_TOPIC_URI,
          subjectCid: TEST_TOPIC_CID,
          type: 'like',
        },
      })

      expect(response.statusCode).toBe(404)
    })

    it('returns 404 when subject URI has unknown collection', async () => {
      // 0. Onboarding gate: no mandatory fields
      selectChain.where.mockResolvedValueOnce([])
      selectChain.where.mockResolvedValueOnce([{ reactionSet: ['like'] }])
      // Unknown collection -> subjectExists stays false

      const response = await app.inject({
        method: 'POST',
        url: '/api/reactions',
        headers: { authorization: 'Bearer test-token' },
        payload: {
          subjectUri: `at://${OTHER_DID}/some.unknown.collection/xyz123`,
          subjectCid: 'bafyreixyz',
          type: 'like',
        },
      })

      expect(response.statusCode).toBe(404)
    })

    it('returns 409 when duplicate reaction (unique constraint)', async () => {
      // 0. Onboarding gate: no mandatory fields
      selectChain.where.mockResolvedValueOnce([])
      selectChain.where.mockResolvedValueOnce([{ reactionSet: ['like'] }])
      selectChain.where.mockResolvedValueOnce([{ uri: TEST_TOPIC_URI }])
      // onConflictDoNothing -> returning() returns empty array
      insertChain.returning.mockResolvedValueOnce([])

      const response = await app.inject({
        method: 'POST',
        url: '/api/reactions',
        headers: { authorization: 'Bearer test-token' },
        payload: {
          subjectUri: TEST_TOPIC_URI,
          subjectCid: TEST_TOPIC_CID,
          type: 'like',
        },
      })

      expect(response.statusCode).toBe(409)
    })

    it('returns 502 when PDS write fails', async () => {
      // 0. Onboarding gate: no mandatory fields
      selectChain.where.mockResolvedValueOnce([])
      selectChain.where.mockResolvedValueOnce([{ reactionSet: ['like'] }])
      selectChain.where.mockResolvedValueOnce([{ uri: TEST_TOPIC_URI }])
      createRecordFn.mockRejectedValueOnce(new Error('PDS unreachable'))

      const response = await app.inject({
        method: 'POST',
        url: '/api/reactions',
        headers: { authorization: 'Bearer test-token' },
        payload: {
          subjectUri: TEST_TOPIC_URI,
          subjectCid: TEST_TOPIC_CID,
          type: 'like',
        },
      })

      expect(response.statusCode).toBe(502)
    })
  })

  describe('POST /api/reactions (unauthenticated)', () => {
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
        url: '/api/reactions',
        payload: {
          subjectUri: TEST_TOPIC_URI,
          subjectCid: TEST_TOPIC_CID,
          type: 'like',
        },
      })

      expect(response.statusCode).toBe(401)
    })
  })

  // =========================================================================
  // DELETE /api/reactions/:uri
  // =========================================================================

  describe('DELETE /api/reactions/:uri', () => {
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

    it('deletes a reaction when user is the author (deletes from PDS + DB)', async () => {
      const existingReaction = sampleReactionRow()
      selectChain.where.mockResolvedValueOnce([existingReaction])

      const encodedUri = encodeURIComponent(TEST_REACTION_URI)
      const response = await app.inject({
        method: 'DELETE',
        url: `/api/reactions/${encodedUri}`,
        headers: { authorization: 'Bearer test-token' },
      })

      expect(response.statusCode).toBe(204)

      // Should have deleted from PDS
      expect(deleteRecordFn).toHaveBeenCalledOnce()
      expect(deleteRecordFn.mock.calls[0]?.[0]).toBe(TEST_DID)
      expect(deleteRecordFn.mock.calls[0]?.[1]).toBe('forum.barazo.interaction.reaction')
      expect(deleteRecordFn.mock.calls[0]?.[2]).toBe('react123')

      // Should have used transaction for DB delete + count decrement
      expect(mockDb.transaction).toHaveBeenCalledOnce()
      expect(mockDb.delete).toHaveBeenCalled()
      expect(mockDb.update).toHaveBeenCalled()
    })

    it('decrements reaction count on the subject topic', async () => {
      const existingReaction = sampleReactionRow({
        subjectUri: TEST_TOPIC_URI,
      })
      selectChain.where.mockResolvedValueOnce([existingReaction])

      const encodedUri = encodeURIComponent(TEST_REACTION_URI)
      const response = await app.inject({
        method: 'DELETE',
        url: `/api/reactions/${encodedUri}`,
        headers: { authorization: 'Bearer test-token' },
      })

      expect(response.statusCode).toBe(204)
      expect(mockDb.update).toHaveBeenCalled()
    })

    it('decrements reaction count on the subject reply', async () => {
      const existingReaction = sampleReactionRow({
        subjectUri: TEST_REPLY_URI,
      })
      selectChain.where.mockResolvedValueOnce([existingReaction])

      const encodedUri = encodeURIComponent(TEST_REACTION_URI)
      const response = await app.inject({
        method: 'DELETE',
        url: `/api/reactions/${encodedUri}`,
        headers: { authorization: 'Bearer test-token' },
      })

      expect(response.statusCode).toBe(204)
      expect(mockDb.update).toHaveBeenCalled()
    })

    it('returns 403 when user is not the author', async () => {
      const existingReaction = sampleReactionRow({ authorDid: OTHER_DID })
      selectChain.where.mockResolvedValueOnce([existingReaction])

      const encodedUri = encodeURIComponent(TEST_REACTION_URI)
      const response = await app.inject({
        method: 'DELETE',
        url: `/api/reactions/${encodedUri}`,
        headers: { authorization: 'Bearer test-token' },
      })

      expect(response.statusCode).toBe(403)
    })

    it('returns 404 when reaction does not exist', async () => {
      selectChain.where.mockResolvedValueOnce([])

      const encodedUri = encodeURIComponent(
        'at://did:plc:nobody/forum.barazo.interaction.reaction/ghost'
      )
      const response = await app.inject({
        method: 'DELETE',
        url: `/api/reactions/${encodedUri}`,
        headers: { authorization: 'Bearer test-token' },
      })

      expect(response.statusCode).toBe(404)
    })

    it('returns 502 when PDS delete fails', async () => {
      const existingReaction = sampleReactionRow()
      selectChain.where.mockResolvedValueOnce([existingReaction])
      deleteRecordFn.mockRejectedValueOnce(new Error('PDS delete failed'))

      const encodedUri = encodeURIComponent(TEST_REACTION_URI)
      const response = await app.inject({
        method: 'DELETE',
        url: `/api/reactions/${encodedUri}`,
        headers: { authorization: 'Bearer test-token' },
      })

      expect(response.statusCode).toBe(502)
    })
  })

  describe('DELETE /api/reactions/:uri (unauthenticated)', () => {
    let app: FastifyInstance

    beforeAll(async () => {
      app = await buildTestApp(undefined)
    })

    afterAll(async () => {
      await app.close()
    })

    it('returns 401 without auth', async () => {
      const encodedUri = encodeURIComponent(TEST_REACTION_URI)
      const response = await app.inject({
        method: 'DELETE',
        url: `/api/reactions/${encodedUri}`,
        headers: {},
      })

      expect(response.statusCode).toBe(401)
    })
  })

  // =========================================================================
  // GET /api/reactions
  // =========================================================================

  describe('GET /api/reactions', () => {
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

    it('returns empty list when no reactions exist', async () => {
      selectChain.limit.mockResolvedValueOnce([])

      const response = await app.inject({
        method: 'GET',
        url: `/api/reactions?subjectUri=${encodeURIComponent(TEST_TOPIC_URI)}`,
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{ reactions: unknown[]; cursor: string | null }>()
      expect(body.reactions).toEqual([])
      expect(body.cursor).toBeNull()
    })

    it('returns reactions with pagination cursor', async () => {
      const rows = [
        sampleReactionRow(),
        sampleReactionRow({
          uri: `at://${TEST_DID}/forum.barazo.interaction.reaction/react456`,
          rkey: 'react456',
          type: 'heart',
        }),
        sampleReactionRow({
          uri: `at://${TEST_DID}/forum.barazo.interaction.reaction/react789`,
          rkey: 'react789',
        }),
      ]
      selectChain.limit.mockResolvedValueOnce(rows)

      const response = await app.inject({
        method: 'GET',
        url: `/api/reactions?subjectUri=${encodeURIComponent(TEST_TOPIC_URI)}&limit=2`,
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{ reactions: unknown[]; cursor: string | null }>()
      expect(body.reactions).toHaveLength(2)
      expect(body.cursor).toBeTruthy()
    })

    it('returns null cursor when fewer items than limit', async () => {
      const rows = [sampleReactionRow()]
      selectChain.limit.mockResolvedValueOnce(rows)

      const response = await app.inject({
        method: 'GET',
        url: `/api/reactions?subjectUri=${encodeURIComponent(TEST_TOPIC_URI)}&limit=25`,
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{ reactions: unknown[]; cursor: string | null }>()
      expect(body.reactions).toHaveLength(1)
      expect(body.cursor).toBeNull()
    })

    it('filters by type', async () => {
      selectChain.limit.mockResolvedValueOnce([])

      const response = await app.inject({
        method: 'GET',
        url: `/api/reactions?subjectUri=${encodeURIComponent(TEST_TOPIC_URI)}&type=heart`,
      })

      expect(response.statusCode).toBe(200)
      // The type filter should be part of the WHERE clause
      expect(selectChain.where).toHaveBeenCalled()
    })

    it('accepts cursor parameter', async () => {
      const cursor = Buffer.from(
        JSON.stringify({ createdAt: TEST_NOW, uri: TEST_REACTION_URI })
      ).toString('base64')
      selectChain.limit.mockResolvedValueOnce([])

      const response = await app.inject({
        method: 'GET',
        url: `/api/reactions?subjectUri=${encodeURIComponent(TEST_TOPIC_URI)}&cursor=${encodeURIComponent(cursor)}`,
      })

      expect(response.statusCode).toBe(200)
    })

    it('returns 400 for missing subjectUri', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/reactions',
      })

      expect(response.statusCode).toBe(400)
    })

    it('returns 400 for invalid limit (over max)', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/reactions?subjectUri=${encodeURIComponent(TEST_TOPIC_URI)}&limit=999`,
      })

      expect(response.statusCode).toBe(400)
    })

    it('returns 400 for invalid limit (zero)', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/reactions?subjectUri=${encodeURIComponent(TEST_TOPIC_URI)}&limit=0`,
      })

      expect(response.statusCode).toBe(400)
    })

    it('returns 400 for non-numeric limit', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/reactions?subjectUri=${encodeURIComponent(TEST_TOPIC_URI)}&limit=abc`,
      })

      expect(response.statusCode).toBe(400)
    })

    it('works without authentication (public endpoint)', async () => {
      const noAuthApp = await buildTestApp(undefined)
      selectChain.limit.mockResolvedValueOnce([])

      const response = await noAuthApp.inject({
        method: 'GET',
        url: `/api/reactions?subjectUri=${encodeURIComponent(TEST_TOPIC_URI)}`,
      })

      expect(response.statusCode).toBe(200)
      await noAuthApp.close()
    })

    it('respects custom limit', async () => {
      selectChain.limit.mockResolvedValueOnce([])

      const response = await app.inject({
        method: 'GET',
        url: `/api/reactions?subjectUri=${encodeURIComponent(TEST_TOPIC_URI)}&limit=5`,
      })

      expect(response.statusCode).toBe(200)
      expect(selectChain.limit).toHaveBeenCalled()
    })

    it('serializes reaction dates as ISO strings', async () => {
      const rows = [sampleReactionRow()]
      selectChain.limit.mockResolvedValueOnce(rows)

      const response = await app.inject({
        method: 'GET',
        url: `/api/reactions?subjectUri=${encodeURIComponent(TEST_TOPIC_URI)}`,
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{
        reactions: Array<{ createdAt: string; uri: string; type: string }>
      }>()
      expect(body.reactions[0]?.createdAt).toBe(TEST_NOW)
      expect(body.reactions[0]?.uri).toBe(TEST_REACTION_URI)
      expect(body.reactions[0]?.type).toBe('like')
    })
  })
})
