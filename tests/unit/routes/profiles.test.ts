import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest'
import Fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import type { Env } from '../../../src/config/env.js'
import type { AuthMiddleware, RequestUser } from '../../../src/auth/middleware.js'
import type { SessionService } from '../../../src/auth/session.js'
import type { SetupService } from '../../../src/setup/service.js'
import { type DbChain, createChainableProxy, createMockDb } from '../../helpers/mock-db.js'

// Import routes
import { profileRoutes } from '../../../src/routes/profiles.js'

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
const COMMUNITY_DID = 'did:plc:community123'
const TEST_NOW = '2026-02-14T12:00:00.000Z'

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
// Sample data builders
// ---------------------------------------------------------------------------

function sampleUserRow(overrides?: Record<string, unknown>) {
  return {
    did: TEST_DID,
    handle: TEST_HANDLE,
    displayName: 'Jay',
    avatarUrl: 'https://example.com/avatar.jpg',
    bannerUrl: 'https://example.com/banner.jpg',
    bio: 'Hello, I am Jay',
    role: 'user',
    isBanned: false,
    reputationScore: 0,
    firstSeenAt: new Date(TEST_NOW),
    lastActiveAt: new Date(TEST_NOW),
    declaredAge: null,
    maturityPref: 'safe',
    accountCreatedAt: null,
    followersCount: 0,
    followsCount: 0,
    atprotoPostsCount: 0,
    hasBlueskyProfile: false,
    atprotoLabels: [],
    ...overrides,
  }
}

function samplePrefsRow(overrides?: Record<string, unknown>) {
  return {
    did: TEST_DID,
    maturityLevel: 'sfw',
    declaredAge: null,
    mutedWords: [],
    blockedDids: [],
    mutedDids: [],
    crossPostBluesky: false,
    crossPostFrontpage: false,
    updatedAt: new Date(TEST_NOW),
    ...overrides,
  }
}

function sampleCommunityPrefsRow(overrides?: Record<string, unknown>) {
  return {
    did: TEST_DID,
    communityDid: COMMUNITY_DID,
    maturityOverride: null,
    mutedWords: null,
    blockedDids: null,
    mutedDids: null,
    notificationPrefs: null,
    updatedAt: new Date(TEST_NOW),
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Chainable mock DB
// ---------------------------------------------------------------------------

const mockDb = createMockDb()

let selectChain: DbChain
let selectDistinctChain: DbChain
let insertChain: DbChain
let deleteChain: DbChain

function resetAllDbMocks(): void {
  selectChain = createChainableProxy([])
  selectDistinctChain = createChainableProxy([])
  insertChain = createChainableProxy()
  deleteChain = createChainableProxy()
  mockDb.insert.mockReturnValue(insertChain)
  mockDb.select.mockReturnValue(selectChain)
  mockDb.selectDistinct.mockReturnValue(selectDistinctChain)
  mockDb.update.mockReturnValue(createChainableProxy([]))
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
// Mock logger
// ---------------------------------------------------------------------------

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn().mockReturnThis(),
}

// ---------------------------------------------------------------------------
// Auth middleware variant that passes through without setting user
// (simulates a broken auth state where preHandler does not reject but user is unset)
// ---------------------------------------------------------------------------

function createPassthroughAuthMiddleware(): AuthMiddleware {
  return {
    requireAuth: async (_request, _reply) => {
      // Intentionally does NOT set request.user and does NOT send 401
      // This lets us exercise the defensive !requestUser guard inside handlers
    },
    optionalAuth: (_request, _reply) => Promise.resolve(),
  }
}

// ---------------------------------------------------------------------------
// Helper: build app with mocked deps
// ---------------------------------------------------------------------------

async function buildTestApp(
  user?: RequestUser,
  options?: { communityDid?: string }
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })

  app.decorate('db', mockDb as never)
  app.decorate('env', mockEnv)
  app.decorate('authMiddleware', createMockAuthMiddleware(user))
  app.decorate('firehose', {} as never)
  app.decorate('oauthClient', {} as never)
  app.decorate('sessionService', {} as SessionService)
  app.decorate('setupService', {} as SetupService)
  app.decorate('cache', {} as never)
  app.decorate('trustGraphService', {
    computeTrustScores: vi.fn().mockResolvedValue({
      totalNodes: 0,
      totalEdges: 0,
      iterations: 0,
      converged: true,
      durationMs: 0,
    }),
    getTrustScore: vi.fn().mockResolvedValue(1.0),
  } as never)
  app.decorateRequest('user', undefined as RequestUser | undefined)
  app.decorateRequest('communityDid', undefined as string | undefined)

  if (options?.communityDid) {
    app.addHook('onRequest', (request, _reply, done) => {
      request.communityDid = options.communityDid
      done()
    })
  }

  // Override the logger so we can capture log calls
  app.log.info = mockLogger.info
  app.log.warn = mockLogger.warn
  app.log.error = mockLogger.error

  await app.register(profileRoutes())
  await app.ready()

  return app
}

/**
 * Build an app where requireAuth passes through WITHOUT setting request.user.
 * This exercises the defensive `if (!requestUser)` guards inside handlers.
 */
async function buildPassthroughAuthApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })

  app.decorate('db', mockDb as never)
  app.decorate('env', mockEnv)
  app.decorate('authMiddleware', createPassthroughAuthMiddleware())
  app.decorate('firehose', {} as never)
  app.decorate('oauthClient', {} as never)
  app.decorate('sessionService', {} as SessionService)
  app.decorate('setupService', {} as SetupService)
  app.decorate('cache', {} as never)
  app.decorate('trustGraphService', {
    computeTrustScores: vi.fn().mockResolvedValue({
      totalNodes: 0,
      totalEdges: 0,
      iterations: 0,
      converged: true,
      durationMs: 0,
    }),
    getTrustScore: vi.fn().mockResolvedValue(1.0),
  } as never)
  app.decorateRequest('user', undefined as RequestUser | undefined)

  app.log.info = mockLogger.info
  app.log.warn = mockLogger.warn
  app.log.error = mockLogger.error

  await app.register(profileRoutes())
  await app.ready()

  return app
}

// ===========================================================================
// Test suite
// ===========================================================================

