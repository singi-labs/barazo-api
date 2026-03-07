import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest'
import Fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import type { Env } from '../../../src/config/env.js'
import type { AuthMiddleware, RequestUser } from '../../../src/auth/middleware.js'
import type { SessionService } from '../../../src/auth/session.js'
import type { SetupService } from '../../../src/setup/service.js'
import { type DbChain, createMockDb, resetDbMocks } from '../../helpers/mock-db.js'

// ---------------------------------------------------------------------------
// Mock PDS client module (must be before importing routes)
// ---------------------------------------------------------------------------

vi.mock('../../../src/lib/pds-client.js', () => ({
  createPdsClient: () => ({
    createRecord: vi.fn(),
    updateRecord: vi.fn(),
    deleteRecord: vi.fn(),
  }),
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
const TEST_NOW = '2026-02-13T12:00:00.000Z'

function testUser(overrides?: Partial<RequestUser>): RequestUser {
  return { did: TEST_DID, handle: TEST_HANDLE, sid: TEST_SID, ...overrides }
}

// ---------------------------------------------------------------------------
// Chainable mock DB (shared helper)
// ---------------------------------------------------------------------------

const mockDb = createMockDb()
let selectChain: DbChain

function resetAllDbMocks(): void {
  selectChain = resetDbMocks(mockDb)
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
      if (user) request.user = user
      return Promise.resolve()
    },
  }
}

// ---------------------------------------------------------------------------
// Mock firehose
// ---------------------------------------------------------------------------

const mockFirehose = {
  getRepoManager: () => ({
    isTracked: vi.fn().mockResolvedValue(true),
    trackRepo: vi.fn(),
    untrackRepo: vi.fn(),
    restoreTrackedRepos: vi.fn(),
  }),
  start: vi.fn(),
  stop: vi.fn(),
  getStatus: vi.fn().mockReturnValue({ connected: true, lastEventId: null }),
}

// ---------------------------------------------------------------------------
// Sample rows
// ---------------------------------------------------------------------------

function sampleTopicRow(overrides?: Record<string, unknown>) {
  return {
    uri: `at://${TEST_DID}/forum.barazo.topic.post/abc123`,
    rkey: 'abc123',
    authorDid: TEST_DID,
    title: 'Test Topic',
    content: 'Content here',
    category: 'general',
    tags: [],
    communityDid: 'did:plc:community123',
    cid: 'bafyreiabc',
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
    uri: `at://${TEST_DID}/forum.barazo.topic.reply/reply001`,
    rkey: 'reply001',
    authorDid: TEST_DID,
    content: 'A reply',
    rootUri: `at://${TEST_DID}/forum.barazo.topic.post/abc123`,
    rootCid: 'bafyreiabc',
    parentUri: `at://${TEST_DID}/forum.barazo.topic.post/abc123`,
    parentCid: 'bafyreiabc',
    communityDid: 'did:plc:community123',
    cid: 'bafyreireply',
    reactionCount: 0,
    createdAt: new Date(TEST_NOW),
    indexedAt: new Date(TEST_NOW),
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Helpers
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
  app.addHook('onRequest', (request, _reply, done) => {
    request.communityDid = 'did:plc:test'
    done()
  })

  await app.register(topicRoutes())
  await app.register(replyRoutes())
  await app.ready()

  return app
}

// ===========================================================================
// Test suite: Maturity Filtering
// ===========================================================================

describe('maturity filtering', () => {
  // =========================================================================
  // GET /api/topics - maturity filtering on list
  // =========================================================================

  describe('GET /api/topics maturity filtering', () => {
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

    it('filters topics to safe-only categories for unauthenticated users', async () => {
      const noAuthApp = await buildTestApp(undefined)

      // No user profile query (unauthenticated)
      // Community settings: ageThreshold
      selectChain.where.mockResolvedValueOnce([{ ageThreshold: 16 }])
      // Categories query: return only safe categories
      selectChain.where.mockResolvedValueOnce([{ slug: 'general' }])
      // Topics query
      selectChain.limit.mockResolvedValueOnce([sampleTopicRow({ category: 'general' })])

      const response = await noAuthApp.inject({
        method: 'GET',
        url: '/api/topics',
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{ topics: Array<{ category: string }> }>()
      expect(body.topics).toHaveLength(1)
      expect(body.topics[0]?.category).toBe('general')

      await noAuthApp.close()
    })

    it('filters topics to safe-only when user has no age declaration', async () => {
      // User profile: no declaredAge → maxMaturity = "safe"
      selectChain.where.mockResolvedValueOnce([{ declaredAge: null, maturityPref: 'mature' }])
      // Community settings: ageThreshold
      selectChain.where.mockResolvedValueOnce([{ ageThreshold: 16 }])
      // Categories: only safe categories returned (DB would filter)
      selectChain.where.mockResolvedValueOnce([{ slug: 'general' }])
      // Topics
      selectChain.limit.mockResolvedValueOnce([sampleTopicRow()])

      const response = await app.inject({
        method: 'GET',
        url: '/api/topics',
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{ topics: unknown[] }>()
      expect(body.topics).toHaveLength(1)
    })

    it('includes mature categories when user has age declared and maturityPref=mature', async () => {
      // User profile: age declared, maturityPref = "mature"
      selectChain.where.mockResolvedValueOnce([{ declaredAge: 18, maturityPref: 'mature' }])
      // Community settings: ageThreshold
      selectChain.where.mockResolvedValueOnce([{ ageThreshold: 16 }])
      // Categories: both safe and mature categories
      selectChain.where.mockResolvedValueOnce([{ slug: 'general' }, { slug: 'mature-talk' }])
      // Topics from both categories
      selectChain.limit.mockResolvedValueOnce([
        sampleTopicRow({ category: 'general' }),
        sampleTopicRow({
          category: 'mature-talk',
          uri: `at://${TEST_DID}/forum.barazo.topic.post/def456`,
          rkey: 'def456',
        }),
      ])

      const response = await app.inject({
        method: 'GET',
        url: '/api/topics',
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{ topics: Array<{ category: string }> }>()
      expect(body.topics).toHaveLength(2)
    })

    it('returns empty when no categories match allowed maturity', async () => {
      // User profile: age not declared
      selectChain.where.mockResolvedValueOnce([{ declaredAge: null, maturityPref: 'safe' }])
      // Community settings: ageThreshold
      selectChain.where.mockResolvedValueOnce([{ ageThreshold: 16 }])
      // Categories: no safe categories exist
      selectChain.where.mockResolvedValueOnce([])

      const response = await app.inject({
        method: 'GET',
        url: '/api/topics',
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{ topics: unknown[]; cursor: string | null }>()
      expect(body.topics).toEqual([])
      expect(body.cursor).toBeNull()
    })
  })

  // =========================================================================
  // GET /api/topics/:topicUri/replies - maturity check
  // =========================================================================

  describe('GET /api/topics/:topicUri/replies maturity check', () => {
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

    it('allows replies when topic category is within user maturity level', async () => {
      const topicUri = `at://${TEST_DID}/forum.barazo.topic.post/abc123`

      // Topic lookup
      selectChain.where.mockResolvedValueOnce([sampleTopicRow()])
      // Category maturity lookup: safe
      selectChain.where.mockResolvedValueOnce([{ maturityRating: 'safe' }])
      // User profile: safe maturity
      selectChain.where.mockResolvedValueOnce([{ declaredAge: null, maturityPref: 'safe' }])
      // Community settings: ageThreshold
      selectChain.where.mockResolvedValueOnce([{ ageThreshold: 16 }])
      // Replies query
      selectChain.limit.mockResolvedValueOnce([sampleReplyRow()])

      const response = await app.inject({
        method: 'GET',
        url: `/api/topics/${encodeURIComponent(topicUri)}/replies`,
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{ replies: unknown[] }>()
      expect(body.replies).toHaveLength(1)
    })

    it('returns 403 when topic category exceeds user maturity level', async () => {
      const topicUri = `at://${TEST_DID}/forum.barazo.topic.post/abc123`

      // Topic lookup
      selectChain.where.mockResolvedValueOnce([sampleTopicRow({ category: 'adult-stuff' })])
      // Category maturity lookup: adult
      selectChain.where.mockResolvedValueOnce([{ maturityRating: 'adult' }])
      // User profile: safe maturity (no age declared)
      selectChain.where.mockResolvedValueOnce([{ declaredAge: null, maturityPref: 'safe' }])
      // Community settings: ageThreshold
      selectChain.where.mockResolvedValueOnce([{ ageThreshold: 16 }])

      const response = await app.inject({
        method: 'GET',
        url: `/api/topics/${encodeURIComponent(topicUri)}/replies`,
      })

      expect(response.statusCode).toBe(403)
    })

    it('allows mature content when user has declared age and maturityPref=mature', async () => {
      const topicUri = `at://${TEST_DID}/forum.barazo.topic.post/abc123`

      // Topic lookup
      selectChain.where.mockResolvedValueOnce([sampleTopicRow({ category: 'mature-talk' })])
      // Category maturity lookup: mature
      selectChain.where.mockResolvedValueOnce([{ maturityRating: 'mature' }])
      // User profile: age declared, mature pref
      selectChain.where.mockResolvedValueOnce([{ declaredAge: 18, maturityPref: 'mature' }])
      // Community settings: ageThreshold
      selectChain.where.mockResolvedValueOnce([{ ageThreshold: 16 }])
      // Replies query
      selectChain.limit.mockResolvedValueOnce([sampleReplyRow()])

      const response = await app.inject({
        method: 'GET',
        url: `/api/topics/${encodeURIComponent(topicUri)}/replies`,
      })

      expect(response.statusCode).toBe(200)
    })

    it('returns 403 for unauthenticated user on mature topic', async () => {
      const noAuthApp = await buildTestApp(undefined)
      const topicUri = `at://${TEST_DID}/forum.barazo.topic.post/abc123`

      // Topic lookup
      selectChain.where.mockResolvedValueOnce([sampleTopicRow({ category: 'mature-talk' })])
      // Category maturity lookup: mature
      selectChain.where.mockResolvedValueOnce([{ maturityRating: 'mature' }])
      // No user profile query (unauthenticated)
      // Community settings: ageThreshold
      selectChain.where.mockResolvedValueOnce([{ ageThreshold: 16 }])

      const response = await noAuthApp.inject({
        method: 'GET',
        url: `/api/topics/${encodeURIComponent(topicUri)}/replies`,
      })

      expect(response.statusCode).toBe(403)
      await noAuthApp.close()
    })

    it('defaults to safe when category not found', async () => {
      const topicUri = `at://${TEST_DID}/forum.barazo.topic.post/abc123`

      // Topic lookup
      selectChain.where.mockResolvedValueOnce([sampleTopicRow()])
      // Category not found: empty result → defaults to "safe"
      selectChain.where.mockResolvedValueOnce([])
      // User profile
      selectChain.where.mockResolvedValueOnce([{ declaredAge: null, maturityPref: 'safe' }])
      // Community settings: ageThreshold
      selectChain.where.mockResolvedValueOnce([{ ageThreshold: 16 }])
      // Replies query
      selectChain.limit.mockResolvedValueOnce([])

      const response = await app.inject({
        method: 'GET',
        url: `/api/topics/${encodeURIComponent(topicUri)}/replies`,
      })

      // safe <= safe → allowed
      expect(response.statusCode).toBe(200)
    })
  })
})