describe('profile routes', () => {
  // =========================================================================
  // GET /api/users/:handle
  // =========================================================================

  describe('GET /api/users/:handle', () => {
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

    it('returns profile with activity summary', async () => {
      // 1st select: user by handle
      selectChain.where.mockResolvedValueOnce([sampleUserRow()])
      // 2nd select: topic count
      selectChain.where.mockResolvedValueOnce([{ count: 5 }])
      // 3rd select: reply count
      selectChain.where.mockResolvedValueOnce([{ count: 10 }])
      // 4th select: reactions on topics
      selectChain.where.mockResolvedValueOnce([{ count: 3 }])
      // 5th select: reactions on replies
      selectChain.where.mockResolvedValueOnce([{ count: 2 }])
      // 6th select: votes on topics
      selectChain.where.mockResolvedValueOnce([{ count: 4 }])
      // 7th select: votes on replies
      selectChain.where.mockResolvedValueOnce([{ count: 1 }])
      // 8th selectDistinct: topic communities
      selectDistinctChain.where.mockResolvedValueOnce([{ communityDid: 'did:plc:comm1' }])
      // 9th selectDistinct: reply communities
      selectDistinctChain.where.mockResolvedValueOnce([])

      const response = await app.inject({
        method: 'GET',
        url: `/api/users/${TEST_HANDLE}`,
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{
        did: string
        handle: string
        displayName: string
        bannerUrl: string | null
        bio: string | null
        role: string
        followersCount: number
        followsCount: number
        atprotoPostsCount: number
        hasBlueskyProfile: boolean
        communityCount: number
        activity: {
          topicCount: number
          replyCount: number
          reactionsReceived: number
          votesReceived: number
        }
      }>()
      expect(body.did).toBe(TEST_DID)
      expect(body.handle).toBe(TEST_HANDLE)
      expect(body.displayName).toBe('Jay')
      expect(body.bannerUrl).toBe('https://example.com/banner.jpg')
      expect(body.bio).toBe('Hello, I am Jay')
      expect(body.role).toBe('user')
      expect(body.activity.topicCount).toBe(5)
      expect(body.activity.replyCount).toBe(10)
      expect(body.activity.reactionsReceived).toBe(5)
      expect(body.activity.votesReceived).toBe(5)
      expect(body.followersCount).toBe(0)
      expect(body.followsCount).toBe(0)
      expect(body.atprotoPostsCount).toBe(0)
      expect(body.hasBlueskyProfile).toBe(false)
      expect(body.communityCount).toBe(1)
    })

    it('includes accountCreatedAt when user has one', async () => {
      const accountCreatedAt = new Date('2024-06-15T10:30:00.000Z')
      selectChain.where.mockResolvedValueOnce([sampleUserRow({ accountCreatedAt })])
      // topic count, reply count, reactions on topics, reactions on replies, votes on topics, votes on replies
      selectChain.where.mockResolvedValueOnce([{ count: 0 }])
      selectChain.where.mockResolvedValueOnce([{ count: 0 }])
      selectChain.where.mockResolvedValueOnce([{ count: 0 }])
      selectChain.where.mockResolvedValueOnce([{ count: 0 }])
      selectChain.where.mockResolvedValueOnce([{ count: 0 }])
      selectChain.where.mockResolvedValueOnce([{ count: 0 }])
      // communityCount
      selectDistinctChain.where.mockResolvedValueOnce([])
      selectDistinctChain.where.mockResolvedValueOnce([])

      const response = await app.inject({
        method: 'GET',
        url: `/api/users/${TEST_HANDLE}`,
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{ accountCreatedAt: string | null }>()
      expect(body.accountCreatedAt).toBe('2024-06-15T10:30:00.000Z')
    })

    it('returns null accountCreatedAt when user has none', async () => {
      selectChain.where.mockResolvedValueOnce([sampleUserRow({ accountCreatedAt: null })])
      selectChain.where.mockResolvedValueOnce([{ count: 0 }])
      selectChain.where.mockResolvedValueOnce([{ count: 0 }])
      selectChain.where.mockResolvedValueOnce([{ count: 0 }])
      selectChain.where.mockResolvedValueOnce([{ count: 0 }])
      selectChain.where.mockResolvedValueOnce([{ count: 0 }])
      selectChain.where.mockResolvedValueOnce([{ count: 0 }])
      selectDistinctChain.where.mockResolvedValueOnce([])
      selectDistinctChain.where.mockResolvedValueOnce([])

      const response = await app.inject({
        method: 'GET',
        url: `/api/users/${TEST_HANDLE}`,
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{ accountCreatedAt: string | null }>()
      expect(body.accountCreatedAt).toBeNull()
    })

    it('returns null for bannerUrl and bio when not set', async () => {
      selectChain.where.mockResolvedValueOnce([sampleUserRow({ bannerUrl: null, bio: null })])
      selectChain.where.mockResolvedValueOnce([{ count: 0 }])
      selectChain.where.mockResolvedValueOnce([{ count: 0 }])
      selectChain.where.mockResolvedValueOnce([{ count: 0 }])
      selectChain.where.mockResolvedValueOnce([{ count: 0 }])
      // votes on topics + replies
      selectChain.where.mockResolvedValueOnce([{ count: 0 }])
      selectChain.where.mockResolvedValueOnce([{ count: 0 }])
      // communityCount
      selectDistinctChain.where.mockResolvedValueOnce([])
      selectDistinctChain.where.mockResolvedValueOnce([])

      const response = await app.inject({
        method: 'GET',
        url: `/api/users/${TEST_HANDLE}`,
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{
        bannerUrl: string | null
        bio: string | null
      }>()
      expect(body.bannerUrl).toBeNull()
      expect(body.bio).toBeNull()
    })

    it('resolves profile through community override when communityDid is provided', async () => {
      // 1st select: user by handle
      selectChain.where.mockResolvedValueOnce([sampleUserRow()])
      // 2nd select: topic count
      selectChain.where.mockResolvedValueOnce([{ count: 0 }])
      // 3rd select: reply count
      selectChain.where.mockResolvedValueOnce([{ count: 0 }])
      // 4th select: reactions on topics
      selectChain.where.mockResolvedValueOnce([{ count: 0 }])
      // 5th select: reactions on replies
      selectChain.where.mockResolvedValueOnce([{ count: 0 }])
      // votes on topics + replies
      selectChain.where.mockResolvedValueOnce([{ count: 0 }])
      selectChain.where.mockResolvedValueOnce([{ count: 0 }])
      // communityCount
      selectDistinctChain.where.mockResolvedValueOnce([])
      selectDistinctChain.where.mockResolvedValueOnce([])
      // community-scoped counts (6 queries)
      selectChain.where.mockResolvedValueOnce([{ count: 0 }])
      selectChain.where.mockResolvedValueOnce([{ count: 0 }])
      selectChain.where.mockResolvedValueOnce([{ count: 0 }])
      selectChain.where.mockResolvedValueOnce([{ count: 0 }])
      selectChain.where.mockResolvedValueOnce([{ count: 0 }])
      selectChain.where.mockResolvedValueOnce([{ count: 0 }])
      // community_profiles override
      selectChain.where.mockResolvedValueOnce([
        {
          did: TEST_DID,
          communityDid: COMMUNITY_DID,
          displayName: 'Jay in the Community',
          avatarUrl: null,
          bannerUrl: 'https://example.com/community-banner.jpg',
          bio: null,
          updatedAt: new Date(TEST_NOW),
        },
      ])

      const response = await app.inject({
        method: 'GET',
        url: `/api/users/${TEST_HANDLE}?communityDid=${COMMUNITY_DID}`,
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{
        did: string
        handle: string
        displayName: string
        avatarUrl: string | null
        bannerUrl: string | null
        bio: string | null
      }>()
      // Community override takes precedence for displayName and bannerUrl
      expect(body.displayName).toBe('Jay in the Community')
      expect(body.bannerUrl).toBe('https://example.com/community-banner.jpg')
      // Falls back to source for avatarUrl and bio (override is null)
      expect(body.avatarUrl).toBe('https://example.com/avatar.jpg')
      expect(body.bio).toBe('Hello, I am Jay')
    })

    it('returns source profile when communityDid has no override row', async () => {
      // 1st select: user by handle
      selectChain.where.mockResolvedValueOnce([sampleUserRow()])
      // 2nd-5th select: activity counts
      selectChain.where.mockResolvedValueOnce([{ count: 0 }])
      selectChain.where.mockResolvedValueOnce([{ count: 0 }])
      selectChain.where.mockResolvedValueOnce([{ count: 0 }])
      selectChain.where.mockResolvedValueOnce([{ count: 0 }])
      // votes on topics + replies
      selectChain.where.mockResolvedValueOnce([{ count: 0 }])
      selectChain.where.mockResolvedValueOnce([{ count: 0 }])
      // communityCount
      selectDistinctChain.where.mockResolvedValueOnce([])
      selectDistinctChain.where.mockResolvedValueOnce([])
      // community-scoped counts (6 queries)
      selectChain.where.mockResolvedValueOnce([{ count: 0 }])
      selectChain.where.mockResolvedValueOnce([{ count: 0 }])
      selectChain.where.mockResolvedValueOnce([{ count: 0 }])
      selectChain.where.mockResolvedValueOnce([{ count: 0 }])
      selectChain.where.mockResolvedValueOnce([{ count: 0 }])
      selectChain.where.mockResolvedValueOnce([{ count: 0 }])
      // no community_profiles row
      selectChain.where.mockResolvedValueOnce([])

      const response = await app.inject({
        method: 'GET',
        url: `/api/users/${TEST_HANDLE}?communityDid=${COMMUNITY_DID}`,
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{
        displayName: string
        bannerUrl: string | null
        bio: string | null
      }>()
      // Falls back to source values
      expect(body.displayName).toBe('Jay')
      expect(body.bannerUrl).toBe('https://example.com/banner.jpg')
      expect(body.bio).toBe('Hello, I am Jay')
    })

    it('returns 404 for unknown handle', async () => {
      selectChain.where.mockResolvedValueOnce([])

      const response = await app.inject({
        method: 'GET',
        url: '/api/users/nonexistent.bsky.social',
      })

      expect(response.statusCode).toBe(404)
    })

    it('falls back to zero when activity count results are empty arrays', async () => {
      // User lookup
      selectChain.where.mockResolvedValueOnce([sampleUserRow()])
      // All count queries return empty arrays (no [0].count)
      selectChain.where.mockResolvedValueOnce([])
      selectChain.where.mockResolvedValueOnce([])
      selectChain.where.mockResolvedValueOnce([])
      selectChain.where.mockResolvedValueOnce([])
      // votes on topics + replies
      selectChain.where.mockResolvedValueOnce([])
      selectChain.where.mockResolvedValueOnce([])
      // communityCount
      selectDistinctChain.where.mockResolvedValueOnce([])
      selectDistinctChain.where.mockResolvedValueOnce([])

      const response = await app.inject({
        method: 'GET',
        url: `/api/users/${TEST_HANDLE}`,
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{
        activity: {
          topicCount: number
          replyCount: number
          reactionsReceived: number
          votesReceived: number
        }
      }>()
      expect(body.activity.topicCount).toBe(0)
      expect(body.activity.replyCount).toBe(0)
      expect(body.activity.reactionsReceived).toBe(0)
      expect(body.activity.votesReceived).toBe(0)
    })

    it('returns null for displayName and avatarUrl when user fields are undefined', async () => {
      selectChain.where.mockResolvedValueOnce([
        sampleUserRow({ displayName: undefined, avatarUrl: undefined }),
      ])
      selectChain.where.mockResolvedValueOnce([{ count: 0 }])
      selectChain.where.mockResolvedValueOnce([{ count: 0 }])
      selectChain.where.mockResolvedValueOnce([{ count: 0 }])
      selectChain.where.mockResolvedValueOnce([{ count: 0 }])
      // votes on topics + replies
      selectChain.where.mockResolvedValueOnce([{ count: 0 }])
      selectChain.where.mockResolvedValueOnce([{ count: 0 }])
      // communityCount
      selectDistinctChain.where.mockResolvedValueOnce([])
      selectDistinctChain.where.mockResolvedValueOnce([])

      const response = await app.inject({
        method: 'GET',
        url: `/api/users/${TEST_HANDLE}`,
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{
        displayName: string | null
        avatarUrl: string | null
      }>()
      expect(body.displayName).toBeNull()
      expect(body.avatarUrl).toBeNull()
    })

    it('serializes dates as ISO strings', async () => {
      selectChain.where.mockResolvedValueOnce([sampleUserRow()])
      selectChain.where.mockResolvedValueOnce([{ count: 0 }])
      selectChain.where.mockResolvedValueOnce([{ count: 0 }])
      selectChain.where.mockResolvedValueOnce([{ count: 0 }])
      selectChain.where.mockResolvedValueOnce([{ count: 0 }])
      // votes on topics + replies
      selectChain.where.mockResolvedValueOnce([{ count: 0 }])
      selectChain.where.mockResolvedValueOnce([{ count: 0 }])
      // communityCount
      selectDistinctChain.where.mockResolvedValueOnce([])
      selectDistinctChain.where.mockResolvedValueOnce([])

      const response = await app.inject({
        method: 'GET',
        url: `/api/users/${TEST_HANDLE}`,
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{
        firstSeenAt: string
        lastActiveAt: string
      }>()
      expect(body.firstSeenAt).toBe(TEST_NOW)
      expect(body.lastActiveAt).toBe(TEST_NOW)
    })

    it('includes labels with isSelfLabel flag in response', async () => {
      const labelsData = [
        { val: 'adult-content', src: TEST_DID, neg: false, cts: '2026-01-15T10:00:00.000Z' },
        {
          val: '!warn',
          src: 'did:plc:ozone-mod-service',
          neg: false,
          cts: '2026-01-20T12:00:00.000Z',
        },
      ]

      selectChain.where.mockResolvedValueOnce([sampleUserRow({ atprotoLabels: labelsData })])
      selectChain.where.mockResolvedValueOnce([{ count: 0 }])
      selectChain.where.mockResolvedValueOnce([{ count: 0 }])
      selectChain.where.mockResolvedValueOnce([{ count: 0 }])
      selectChain.where.mockResolvedValueOnce([{ count: 0 }])
      // votes on topics + replies
      selectChain.where.mockResolvedValueOnce([{ count: 0 }])
      selectChain.where.mockResolvedValueOnce([{ count: 0 }])
      // communityCount
      selectDistinctChain.where.mockResolvedValueOnce([])
      selectDistinctChain.where.mockResolvedValueOnce([])

      const response = await app.inject({
        method: 'GET',
        url: `/api/users/${TEST_HANDLE}`,
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{
        labels: Array<{ val: string; src: string; isSelfLabel: boolean }>
      }>()
      expect(body.labels).toStrictEqual([
        { val: 'adult-content', src: TEST_DID, isSelfLabel: true },
        { val: '!warn', src: 'did:plc:ozone-mod-service', isSelfLabel: false },
      ])
    })

    it('returns empty labels array when user has no labels', async () => {
      selectChain.where.mockResolvedValueOnce([sampleUserRow({ atprotoLabels: [] })])
      selectChain.where.mockResolvedValueOnce([{ count: 0 }])
      selectChain.where.mockResolvedValueOnce([{ count: 0 }])
      selectChain.where.mockResolvedValueOnce([{ count: 0 }])
      selectChain.where.mockResolvedValueOnce([{ count: 0 }])
      // votes on topics + replies
      selectChain.where.mockResolvedValueOnce([{ count: 0 }])
      selectChain.where.mockResolvedValueOnce([{ count: 0 }])
      // communityCount
      selectDistinctChain.where.mockResolvedValueOnce([])
      selectDistinctChain.where.mockResolvedValueOnce([])

      const response = await app.inject({
        method: 'GET',
        url: `/api/users/${TEST_HANDLE}`,
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{ labels: unknown[] }>()
      expect(body.labels).toStrictEqual([])
    })

    // -----------------------------------------------------------------------
    // Community-scoped activity
    // -----------------------------------------------------------------------

    it('returns community-scoped activity when communityDid is provided', async () => {
      // 1: user by handle
      selectChain.where.mockResolvedValueOnce([
        sampleUserRow({
          followersCount: 50,
          followsCount: 30,
          atprotoPostsCount: 100,
          hasBlueskyProfile: true,
        }),
      ])
      // 2-5: global counts
      selectChain.where.mockResolvedValueOnce([{ count: 10 }]) // topics
      selectChain.where.mockResolvedValueOnce([{ count: 20 }]) // replies
      selectChain.where.mockResolvedValueOnce([{ count: 5 }]) // reactions on topics
      selectChain.where.mockResolvedValueOnce([{ count: 3 }]) // reactions on replies
      // 6-7: votes
      selectChain.where.mockResolvedValueOnce([{ count: 2 }]) // votes on topics
      selectChain.where.mockResolvedValueOnce([{ count: 1 }]) // votes on replies
      // 8-9: communityCount
      selectDistinctChain.where.mockResolvedValueOnce([
        { communityDid: 'did:plc:comm1' },
        { communityDid: 'did:plc:comm2' },
      ])
      selectDistinctChain.where.mockResolvedValueOnce([{ communityDid: 'did:plc:comm1' }])
      // 10-15: community-scoped counts
      selectChain.where.mockResolvedValueOnce([{ count: 3 }]) // scoped topics
      selectChain.where.mockResolvedValueOnce([{ count: 8 }]) // scoped replies
      selectChain.where.mockResolvedValueOnce([{ count: 2 }]) // scoped reactions on topics
      selectChain.where.mockResolvedValueOnce([{ count: 1 }]) // scoped reactions on replies
      selectChain.where.mockResolvedValueOnce([{ count: 1 }]) // scoped votes on topics
      selectChain.where.mockResolvedValueOnce([{ count: 0 }]) // scoped votes on replies
      // community profile override
      selectChain.where.mockResolvedValueOnce([])

      const response = await app.inject({
        method: 'GET',
        url: `/api/users/${TEST_HANDLE}?communityDid=${COMMUNITY_DID}`,
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{
        activity: {
          topicCount: number
          replyCount: number
          reactionsReceived: number
          votesReceived: number
        }
        globalActivity: {
          topicCount: number
          replyCount: number
          reactionsReceived: number
          votesReceived: number
        }
        followersCount: number
        hasBlueskyProfile: boolean
      }>()
      // Activity should be community-scoped
      expect(body.activity.topicCount).toBe(3)
      expect(body.activity.replyCount).toBe(8)
      expect(body.activity.reactionsReceived).toBe(3)
      expect(body.activity.votesReceived).toBe(1)
      // Global activity should be present (2 communities)
      expect(body.globalActivity).toBeDefined()
      expect(body.globalActivity.topicCount).toBe(10)
      // AT Protocol stats
      expect(body.followersCount).toBe(50)
      expect(body.hasBlueskyProfile).toBe(true)
    })

    it('omits globalActivity when user is in only 1 community', async () => {
      selectChain.where.mockResolvedValueOnce([sampleUserRow()])
      // global counts
      selectChain.where.mockResolvedValueOnce([{ count: 5 }])
      selectChain.where.mockResolvedValueOnce([{ count: 10 }])
      selectChain.where.mockResolvedValueOnce([{ count: 3 }])
      selectChain.where.mockResolvedValueOnce([{ count: 2 }])
      selectChain.where.mockResolvedValueOnce([{ count: 1 }])
      selectChain.where.mockResolvedValueOnce([{ count: 0 }])
      // communityCount = 1
      selectDistinctChain.where.mockResolvedValueOnce([{ communityDid: COMMUNITY_DID }])
      selectDistinctChain.where.mockResolvedValueOnce([])
      // community-scoped counts (same as global for 1 community)
      selectChain.where.mockResolvedValueOnce([{ count: 5 }])
      selectChain.where.mockResolvedValueOnce([{ count: 10 }])
      selectChain.where.mockResolvedValueOnce([{ count: 3 }])
      selectChain.where.mockResolvedValueOnce([{ count: 2 }])
      selectChain.where.mockResolvedValueOnce([{ count: 1 }])
      selectChain.where.mockResolvedValueOnce([{ count: 0 }])
      // community override
      selectChain.where.mockResolvedValueOnce([])

      const response = await app.inject({
        method: 'GET',
        url: `/api/users/${TEST_HANDLE}?communityDid=${COMMUNITY_DID}`,
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{
        globalActivity?: {
          topicCount: number
          replyCount: number
          reactionsReceived: number
          votesReceived: number
        }
      }>()
      expect(body.globalActivity).toBeUndefined()
    })
  })

  // =========================================================================
  // GET /api/users/:handle/reputation
  // =========================================================================

  describe('GET /api/users/:handle/reputation', () => {
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

    it('returns computed reputation (topics*5 + replies*2 + reactions*1)', async () => {
      // User lookup
      selectChain.where.mockResolvedValueOnce([sampleUserRow()])
      // Topics: 3
      selectChain.where.mockResolvedValueOnce([{ count: 3 }])
      // Replies: 7
      selectChain.where.mockResolvedValueOnce([{ count: 7 }])
      // Reactions on topics: 4
      selectChain.where.mockResolvedValueOnce([{ count: 4 }])
      // Reactions on replies: 6
      selectChain.where.mockResolvedValueOnce([{ count: 6 }])
      // PDS trust factor lookup (returns 1.0 so it doesn't affect the base formula)
      selectChain.where.mockResolvedValueOnce([{ trustFactor: 1.0 }])
      // selectDistinct for topic communities and reply communities
      selectDistinctChain.where.mockResolvedValueOnce([])
      selectDistinctChain.where.mockResolvedValueOnce([])

      const response = await app.inject({
        method: 'GET',
        url: `/api/users/${TEST_HANDLE}/reputation`,
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{
        did: string
        handle: string
        reputation: number
        breakdown: {
          topicCount: number
          replyCount: number
          reactionsReceived: number
        }
      }>()
      expect(body.did).toBe(TEST_DID)
      // reputation = (3 * 5) + (7 * 2) + (4 + 6) * 1 = 15 + 14 + 10 = 39
      expect(body.reputation).toBe(39)
      expect(body.breakdown.topicCount).toBe(3)
      expect(body.breakdown.replyCount).toBe(7)
      expect(body.breakdown.reactionsReceived).toBe(10)
    })

    it('returns 404 for unknown handle', async () => {
      selectChain.where.mockResolvedValueOnce([])

      const response = await app.inject({
        method: 'GET',
        url: '/api/users/nonexistent.bsky.social/reputation',
      })

      expect(response.statusCode).toBe(404)
    })

    it('returns zero reputation for user with no activity', async () => {
      selectChain.where.mockResolvedValueOnce([sampleUserRow()])
      selectChain.where.mockResolvedValueOnce([{ count: 0 }])
      selectChain.where.mockResolvedValueOnce([{ count: 0 }])
      selectChain.where.mockResolvedValueOnce([{ count: 0 }])
      selectChain.where.mockResolvedValueOnce([{ count: 0 }])
      // PDS trust factor lookup
      selectChain.where.mockResolvedValueOnce([{ trustFactor: 1.0 }])
      // selectDistinct for topic communities and reply communities
      selectDistinctChain.where.mockResolvedValueOnce([])
      selectDistinctChain.where.mockResolvedValueOnce([])

      const response = await app.inject({
        method: 'GET',
        url: `/api/users/${TEST_HANDLE}/reputation`,
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{ reputation: number; communityCount: number }>()
      expect(body.reputation).toBe(0)
      expect(body.communityCount).toBe(0)
    })

    it('includes communityCount in reputation response', async () => {
      // User lookup
      selectChain.where.mockResolvedValueOnce([sampleUserRow()])
      // Topics: 3
      selectChain.where.mockResolvedValueOnce([{ count: 3 }])
      // Replies: 7
      selectChain.where.mockResolvedValueOnce([{ count: 7 }])
      // Reactions on topics: 4
      selectChain.where.mockResolvedValueOnce([{ count: 4 }])
      // Reactions on replies: 6
      selectChain.where.mockResolvedValueOnce([{ count: 6 }])
      // PDS trust factor lookup
      selectChain.where.mockResolvedValueOnce([{ trustFactor: 1.0 }])
      // Distinct communities from topics
      selectDistinctChain.where.mockResolvedValueOnce([
        { communityDid: 'did:plc:comm-a' },
        { communityDid: 'did:plc:comm-b' },
      ])
      // Distinct communities from replies
      selectDistinctChain.where.mockResolvedValueOnce([
        { communityDid: 'did:plc:comm-b' },
        { communityDid: 'did:plc:comm-c' },
      ])

      const response = await app.inject({
        method: 'GET',
        url: `/api/users/${TEST_HANDLE}/reputation`,
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{
        did: string
        handle: string
        reputation: number
        breakdown: {
          topicCount: number
          replyCount: number
          reactionsReceived: number
        }
        communityCount: number
      }>()
      expect(body.communityCount).toBe(3) // comm-a, comm-b, comm-c (deduplicated)
    })

    it('uses fallback trust score of 0.1 when trustGraphService.getTrustScore rejects', async () => {
      const trustApp = await buildTestApp(testUser())
      // Override trustGraphService to reject
      ;(
        trustApp as unknown as { trustGraphService: { getTrustScore: ReturnType<typeof vi.fn> } }
      ).trustGraphService.getTrustScore = vi.fn().mockRejectedValue(new Error('trust service down'))

      resetAllDbMocks()
      // User lookup
      selectChain.where.mockResolvedValueOnce([sampleUserRow()])
      // Topics: 10
      selectChain.where.mockResolvedValueOnce([{ count: 10 }])
      // Replies: 0
      selectChain.where.mockResolvedValueOnce([{ count: 0 }])
      // Reactions on topics: 0
      selectChain.where.mockResolvedValueOnce([{ count: 0 }])
      // Reactions on replies: 0
      selectChain.where.mockResolvedValueOnce([{ count: 0 }])
      // PDS trust factor
      selectChain.where.mockResolvedValueOnce([{ trustFactor: 1.0 }])
      // Community counts
      selectDistinctChain.where.mockResolvedValueOnce([])
      selectDistinctChain.where.mockResolvedValueOnce([])

      const response = await trustApp.inject({
        method: 'GET',
        url: `/api/users/${TEST_HANDLE}/reputation`,
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{ reputation: number }>()
      // baseReputation = 10 * 5 = 50; voterTrustScore = 0.1; pdsTrustFactor = 1.0; clusterDiversity = 1.0
      // reputation = Math.round(50 * 0.1 * 1.0 * 1.0) = 5
      expect(body.reputation).toBe(5)

      await trustApp.close()
    })

    it('uses default PDS trust factor 0.3 when no PDS row is found', async () => {
      // User lookup
      selectChain.where.mockResolvedValueOnce([sampleUserRow()])
      // Topics: 10
      selectChain.where.mockResolvedValueOnce([{ count: 10 }])
      // Replies: 0
      selectChain.where.mockResolvedValueOnce([{ count: 0 }])
      // Reactions on topics: 0
      selectChain.where.mockResolvedValueOnce([{ count: 0 }])
      // Reactions on replies: 0
      selectChain.where.mockResolvedValueOnce([{ count: 0 }])
      // PDS trust factor: no rows found -> default 0.3
      selectChain.where.mockResolvedValueOnce([])
      // Sybil cluster check: not in any cluster
      // Community counts
      selectDistinctChain.where.mockResolvedValueOnce([])
      selectDistinctChain.where.mockResolvedValueOnce([])

      const response = await app.inject({
        method: 'GET',
        url: `/api/users/${TEST_HANDLE}/reputation`,
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{ reputation: number }>()
      // baseReputation = 10 * 5 = 50; voterTrustScore = 1.0; pdsTrustFactor = 0.3; clusterDiversity = 1.0
      // reputation = Math.round(50 * 1.0 * 0.3 * 1.0) = 15
      expect(body.reputation).toBe(15)
    })

    it('uses default PDS trust factor 0.3 when PDS lookup throws', async () => {
      // Use a user whose handle has only one segment (edge case for PDS host extraction)
      selectChain.where.mockResolvedValueOnce([sampleUserRow({ handle: 'localhost' })])
      // Topics: 10
      selectChain.where.mockResolvedValueOnce([{ count: 10 }])
      // Replies: 0
      selectChain.where.mockResolvedValueOnce([{ count: 0 }])
      // Reactions on topics: 0
      selectChain.where.mockResolvedValueOnce([{ count: 0 }])
      // Reactions on replies: 0
      selectChain.where.mockResolvedValueOnce([{ count: 0 }])
      // PDS trust factor: query throws an error
      selectChain.where.mockRejectedValueOnce(new Error('PDS lookup failed'))
      // Community counts
      selectDistinctChain.where.mockResolvedValueOnce([])
      selectDistinctChain.where.mockResolvedValueOnce([])

      const response = await app.inject({
        method: 'GET',
        url: '/api/users/localhost/reputation',
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{ reputation: number }>()
      // baseReputation = 50; voterTrustScore = 1.0; pdsTrustFactor = 0.3 (catch default); clusterDiversity = 1.0
      expect(body.reputation).toBe(15)
    })

    it('extracts single-segment handle as PDS host when handle has no dots', async () => {
      // User with single-segment handle
      selectChain.where.mockResolvedValueOnce([sampleUserRow({ handle: 'singlepart' })])
      // Topics: 10
      selectChain.where.mockResolvedValueOnce([{ count: 10 }])
      // Replies: 0
      selectChain.where.mockResolvedValueOnce([{ count: 0 }])
      // Reactions: 0
      selectChain.where.mockResolvedValueOnce([{ count: 0 }])
      selectChain.where.mockResolvedValueOnce([{ count: 0 }])
      // PDS trust factor: found for the single-segment host
      selectChain.where.mockResolvedValueOnce([{ trustFactor: 0.8 }])
      // Community counts
      selectDistinctChain.where.mockResolvedValueOnce([])
      selectDistinctChain.where.mockResolvedValueOnce([])

      const response = await app.inject({
        method: 'GET',
        url: '/api/users/singlepart/reputation',
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{ reputation: number }>()
      // handleParts.length = 1, so pdsHost = user.handle = 'singlepart'
      // baseReputation = 50; voterTrustScore = 1.0; pdsTrustFactor = 0.8; clusterDiversity = 1.0
      // reputation = Math.round(50 * 1.0 * 0.8 * 1.0) = 40
      expect(body.reputation).toBe(40)
    })

    it('applies sybil cluster penalty for user in flagged cluster with no external interactions', async () => {
      // User lookup
      selectChain.where.mockResolvedValueOnce([sampleUserRow()])
      // Topics: 10
      selectChain.where.mockResolvedValueOnce([{ count: 10 }])
      // Replies: 0
      selectChain.where.mockResolvedValueOnce([{ count: 0 }])
      // Reactions: 0
      selectChain.where.mockResolvedValueOnce([{ count: 0 }])
      selectChain.where.mockResolvedValueOnce([{ count: 0 }])
      // PDS trust factor
      selectChain.where.mockResolvedValueOnce([{ trustFactor: 1.0 }])
      // Sybil cluster members: user is in cluster 1
      selectChain.where.mockResolvedValueOnce([{ clusterId: 1 }])
      // Flagged clusters: cluster 1 is flagged
      selectChain.where.mockResolvedValueOnce([{ id: 1 }])
      // External interaction count: 0
      selectChain.where.mockResolvedValueOnce([{ count: 0 }])
      // Community counts
      selectDistinctChain.where.mockResolvedValueOnce([])
      selectDistinctChain.where.mockResolvedValueOnce([])

      const response = await app.inject({
        method: 'GET',
        url: `/api/users/${TEST_HANDLE}/reputation`,
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{ reputation: number }>()
      // clusterDiversityFactor = log2(1 + 0) = log2(1) = 0
      // reputation = Math.round(50 * 1.0 * 1.0 * 0) = 0
      expect(body.reputation).toBe(0)
    })

    it('applies reduced sybil cluster penalty when user has external interactions', async () => {
      // User lookup
      selectChain.where.mockResolvedValueOnce([sampleUserRow()])
      // Topics: 10
      selectChain.where.mockResolvedValueOnce([{ count: 10 }])
      // Replies: 0
      selectChain.where.mockResolvedValueOnce([{ count: 0 }])
      // Reactions: 0
      selectChain.where.mockResolvedValueOnce([{ count: 0 }])
      selectChain.where.mockResolvedValueOnce([{ count: 0 }])
      // PDS trust factor
      selectChain.where.mockResolvedValueOnce([{ trustFactor: 1.0 }])
      // Sybil cluster members: user is in cluster 1
      selectChain.where.mockResolvedValueOnce([{ clusterId: 1 }])
      // Flagged clusters: cluster 1 is flagged
      selectChain.where.mockResolvedValueOnce([{ id: 1 }])
      // External interaction count: 7
      selectChain.where.mockResolvedValueOnce([{ count: 7 }])
      // Community counts
      selectDistinctChain.where.mockResolvedValueOnce([])
      selectDistinctChain.where.mockResolvedValueOnce([])

      const response = await app.inject({
        method: 'GET',
        url: `/api/users/${TEST_HANDLE}/reputation`,
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{ reputation: number }>()
      // clusterDiversityFactor = log2(1 + 7) = log2(8) = 3
      // reputation = Math.round(50 * 1.0 * 1.0 * 3) = 150
      expect(body.reputation).toBe(150)
    })

    it('does not apply sybil penalty when user is in cluster but cluster is not flagged', async () => {
      // User lookup
      selectChain.where.mockResolvedValueOnce([sampleUserRow()])
      // Topics: 10
      selectChain.where.mockResolvedValueOnce([{ count: 10 }])
      // Replies: 0
      selectChain.where.mockResolvedValueOnce([{ count: 0 }])
      // Reactions: 0
      selectChain.where.mockResolvedValueOnce([{ count: 0 }])
      selectChain.where.mockResolvedValueOnce([{ count: 0 }])
      // PDS trust factor
      selectChain.where.mockResolvedValueOnce([{ trustFactor: 1.0 }])
      // Sybil cluster members: user is in cluster 1
      selectChain.where.mockResolvedValueOnce([{ clusterId: 1 }])
      // Flagged clusters: none flagged (empty result)
      selectChain.where.mockResolvedValueOnce([])
      // Community counts (no external interaction query since not flagged)
      selectDistinctChain.where.mockResolvedValueOnce([])
      selectDistinctChain.where.mockResolvedValueOnce([])

      const response = await app.inject({
        method: 'GET',
        url: `/api/users/${TEST_HANDLE}/reputation`,
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{ reputation: number }>()
      // inFlaggedCluster = false, so clusterDiversityFactor = 1.0
      // reputation = Math.round(50 * 1.0 * 1.0 * 1.0) = 50
      expect(body.reputation).toBe(50)
    })

    it('defaults to no cluster adjustment when sybil lookup throws', async () => {
      // User lookup
      selectChain.where.mockResolvedValueOnce([sampleUserRow()])
      // Topics: 10
      selectChain.where.mockResolvedValueOnce([{ count: 10 }])
      // Replies: 0
      selectChain.where.mockResolvedValueOnce([{ count: 0 }])
      // Reactions: 0
      selectChain.where.mockResolvedValueOnce([{ count: 0 }])
      selectChain.where.mockResolvedValueOnce([{ count: 0 }])
      // PDS trust factor
      selectChain.where.mockResolvedValueOnce([{ trustFactor: 1.0 }])
      // Sybil cluster lookup: throws
      selectChain.where.mockRejectedValueOnce(new Error('sybil lookup failed'))
      // Community counts
      selectDistinctChain.where.mockResolvedValueOnce([])
      selectDistinctChain.where.mockResolvedValueOnce([])

      const response = await app.inject({
        method: 'GET',
        url: `/api/users/${TEST_HANDLE}/reputation`,
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{ reputation: number }>()
      // inFlaggedCluster = false (catch default), clusterDiversityFactor = 1.0
      // reputation = Math.round(50 * 1.0 * 1.0 * 1.0) = 50
      expect(body.reputation).toBe(50)
    })

    it('falls back to zero when reputation count results are empty arrays', async () => {
      // User lookup
      selectChain.where.mockResolvedValueOnce([sampleUserRow()])
      // All count queries return empty arrays
      selectChain.where.mockResolvedValueOnce([])
      selectChain.where.mockResolvedValueOnce([])
      selectChain.where.mockResolvedValueOnce([])
      selectChain.where.mockResolvedValueOnce([])
      // PDS trust factor
      selectChain.where.mockResolvedValueOnce([{ trustFactor: 1.0 }])
      // Community counts
      selectDistinctChain.where.mockResolvedValueOnce([])
      selectDistinctChain.where.mockResolvedValueOnce([])

      const response = await app.inject({
        method: 'GET',
        url: `/api/users/${TEST_HANDLE}/reputation`,
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{
        reputation: number
        breakdown: {
          topicCount: number
          replyCount: number
          reactionsReceived: number
        }
      }>()
      expect(body.reputation).toBe(0)
      expect(body.breakdown.topicCount).toBe(0)
      expect(body.breakdown.replyCount).toBe(0)
      expect(body.breakdown.reactionsReceived).toBe(0)
    })

    it('falls back to zero external interactions when count result is empty', async () => {
      // User lookup
      selectChain.where.mockResolvedValueOnce([sampleUserRow()])
      // Topics: 10
      selectChain.where.mockResolvedValueOnce([{ count: 10 }])
      // Replies: 0
      selectChain.where.mockResolvedValueOnce([{ count: 0 }])
      // Reactions: 0
      selectChain.where.mockResolvedValueOnce([{ count: 0 }])
      selectChain.where.mockResolvedValueOnce([{ count: 0 }])
      // PDS trust factor
      selectChain.where.mockResolvedValueOnce([{ trustFactor: 1.0 }])
      // Sybil cluster members: user is in cluster 1
      selectChain.where.mockResolvedValueOnce([{ clusterId: 1 }])
      // Flagged clusters: cluster 1 is flagged
      selectChain.where.mockResolvedValueOnce([{ id: 1 }])
      // External interactions: empty result (no [0].count)
      selectChain.where.mockResolvedValueOnce([])
      // Community counts
      selectDistinctChain.where.mockResolvedValueOnce([])
      selectDistinctChain.where.mockResolvedValueOnce([])

      const response = await app.inject({
        method: 'GET',
        url: `/api/users/${TEST_HANDLE}/reputation`,
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{ reputation: number }>()
      // externalInteractionCount = 0 (fallback), clusterDiversityFactor = log2(1+0) = 0
      expect(body.reputation).toBe(0)
    })

    it('handles user in multiple sybil clusters', async () => {
      // User lookup
      selectChain.where.mockResolvedValueOnce([sampleUserRow()])
      // Topics: 10
      selectChain.where.mockResolvedValueOnce([{ count: 10 }])
      // Replies: 0
      selectChain.where.mockResolvedValueOnce([{ count: 0 }])
      // Reactions: 0
      selectChain.where.mockResolvedValueOnce([{ count: 0 }])
      selectChain.where.mockResolvedValueOnce([{ count: 0 }])
      // PDS trust factor
      selectChain.where.mockResolvedValueOnce([{ trustFactor: 1.0 }])
      // Sybil cluster members: user is in clusters 1 and 2
      selectChain.where.mockResolvedValueOnce([{ clusterId: 1 }, { clusterId: 2 }])
      // Flagged clusters: cluster 2 is flagged
      selectChain.where.mockResolvedValueOnce([{ id: 2 }])
      // External interactions: 3
      selectChain.where.mockResolvedValueOnce([{ count: 3 }])
      // Community counts
      selectDistinctChain.where.mockResolvedValueOnce([])
      selectDistinctChain.where.mockResolvedValueOnce([])

      const response = await app.inject({
        method: 'GET',
        url: `/api/users/${TEST_HANDLE}/reputation`,
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{ reputation: number }>()
      // clusterDiversityFactor = log2(1 + 3) = log2(4) = 2
      // reputation = Math.round(50 * 1.0 * 1.0 * 2) = 100
      expect(body.reputation).toBe(100)
    })

    it('counts distinct communities across topics and replies', async () => {
      // User lookup
      selectChain.where.mockResolvedValueOnce([sampleUserRow()])
      // Topics: 2
      selectChain.where.mockResolvedValueOnce([{ count: 2 }])
      // Replies: 1
      selectChain.where.mockResolvedValueOnce([{ count: 1 }])
      // Reactions on topics: 0
      selectChain.where.mockResolvedValueOnce([{ count: 0 }])
      // Reactions on replies: 0
      selectChain.where.mockResolvedValueOnce([{ count: 0 }])
      // PDS trust factor lookup
      selectChain.where.mockResolvedValueOnce([{ trustFactor: 1.0 }])
      // Topic communities -- user created topics only in comm-a
      selectDistinctChain.where.mockResolvedValueOnce([{ communityDid: 'did:plc:comm-a' }])
      // Reply communities -- user replied only in comm-b (different community)
      selectDistinctChain.where.mockResolvedValueOnce([{ communityDid: 'did:plc:comm-b' }])

      const response = await app.inject({
        method: 'GET',
        url: `/api/users/${TEST_HANDLE}/reputation`,
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{ communityCount: number }>()
      // 2 distinct communities: comm-a (from topics) + comm-b (from replies)
      expect(body.communityCount).toBe(2)
    })
  })

  // =========================================================================
  // POST /api/users/me/age-declaration
  // =========================================================================

  describe('POST /api/users/me/age-declaration', () => {
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

    it('stores declared age and returns it', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/users/me/age-declaration',
        headers: { authorization: 'Bearer test-token' },
        payload: { declaredAge: 16 },
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{
        success: boolean
        declaredAge: number
      }>()
      expect(body.success).toBe(true)
      expect(body.declaredAge).toBe(16)
      expect(mockDb.insert).toHaveBeenCalledOnce()
    })

    it('accepts declaredAge 0 (rather not say)', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/users/me/age-declaration',
        headers: { authorization: 'Bearer test-token' },
        payload: { declaredAge: 0 },
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{
        success: boolean
        declaredAge: number
      }>()
      expect(body.success).toBe(true)
      expect(body.declaredAge).toBe(0)
    })

    it('returns 401 when not authenticated', async () => {
      const noAuthApp = await buildTestApp(undefined)

      const response = await noAuthApp.inject({
        method: 'POST',
        url: '/api/users/me/age-declaration',
        payload: { declaredAge: 16 },
      })

      expect(response.statusCode).toBe(401)
      await noAuthApp.close()
    })

    it('returns 400 when declaredAge is invalid', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/users/me/age-declaration',
        headers: { authorization: 'Bearer test-token' },
        payload: { declaredAge: 17 },
      })

      expect(response.statusCode).toBe(400)
    })

    it('returns 400 when body is empty', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/users/me/age-declaration',
        headers: { authorization: 'Bearer test-token' },
        payload: {},
      })

      expect(response.statusCode).toBe(400)
    })

    it('accepts all valid declared age values (13, 14, 15, 18)', async () => {
      for (const age of [13, 14, 15, 18]) {
        vi.clearAllMocks()
        resetAllDbMocks()

        const response = await app.inject({
          method: 'POST',
          url: '/api/users/me/age-declaration',
          headers: { authorization: 'Bearer test-token' },
          payload: { declaredAge: age },
        })

        expect(response.statusCode).toBe(200)
        const body = response.json<{ success: boolean; declaredAge: number }>()
        expect(body.success).toBe(true)
        expect(body.declaredAge).toBe(age)
      }
    })

    it('returns 400 for negative declaredAge', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/users/me/age-declaration',
        headers: { authorization: 'Bearer test-token' },
        payload: { declaredAge: -1 },
      })

      expect(response.statusCode).toBe(400)
    })

    it('returns 400 for non-integer declaredAge', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/users/me/age-declaration',
        headers: { authorization: 'Bearer test-token' },
        payload: { declaredAge: 16.5 },
      })

      // Fastify schema validation rejects non-integer before our Zod check
      expect(response.statusCode).toBe(400)
    })

    it('calls both insert (upsert) and update on users table', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/users/me/age-declaration',
        headers: { authorization: 'Bearer test-token' },
        payload: { declaredAge: 18 },
      })

      expect(response.statusCode).toBe(200)
      expect(mockDb.insert).toHaveBeenCalledOnce()
      expect(mockDb.update).toHaveBeenCalledOnce()
    })
  })

  // =========================================================================
  // GET /api/users/me/preferences
  // =========================================================================

  describe('GET /api/users/me/preferences', () => {
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

    it('returns existing preferences', async () => {
      selectChain.where.mockResolvedValueOnce([
        samplePrefsRow({ maturityLevel: 'mature', crossPostBluesky: true }),
      ])

      const response = await app.inject({
        method: 'GET',
        url: '/api/users/me/preferences',
        headers: { authorization: 'Bearer test-token' },
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{
        maturityLevel: string
        crossPostBluesky: boolean
      }>()
      expect(body.maturityLevel).toBe('mature')
      expect(body.crossPostBluesky).toBe(true)
    })

    it('returns defaults when no preferences row exists', async () => {
      selectChain.where.mockResolvedValueOnce([])

      const response = await app.inject({
        method: 'GET',
        url: '/api/users/me/preferences',
        headers: { authorization: 'Bearer test-token' },
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{
        maturityLevel: string
        mutedWords: string[]
        crossPostBluesky: boolean
        crossPostFrontpage: boolean
      }>()
      expect(body.maturityLevel).toBe('sfw')
      expect(body.mutedWords).toEqual([])
      expect(body.crossPostBluesky).toBe(false)
      expect(body.crossPostFrontpage).toBe(false)
    })

    it('returns declaredAge as null when prefs.declaredAge is undefined', async () => {
      selectChain.where.mockResolvedValueOnce([samplePrefsRow({ declaredAge: undefined })])

      const response = await app.inject({
        method: 'GET',
        url: '/api/users/me/preferences',
        headers: { authorization: 'Bearer test-token' },
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{ declaredAge: number | null }>()
      expect(body.declaredAge).toBeNull()
    })

    it('returns declaredAge value when set', async () => {
      selectChain.where.mockResolvedValueOnce([samplePrefsRow({ declaredAge: 18 })])

      const response = await app.inject({
        method: 'GET',
        url: '/api/users/me/preferences',
        headers: { authorization: 'Bearer test-token' },
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{ declaredAge: number | null }>()
      expect(body.declaredAge).toBe(18)
    })

    it('returns all preference fields from existing row', async () => {
      selectChain.where.mockResolvedValueOnce([
        samplePrefsRow({
          maturityLevel: 'mature',
          declaredAge: 16,
          mutedWords: ['spam', 'ads'],
          blockedDids: ['did:plc:blocked1'],
          mutedDids: ['did:plc:muted1'],
          crossPostBluesky: true,
          crossPostFrontpage: true,
        }),
      ])

      const response = await app.inject({
        method: 'GET',
        url: '/api/users/me/preferences',
        headers: { authorization: 'Bearer test-token' },
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{
        maturityLevel: string
        declaredAge: number | null
        mutedWords: string[]
        blockedDids: string[]
        mutedDids: string[]
        crossPostBluesky: boolean
        crossPostFrontpage: boolean
        updatedAt: string
      }>()
      expect(body.maturityLevel).toBe('mature')
      expect(body.declaredAge).toBe(16)
      expect(body.mutedWords).toEqual(['spam', 'ads'])
      expect(body.blockedDids).toEqual(['did:plc:blocked1'])
      expect(body.mutedDids).toEqual(['did:plc:muted1'])
      expect(body.crossPostBluesky).toBe(true)
      expect(body.crossPostFrontpage).toBe(true)
      expect(body.updatedAt).toBe(TEST_NOW)
    })

    it('returns 401 when not authenticated', async () => {
      const noAuthApp = await buildTestApp(undefined)

      const response = await noAuthApp.inject({
        method: 'GET',
        url: '/api/users/me/preferences',
      })

      expect(response.statusCode).toBe(401)
      await noAuthApp.close()
    })
  })

  // =========================================================================
  // PUT /api/users/me/preferences
  // =========================================================================

  describe('PUT /api/users/me/preferences', () => {
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

    it('upserts preferences and returns updated values', async () => {
      // After upsert, the select returns updated prefs
      selectChain.where.mockResolvedValueOnce([
        samplePrefsRow({
          maturityLevel: 'mature',
          mutedWords: ['spoiler'],
        }),
      ])

      const response = await app.inject({
        method: 'PUT',
        url: '/api/users/me/preferences',
        headers: { authorization: 'Bearer test-token' },
        payload: {
          maturityLevel: 'mature',
          mutedWords: ['spoiler'],
        },
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{
        maturityLevel: string
        mutedWords: string[]
      }>()
      expect(body.maturityLevel).toBe('mature')
      expect(body.mutedWords).toEqual(['spoiler'])
      expect(mockDb.insert).toHaveBeenCalledOnce()
    })

    it('returns 401 when not authenticated', async () => {
      const noAuthApp = await buildTestApp(undefined)

      const response = await noAuthApp.inject({
        method: 'PUT',
        url: '/api/users/me/preferences',
        payload: { maturityLevel: 'sfw' },
      })

      expect(response.statusCode).toBe(401)
      await noAuthApp.close()
    })

    it('returns 400 for invalid maturityLevel', async () => {
      const response = await app.inject({
        method: 'PUT',
        url: '/api/users/me/preferences',
        headers: { authorization: 'Bearer test-token' },
        payload: { maturityLevel: 'invalid' },
      })

      expect(response.statusCode).toBe(400)
    })

    it('returns defaults when preferences row not found after upsert', async () => {
      // The select after upsert returns empty
      selectChain.where.mockResolvedValueOnce([])

      const response = await app.inject({
        method: 'PUT',
        url: '/api/users/me/preferences',
        headers: { authorization: 'Bearer test-token' },
        payload: { maturityLevel: 'sfw' },
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{
        maturityLevel: string
        mutedWords: string[]
        crossPostBluesky: boolean
        crossPostFrontpage: boolean
      }>()
      expect(body.maturityLevel).toBe('sfw')
      expect(body.mutedWords).toEqual([])
      expect(body.crossPostBluesky).toBe(false)
      expect(body.crossPostFrontpage).toBe(false)
    })

    it('only sets provided fields in the update (partial update with blockedDids only)', async () => {
      selectChain.where.mockResolvedValueOnce([
        samplePrefsRow({ blockedDids: ['did:plc:blocked1'] }),
      ])

      const response = await app.inject({
        method: 'PUT',
        url: '/api/users/me/preferences',
        headers: { authorization: 'Bearer test-token' },
        payload: { blockedDids: ['did:plc:blocked1'] },
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{ blockedDids: string[] }>()
      expect(body.blockedDids).toEqual(['did:plc:blocked1'])
      expect(mockDb.insert).toHaveBeenCalledOnce()
    })

    it('only sets provided fields in the update (partial update with mutedDids only)', async () => {
      selectChain.where.mockResolvedValueOnce([samplePrefsRow({ mutedDids: ['did:plc:muted1'] })])

      const response = await app.inject({
        method: 'PUT',
        url: '/api/users/me/preferences',
        headers: { authorization: 'Bearer test-token' },
        payload: { mutedDids: ['did:plc:muted1'] },
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{ mutedDids: string[] }>()
      expect(body.mutedDids).toEqual(['did:plc:muted1'])
    })

    it('only sets provided fields in the update (crossPostBluesky only)', async () => {
      selectChain.where.mockResolvedValueOnce([samplePrefsRow({ crossPostBluesky: true })])

      const response = await app.inject({
        method: 'PUT',
        url: '/api/users/me/preferences',
        headers: { authorization: 'Bearer test-token' },
        payload: { crossPostBluesky: true },
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{ crossPostBluesky: boolean }>()
      expect(body.crossPostBluesky).toBe(true)
    })

    it('only sets provided fields in the update (crossPostFrontpage only)', async () => {
      selectChain.where.mockResolvedValueOnce([samplePrefsRow({ crossPostFrontpage: true })])

      const response = await app.inject({
        method: 'PUT',
        url: '/api/users/me/preferences',
        headers: { authorization: 'Bearer test-token' },
        payload: { crossPostFrontpage: true },
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{ crossPostFrontpage: boolean }>()
      expect(body.crossPostFrontpage).toBe(true)
    })

    it('sets all fields when all are provided', async () => {
      selectChain.where.mockResolvedValueOnce([
        samplePrefsRow({
          maturityLevel: 'mature',
          mutedWords: ['spoiler'],
          blockedDids: ['did:plc:blocked1'],
          mutedDids: ['did:plc:muted1'],
          crossPostBluesky: true,
          crossPostFrontpage: true,
        }),
      ])

      const response = await app.inject({
        method: 'PUT',
        url: '/api/users/me/preferences',
        headers: { authorization: 'Bearer test-token' },
        payload: {
          maturityLevel: 'mature',
          mutedWords: ['spoiler'],
          blockedDids: ['did:plc:blocked1'],
          mutedDids: ['did:plc:muted1'],
          crossPostBluesky: true,
          crossPostFrontpage: true,
        },
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{
        maturityLevel: string
        mutedWords: string[]
        blockedDids: string[]
        mutedDids: string[]
        crossPostBluesky: boolean
        crossPostFrontpage: boolean
      }>()
      expect(body.maturityLevel).toBe('mature')
      expect(body.mutedWords).toEqual(['spoiler'])
      expect(body.blockedDids).toEqual(['did:plc:blocked1'])
      expect(body.mutedDids).toEqual(['did:plc:muted1'])
      expect(body.crossPostBluesky).toBe(true)
      expect(body.crossPostFrontpage).toBe(true)
    })

    it('sets no optional fields when empty body is provided', async () => {
      selectChain.where.mockResolvedValueOnce([samplePrefsRow()])

      const response = await app.inject({
        method: 'PUT',
        url: '/api/users/me/preferences',
        headers: { authorization: 'Bearer test-token' },
        payload: {},
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{ maturityLevel: string }>()
      expect(body.maturityLevel).toBe('sfw')
    })

    it('returns declaredAge as null when prefs row has no declaredAge', async () => {
      selectChain.where.mockResolvedValueOnce([samplePrefsRow({ declaredAge: undefined })])

      const response = await app.inject({
        method: 'PUT',
        url: '/api/users/me/preferences',
        headers: { authorization: 'Bearer test-token' },
        payload: {},
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{ declaredAge: number | null }>()
      expect(body.declaredAge).toBeNull()
    })

    it('returns 400 when Zod validation fails (mutedWords with empty string)', async () => {
      // Passes Fastify JSON schema (array of strings) but fails Zod (.min(1) on string items)
      const response = await app.inject({
        method: 'PUT',
        url: '/api/users/me/preferences',
        headers: { authorization: 'Bearer test-token' },
        payload: { mutedWords: [''] },
      })

      expect(response.statusCode).toBe(400)
    })
  })

  // =========================================================================
  // GET /api/users/me/preferences/communities (list)
  // =========================================================================

  describe('GET /api/users/me/preferences/communities', () => {
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

    it('returns empty list when user has no community overrides', async () => {
      selectChain.where.mockResolvedValueOnce([])

      const response = await app.inject({
        method: 'GET',
        url: '/api/users/me/preferences/communities',
        headers: { authorization: 'Bearer test-token' },
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{ communities: unknown[] }>()
      expect(body.communities).toEqual([])
    })

    it('returns community overrides with mapped field names', async () => {
      selectChain.where.mockResolvedValueOnce([
        {
          communityDid: COMMUNITY_DID,
          maturityOverride: 'mature',
          mutedWords: ['spoiler'],
          blockedDids: ['did:plc:blocked1'],
          communityName: 'Test Community',
        },
      ])

      const response = await app.inject({
        method: 'GET',
        url: '/api/users/me/preferences/communities',
        headers: { authorization: 'Bearer test-token' },
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{
        communities: {
          communityDid: string
          communityName: string
          maturityLevel: string
          mutedWords: string[]
          blockedDids: string[]
        }[]
      }>()
      expect(body.communities).toHaveLength(1)
      expect(body.communities[0].communityDid).toBe(COMMUNITY_DID)
      expect(body.communities[0].communityName).toBe('Test Community')
      expect(body.communities[0].maturityLevel).toBe('mature')
      expect(body.communities[0].mutedWords).toEqual(['spoiler'])
      expect(body.communities[0].blockedDids).toEqual(['did:plc:blocked1'])
    })

    it('maps null maturityOverride to "inherit"', async () => {
      selectChain.where.mockResolvedValueOnce([
        {
          communityDid: COMMUNITY_DID,
          maturityOverride: null,
          mutedWords: null,
          blockedDids: null,
          communityName: 'Test Community',
        },
      ])

      const response = await app.inject({
        method: 'GET',
        url: '/api/users/me/preferences/communities',
        headers: { authorization: 'Bearer test-token' },
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{
        communities: { maturityLevel: string; mutedWords: string[]; blockedDids: string[] }[]
      }>()
      expect(body.communities[0].maturityLevel).toBe('inherit')
      expect(body.communities[0].mutedWords).toEqual([])
      expect(body.communities[0].blockedDids).toEqual([])
    })

    it('falls back to communityDid when communityName is null', async () => {
      selectChain.where.mockResolvedValueOnce([
        {
          communityDid: COMMUNITY_DID,
          maturityOverride: null,
          mutedWords: null,
          blockedDids: null,
          communityName: null,
        },
      ])

      const response = await app.inject({
        method: 'GET',
        url: '/api/users/me/preferences/communities',
        headers: { authorization: 'Bearer test-token' },
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{ communities: { communityName: string }[] }>()
      expect(body.communities[0].communityName).toBe(COMMUNITY_DID)
    })

    it('includes current community with defaults when user has no overrides', async () => {
      const appWithCommunity = await buildTestApp(testUser(), {
        communityDid: COMMUNITY_DID,
      })

      // 1st select: preferences query returns empty (no overrides saved)
      selectChain.where.mockResolvedValueOnce([])
      // 2nd select: communitySettings lookup for current community name
      selectChain.where.mockResolvedValueOnce([{ communityName: 'Staging Community' }])

      const response = await appWithCommunity.inject({
        method: 'GET',
        url: '/api/users/me/preferences/communities',
        headers: { authorization: 'Bearer test-token' },
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{
        communities: {
          communityDid: string
          communityName: string
          maturityLevel: string
          mutedWords: string[]
          blockedDids: string[]
        }[]
      }>()
      expect(body.communities).toHaveLength(1)
      expect(body.communities[0].communityDid).toBe(COMMUNITY_DID)
      expect(body.communities[0].communityName).toBe('Staging Community')
      expect(body.communities[0].maturityLevel).toBe('inherit')
      expect(body.communities[0].mutedWords).toEqual([])
      expect(body.communities[0].blockedDids).toEqual([])

      await appWithCommunity.close()
    })

    it('does not duplicate current community when overrides already exist for it', async () => {
      const appWithCommunity = await buildTestApp(testUser(), {
        communityDid: COMMUNITY_DID,
      })

      // preferences query returns existing override for the same community
      selectChain.where.mockResolvedValueOnce([
        {
          communityDid: COMMUNITY_DID,
          maturityOverride: 'mature',
          mutedWords: ['spam'],
          blockedDids: [],
          communityName: 'Staging Community',
        },
      ])

      const response = await appWithCommunity.inject({
        method: 'GET',
        url: '/api/users/me/preferences/communities',
        headers: { authorization: 'Bearer test-token' },
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{
        communities: { communityDid: string }[]
      }>()
      expect(body.communities).toHaveLength(1)
      expect(body.communities[0].communityDid).toBe(COMMUNITY_DID)

      await appWithCommunity.close()
    })

    it('falls back to communityDid for current community name when not in communitySettings', async () => {
      const appWithCommunity = await buildTestApp(testUser(), {
        communityDid: COMMUNITY_DID,
      })

      // 1st select: no overrides
      selectChain.where.mockResolvedValueOnce([])
      // 2nd select: communitySettings lookup returns empty
      selectChain.where.mockResolvedValueOnce([])

      const response = await appWithCommunity.inject({
        method: 'GET',
        url: '/api/users/me/preferences/communities',
        headers: { authorization: 'Bearer test-token' },
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{
        communities: { communityDid: string; communityName: string }[]
      }>()
      expect(body.communities).toHaveLength(1)
      expect(body.communities[0].communityName).toBe(COMMUNITY_DID)

      await appWithCommunity.close()
    })

    it('returns 401 when not authenticated', async () => {
      const noAuthApp = await buildTestApp(undefined)

      const response = await noAuthApp.inject({
        method: 'GET',
        url: '/api/users/me/preferences/communities',
      })

      expect(response.statusCode).toBe(401)
      await noAuthApp.close()
    })
  })

  // =========================================================================
  // GET /api/users/me/preferences/communities/:communityDid
  // =========================================================================

  describe('GET /api/users/me/preferences/communities/:communityDid', () => {
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

    it('returns existing community preferences', async () => {
      selectChain.where.mockResolvedValueOnce([
        sampleCommunityPrefsRow({
          maturityOverride: 'mature',
          notificationPrefs: {
            replies: true,
            reactions: false,
            mentions: true,
            modActions: true,
          },
        }),
      ])

      const response = await app.inject({
        method: 'GET',
        url: `/api/users/me/preferences/communities/${COMMUNITY_DID}`,
        headers: { authorization: 'Bearer test-token' },
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{
        communityDid: string
        maturityOverride: string
        notificationPrefs: { replies: boolean }
      }>()
      expect(body.communityDid).toBe(COMMUNITY_DID)
      expect(body.maturityOverride).toBe('mature')
      expect(body.notificationPrefs.replies).toBe(true)
    })

    it('returns defaults when no row exists', async () => {
      selectChain.where.mockResolvedValueOnce([])

      const response = await app.inject({
        method: 'GET',
        url: `/api/users/me/preferences/communities/${COMMUNITY_DID}`,
        headers: { authorization: 'Bearer test-token' },
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{
        communityDid: string
        maturityOverride: null
        mutedWords: null
        notificationPrefs: {
          replies: boolean
          reactions: boolean
          mentions: boolean
          modActions: boolean
        }
      }>()
      expect(body.communityDid).toBe(COMMUNITY_DID)
      expect(body.maturityOverride).toBeNull()
      expect(body.mutedWords).toBeNull()
      expect(body.notificationPrefs).toEqual({
        replies: false,
        reactions: false,
        mentions: true,
        modActions: false,
      })
    })

    it('returns existing values including non-null fields', async () => {
      selectChain.where.mockResolvedValueOnce([
        sampleCommunityPrefsRow({
          maturityOverride: 'sfw',
          mutedWords: ['spam'],
          blockedDids: ['did:plc:blocked1'],
          mutedDids: ['did:plc:muted1'],
          notificationPrefs: {
            replies: true,
            reactions: true,
            mentions: false,
            modActions: true,
          },
        }),
      ])

      const response = await app.inject({
        method: 'GET',
        url: `/api/users/me/preferences/communities/${COMMUNITY_DID}`,
        headers: { authorization: 'Bearer test-token' },
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{
        communityDid: string
        maturityOverride: string | null
        mutedWords: string[] | null
        blockedDids: string[] | null
        mutedDids: string[] | null
        notificationPrefs: {
          replies: boolean
          reactions: boolean
          mentions: boolean
          modActions: boolean
        } | null
        updatedAt: string
      }>()
      expect(body.maturityOverride).toBe('sfw')
      expect(body.mutedWords).toEqual(['spam'])
      expect(body.blockedDids).toEqual(['did:plc:blocked1'])
      expect(body.mutedDids).toEqual(['did:plc:muted1'])
      expect(body.notificationPrefs).toEqual({
        replies: true,
        reactions: true,
        mentions: false,
        modActions: true,
      })
      expect(body.updatedAt).toBe(TEST_NOW)
    })

    it('returns null for undefined community preference fields (fallback via ??)', async () => {
      selectChain.where.mockResolvedValueOnce([
        sampleCommunityPrefsRow({
          maturityOverride: undefined,
          mutedWords: undefined,
          blockedDids: undefined,
          mutedDids: undefined,
          notificationPrefs: undefined,
        }),
      ])

      const response = await app.inject({
        method: 'GET',
        url: `/api/users/me/preferences/communities/${COMMUNITY_DID}`,
        headers: { authorization: 'Bearer test-token' },
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{
        maturityOverride: null
        mutedWords: null
        blockedDids: null
        mutedDids: null
        notificationPrefs: null
      }>()
      expect(body.maturityOverride).toBeNull()
      expect(body.mutedWords).toBeNull()
      expect(body.blockedDids).toBeNull()
      expect(body.mutedDids).toBeNull()
      expect(body.notificationPrefs).toBeNull()
    })

    it('returns 401 when not authenticated', async () => {
      const noAuthApp = await buildTestApp(undefined)

      const response = await noAuthApp.inject({
        method: 'GET',
        url: `/api/users/me/preferences/communities/${COMMUNITY_DID}`,
      })

      expect(response.statusCode).toBe(401)
      await noAuthApp.close()
    })
  })

  // =========================================================================
  // PUT /api/users/me/preferences/communities/:communityDid
  // =========================================================================

  describe('PUT /api/users/me/preferences/communities/:communityDid', () => {
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

    it('upserts community preferences and returns updated values', async () => {
      // After upsert, the select returns updated prefs
      selectChain.where.mockResolvedValueOnce([
        sampleCommunityPrefsRow({
          maturityOverride: 'sfw',
          mutedWords: ['spam'],
        }),
      ])

      const response = await app.inject({
        method: 'PUT',
        url: `/api/users/me/preferences/communities/${COMMUNITY_DID}`,
        headers: { authorization: 'Bearer test-token' },
        payload: {
          maturityOverride: 'sfw',
          mutedWords: ['spam'],
        },
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{
        communityDid: string
        maturityOverride: string
        mutedWords: string[]
      }>()
      expect(body.communityDid).toBe(COMMUNITY_DID)
      expect(body.maturityOverride).toBe('sfw')
      expect(body.mutedWords).toEqual(['spam'])
      expect(mockDb.insert).toHaveBeenCalledOnce()
    })

    it('returns 401 when not authenticated', async () => {
      const noAuthApp = await buildTestApp(undefined)

      const response = await noAuthApp.inject({
        method: 'PUT',
        url: `/api/users/me/preferences/communities/${COMMUNITY_DID}`,
        payload: { maturityOverride: 'sfw' },
      })

      expect(response.statusCode).toBe(401)
      await noAuthApp.close()
    })

    it('returns 400 for invalid maturityOverride', async () => {
      const response = await app.inject({
        method: 'PUT',
        url: `/api/users/me/preferences/communities/${COMMUNITY_DID}`,
        headers: { authorization: 'Bearer test-token' },
        payload: { maturityOverride: 'adult' },
      })

      expect(response.statusCode).toBe(400)
    })

    it('returns defaults when preferences row not found after upsert', async () => {
      // The select after upsert returns empty
      selectChain.where.mockResolvedValueOnce([])

      const response = await app.inject({
        method: 'PUT',
        url: `/api/users/me/preferences/communities/${COMMUNITY_DID}`,
        headers: { authorization: 'Bearer test-token' },
        payload: { maturityOverride: 'sfw' },
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{
        communityDid: string
        maturityOverride: null
        mutedWords: null
        blockedDids: null
        mutedDids: null
        notificationPrefs: {
          replies: boolean
          reactions: boolean
          mentions: boolean
          modActions: boolean
        }
      }>()
      expect(body.communityDid).toBe(COMMUNITY_DID)
      expect(body.maturityOverride).toBeNull()
      expect(body.mutedWords).toBeNull()
      expect(body.notificationPrefs).toEqual({
        replies: false,
        reactions: false,
        mentions: true,
        modActions: false,
      })
    })

    it('only sets maturityOverride when only maturityOverride is provided', async () => {
      selectChain.where.mockResolvedValueOnce([
        sampleCommunityPrefsRow({ maturityOverride: 'mature' }),
      ])

      const response = await app.inject({
        method: 'PUT',
        url: `/api/users/me/preferences/communities/${COMMUNITY_DID}`,
        headers: { authorization: 'Bearer test-token' },
        payload: { maturityOverride: 'mature' },
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{ maturityOverride: string }>()
      expect(body.maturityOverride).toBe('mature')
    })

    it('only sets mutedWords when only mutedWords is provided', async () => {
      selectChain.where.mockResolvedValueOnce([sampleCommunityPrefsRow({ mutedWords: ['spam'] })])

      const response = await app.inject({
        method: 'PUT',
        url: `/api/users/me/preferences/communities/${COMMUNITY_DID}`,
        headers: { authorization: 'Bearer test-token' },
        payload: { mutedWords: ['spam'] },
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{ mutedWords: string[] }>()
      expect(body.mutedWords).toEqual(['spam'])
    })

    it('only sets blockedDids when only blockedDids is provided', async () => {
      selectChain.where.mockResolvedValueOnce([
        sampleCommunityPrefsRow({ blockedDids: ['did:plc:blocked1'] }),
      ])

      const response = await app.inject({
        method: 'PUT',
        url: `/api/users/me/preferences/communities/${COMMUNITY_DID}`,
        headers: { authorization: 'Bearer test-token' },
        payload: { blockedDids: ['did:plc:blocked1'] },
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{ blockedDids: string[] }>()
      expect(body.blockedDids).toEqual(['did:plc:blocked1'])
    })

    it('only sets mutedDids when only mutedDids is provided', async () => {
      selectChain.where.mockResolvedValueOnce([
        sampleCommunityPrefsRow({ mutedDids: ['did:plc:muted1'] }),
      ])

      const response = await app.inject({
        method: 'PUT',
        url: `/api/users/me/preferences/communities/${COMMUNITY_DID}`,
        headers: { authorization: 'Bearer test-token' },
        payload: { mutedDids: ['did:plc:muted1'] },
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{ mutedDids: string[] }>()
      expect(body.mutedDids).toEqual(['did:plc:muted1'])
    })

    it('only sets notificationPrefs when only notificationPrefs is provided', async () => {
      const notifPrefs = {
        replies: false,
        reactions: true,
        mentions: true,
        modActions: false,
      }
      selectChain.where.mockResolvedValueOnce([
        sampleCommunityPrefsRow({ notificationPrefs: notifPrefs }),
      ])

      const response = await app.inject({
        method: 'PUT',
        url: `/api/users/me/preferences/communities/${COMMUNITY_DID}`,
        headers: { authorization: 'Bearer test-token' },
        payload: { notificationPrefs: notifPrefs },
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{
        notificationPrefs: {
          replies: boolean
          reactions: boolean
          mentions: boolean
          modActions: boolean
        }
      }>()
      expect(body.notificationPrefs).toEqual(notifPrefs)
    })

    it('sets all fields when all are provided', async () => {
      const notifPrefs = {
        replies: true,
        reactions: true,
        mentions: true,
        modActions: true,
      }
      selectChain.where.mockResolvedValueOnce([
        sampleCommunityPrefsRow({
          maturityOverride: 'mature',
          mutedWords: ['spoiler'],
          blockedDids: ['did:plc:blocked1'],
          mutedDids: ['did:plc:muted1'],
          notificationPrefs: notifPrefs,
        }),
      ])

      const response = await app.inject({
        method: 'PUT',
        url: `/api/users/me/preferences/communities/${COMMUNITY_DID}`,
        headers: { authorization: 'Bearer test-token' },
        payload: {
          maturityOverride: 'mature',
          mutedWords: ['spoiler'],
          blockedDids: ['did:plc:blocked1'],
          mutedDids: ['did:plc:muted1'],
          notificationPrefs: notifPrefs,
        },
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{
        maturityOverride: string
        mutedWords: string[]
        blockedDids: string[]
        mutedDids: string[]
        notificationPrefs: {
          replies: boolean
          reactions: boolean
          mentions: boolean
          modActions: boolean
        }
      }>()
      expect(body.maturityOverride).toBe('mature')
      expect(body.mutedWords).toEqual(['spoiler'])
      expect(body.blockedDids).toEqual(['did:plc:blocked1'])
      expect(body.mutedDids).toEqual(['did:plc:muted1'])
      expect(body.notificationPrefs).toEqual(notifPrefs)
    })

    it('sets no optional fields when empty body is provided', async () => {
      selectChain.where.mockResolvedValueOnce([sampleCommunityPrefsRow()])

      const response = await app.inject({
        method: 'PUT',
        url: `/api/users/me/preferences/communities/${COMMUNITY_DID}`,
        headers: { authorization: 'Bearer test-token' },
        payload: {},
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{ communityDid: string }>()
      expect(body.communityDid).toBe(COMMUNITY_DID)
    })

    it('allows setting maturityOverride to null', async () => {
      selectChain.where.mockResolvedValueOnce([sampleCommunityPrefsRow({ maturityOverride: null })])

      const response = await app.inject({
        method: 'PUT',
        url: `/api/users/me/preferences/communities/${COMMUNITY_DID}`,
        headers: { authorization: 'Bearer test-token' },
        payload: { maturityOverride: null },
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{ maturityOverride: null }>()
      expect(body.maturityOverride).toBeNull()
    })

    it('allows setting mutedWords to null', async () => {
      selectChain.where.mockResolvedValueOnce([sampleCommunityPrefsRow({ mutedWords: null })])

      const response = await app.inject({
        method: 'PUT',
        url: `/api/users/me/preferences/communities/${COMMUNITY_DID}`,
        headers: { authorization: 'Bearer test-token' },
        payload: { mutedWords: null },
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{ mutedWords: null }>()
      expect(body.mutedWords).toBeNull()
    })

    it('returns null for undefined community preference fields after upsert (fallback via ??)', async () => {
      selectChain.where.mockResolvedValueOnce([
        sampleCommunityPrefsRow({
          maturityOverride: undefined,
          mutedWords: undefined,
          blockedDids: undefined,
          mutedDids: undefined,
          notificationPrefs: undefined,
        }),
      ])

      const response = await app.inject({
        method: 'PUT',
        url: `/api/users/me/preferences/communities/${COMMUNITY_DID}`,
        headers: { authorization: 'Bearer test-token' },
        payload: {},
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{
        maturityOverride: null
        mutedWords: null
        blockedDids: null
        mutedDids: null
        notificationPrefs: null
      }>()
      expect(body.maturityOverride).toBeNull()
      expect(body.mutedWords).toBeNull()
      expect(body.blockedDids).toBeNull()
      expect(body.mutedDids).toBeNull()
      expect(body.notificationPrefs).toBeNull()
    })

    it('returns 400 when Zod validation fails (mutedWords with empty string)', async () => {
      // Passes Fastify JSON schema but fails Zod (.min(1) on string items)
      const response = await app.inject({
        method: 'PUT',
        url: `/api/users/me/preferences/communities/${COMMUNITY_DID}`,
        headers: { authorization: 'Bearer test-token' },
        payload: { mutedWords: [''] },
      })

      expect(response.statusCode).toBe(400)
    })
  })

  // =========================================================================
  // DELETE /api/users/me
  // =========================================================================

  describe('DELETE /api/users/me', () => {
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

    it('deletes all data and returns 204', async () => {
      const response = await app.inject({
        method: 'DELETE',
        url: '/api/users/me',
        headers: { authorization: 'Bearer test-token' },
      })

      expect(response.statusCode).toBe(204)
      // Transaction should be called once
      expect(mockDb.transaction).toHaveBeenCalledOnce()
      // Multiple delete calls within transaction (reactions, notifications x2,
      // reports, replies, topics, community profiles, community prefs, user prefs, users)
      expect(mockDb.delete).toHaveBeenCalled()
      // Check at least 9 delete calls (one per table)
      expect(mockDb.delete.mock.calls.length).toBeGreaterThanOrEqual(9)
    })

    it('returns 401 when not authenticated', async () => {
      const noAuthApp = await buildTestApp(undefined)

      const response = await noAuthApp.inject({
        method: 'DELETE',
        url: '/api/users/me',
      })

      expect(response.statusCode).toBe(401)
      await noAuthApp.close()
    })

    it('logs the GDPR purge with the user DID', async () => {
      await app.inject({
        method: 'DELETE',
        url: '/api/users/me',
        headers: { authorization: 'Bearer test-token' },
      })

      expect(mockLogger.info).toHaveBeenCalledWith(
        { did: TEST_DID },
        'GDPR Art. 17: all indexed data purged for user'
      )
    })
  })

  // =========================================================================
  // Defensive guard tests: !requestUser inside handlers
  // =========================================================================
  // These test the fallback 401 guards inside route handlers that fire when
  // requireAuth somehow passes through without setting request.user.
  // =========================================================================

  describe('defensive !requestUser guards (passthrough auth)', () => {
    let passthroughApp: FastifyInstance

    beforeAll(async () => {
      passthroughApp = await buildPassthroughAuthApp()
    })

    afterAll(async () => {
      await passthroughApp.close()
    })

    beforeEach(() => {
      vi.clearAllMocks()
      resetAllDbMocks()
    })

    it('POST /api/users/me/age-declaration returns 401 when request.user is undefined', async () => {
      const response = await passthroughApp.inject({
        method: 'POST',
        url: '/api/users/me/age-declaration',
        payload: { declaredAge: 18 },
      })

      expect(response.statusCode).toBe(401)
      const body = response.json<{ error: string }>()
      expect(body.error).toBe('Authentication required')
    })

    it('GET /api/users/me/preferences returns 401 when request.user is undefined', async () => {
      const response = await passthroughApp.inject({
        method: 'GET',
        url: '/api/users/me/preferences',
      })

      expect(response.statusCode).toBe(401)
      const body = response.json<{ error: string }>()
      expect(body.error).toBe('Authentication required')
    })

    it('PUT /api/users/me/preferences returns 401 when request.user is undefined', async () => {
      const response = await passthroughApp.inject({
        method: 'PUT',
        url: '/api/users/me/preferences',
        payload: { maturityLevel: 'sfw' },
      })

      expect(response.statusCode).toBe(401)
      const body = response.json<{ error: string }>()
      expect(body.error).toBe('Authentication required')
    })

    it('GET /api/users/me/preferences/communities/:communityDid returns 401 when request.user is undefined', async () => {
      const response = await passthroughApp.inject({
        method: 'GET',
        url: `/api/users/me/preferences/communities/${COMMUNITY_DID}`,
      })

      expect(response.statusCode).toBe(401)
      const body = response.json<{ error: string }>()
      expect(body.error).toBe('Authentication required')
    })

    it('PUT /api/users/me/preferences/communities/:communityDid returns 401 when request.user is undefined', async () => {
      const response = await passthroughApp.inject({
        method: 'PUT',
        url: `/api/users/me/preferences/communities/${COMMUNITY_DID}`,
        payload: { maturityOverride: 'sfw' },
      })

      expect(response.statusCode).toBe(401)
      const body = response.json<{ error: string }>()
      expect(body.error).toBe('Authentication required')
    })

    it('DELETE /api/users/me returns 401 when request.user is undefined', async () => {
      const response = await passthroughApp.inject({
        method: 'DELETE',
        url: '/api/users/me',
      })

      expect(response.statusCode).toBe(401)
      const body = response.json<{ error: string }>()
      expect(body.error).toBe('Authentication required')
    })
  })
})
