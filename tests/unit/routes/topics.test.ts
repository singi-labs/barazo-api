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

// Mock onboarding gate module
const checkOnboardingCompleteFn = vi.fn().mockResolvedValue({ complete: true, missingFields: [] })
vi.mock('../../../src/lib/onboarding-gate.js', () => ({
  checkOnboardingComplete: (...args: unknown[]) => checkOnboardingCompleteFn(...args) as unknown,
}))

// Mock cross-post service module
const crossPostTopicFn = vi.fn().mockResolvedValue(undefined)
const deleteCrossPostsFn = vi.fn().mockResolvedValue(undefined)
vi.mock('../../../src/services/cross-post.js', () => ({
  createCrossPostService: () => ({
    crossPostTopic: crossPostTopicFn,
    deleteCrossPosts: deleteCrossPostsFn,
  }),
}))

// Mock notification service module
const notifyOnMentionsFn = vi.fn().mockResolvedValue(undefined)
vi.mock('../../../src/services/notification.js', () => ({
  createNotificationService: () => ({
    notifyOnMentions: notifyOnMentionsFn,
  }),
}))

// Mock handle-to-DID resolver
const resolveHandleToDidFn = vi.fn<(handle: string) => Promise<string | null>>()
vi.mock('../../../src/lib/resolve-handle-to-did.js', () => ({
  resolveHandleToDid: (...args: unknown[]) => resolveHandleToDidFn(args[0] as string),
}))

// Mock anti-spam module (tested separately in anti-spam.test.ts)
const loadAntiSpamSettingsFn = vi.fn().mockResolvedValue({
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
})
const isNewAccountFn = vi.fn().mockResolvedValue(false)
const isAccountTrustedFn = vi.fn().mockResolvedValue(true)
const checkWriteRateLimitFn = vi.fn().mockResolvedValue(false)
const canCreateTopicFn = vi.fn().mockResolvedValue(true)
const runAntiSpamChecksFn = vi.fn().mockResolvedValue({ held: false, reasons: [] })
vi.mock('../../../src/lib/anti-spam.js', () => ({
  loadAntiSpamSettings: (...args: unknown[]) => loadAntiSpamSettingsFn(...args) as unknown,
  isNewAccount: (...args: unknown[]) => isNewAccountFn(...args) as unknown,
  isAccountTrusted: (...args: unknown[]) => isAccountTrustedFn(...args) as unknown,
  checkWriteRateLimit: (...args: unknown[]) => checkWriteRateLimitFn(...args) as unknown,
  canCreateTopic: (...args: unknown[]) => canCreateTopicFn(...args) as unknown,
  runAntiSpamChecks: (...args: unknown[]) => runAntiSpamChecksFn(...args) as unknown,
}))

// Import routes AFTER mocking
import { topicRoutes } from '../../../src/routes/topics.js'

// ---------------------------------------------------------------------------
// Mock env (minimal subset for topic routes)
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
const TEST_URI = `at://${TEST_DID}/forum.barazo.topic.post/abc123`
const TEST_RKEY = 'abc123'
const TEST_CID = 'bafyreiabc123456789'
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

// ---------------------------------------------------------------------------
// Sample topic row (as returned from DB)
// ---------------------------------------------------------------------------

function sampleTopicRow(overrides?: Record<string, unknown>) {
  return {
    uri: TEST_URI,
    rkey: TEST_RKEY,
    authorDid: TEST_DID,
    title: 'Test Topic Title',
    content: 'Test topic content goes here',
    category: 'general',
    tags: ['test', 'example'],
    communityDid: 'did:plc:community123',
    cid: TEST_CID,
    labels: null,
    replyCount: 0,
    reactionCount: 0,
    isPinned: false,
    isLocked: false,
    pinnedScope: null,
    pinnedAt: null,
    lastActivityAt: new Date(TEST_NOW),
    publishedAt: new Date(TEST_NOW),
    indexedAt: new Date(TEST_NOW),
    embedding: null,
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
  app.addHook('onRequest', (request, _reply, done) => {
    request.communityDid = 'did:plc:test'
    done()
  })

  await app.register(topicRoutes())
  await app.ready()

  return app
}

// ---------------------------------------------------------------------------
// Maturity mock helpers
// ---------------------------------------------------------------------------

/**
 * Set up mock DB responses for maturity filtering queries in GET /api/topics.
 * The handler queries: (1) user profile, (2) allowed categories, then (3) topics.
 * Each query goes through selectChain.where, so we queue mockResolvedValueOnce
 * for the first two, letting the third fall through to the chainable default.
 *
 * @param authenticated - Whether the request user is authenticated (adds user profile query)
 * @param allowedSlugs - Category slugs to return as allowed (default: ["general"])
 */
function setupMaturityMocks(authenticated: boolean, allowedSlugs: string[] = ['general']): void {
  if (authenticated) {
    // User profile query: return a user with safe maturity (age not declared)
    selectChain.where.mockResolvedValueOnce([{ declaredAge: null, maturityPref: 'safe' }])
  }
  // Community settings: ageThreshold
  selectChain.where.mockResolvedValueOnce([{ ageThreshold: 16 }])
  // Categories query: return allowed category slugs
  selectChain.where.mockResolvedValueOnce(allowedSlugs.map((slug) => ({ slug })))
}

// ===========================================================================
// Test suite
// ===========================================================================

describe('topic routes', () => {
  // =========================================================================
  // POST /api/topics
  // =========================================================================

  describe('POST /api/topics', () => {
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
      createRecordFn.mockResolvedValue({ uri: TEST_URI, cid: TEST_CID })
      isTrackedFn.mockResolvedValue(true)
    })

    it('creates a topic and returns 201', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/topics',
        headers: { authorization: 'Bearer test-token' },
        payload: {
          title: 'My First Topic',
          content: 'This is the body of my topic.',
          category: 'general',
          tags: ['hello', 'world'],
        },
      })

      expect(response.statusCode).toBe(201)
      const body = response.json<{ uri: string; cid: string; authorHandle: string }>()
      expect(body.uri).toBe(TEST_URI)
      expect(body.cid).toBe(TEST_CID)
      expect(body.authorHandle).toBe(TEST_HANDLE)

      // Should have called PDS createRecord
      expect(createRecordFn).toHaveBeenCalledOnce()
      expect(createRecordFn.mock.calls[0]?.[0]).toBe(TEST_DID)
      expect(createRecordFn.mock.calls[0]?.[1]).toBe('forum.barazo.topic.post')

      // Should have inserted into DB
      expect(mockDb.insert).toHaveBeenCalledOnce()
    })

    it('creates a topic without optional tags', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/topics',
        headers: { authorization: 'Bearer test-token' },
        payload: {
          title: 'Tagless Topic',
          content: 'No tags here.',
          category: 'support',
        },
      })

      expect(response.statusCode).toBe(201)
    })

    it("tracks new user's repo on first post", async () => {
      isTrackedFn.mockResolvedValue(false)
      trackRepoFn.mockResolvedValue(undefined)

      const response = await app.inject({
        method: 'POST',
        url: '/api/topics',
        headers: { authorization: 'Bearer test-token' },
        payload: {
          title: 'First Post',
          content: 'This is my first ever post.',
          category: 'introductions',
        },
      })

      expect(response.statusCode).toBe(201)
      expect(isTrackedFn).toHaveBeenCalledWith(TEST_DID)
      expect(trackRepoFn).toHaveBeenCalledWith(TEST_DID)
    })

    it('does not track already-tracked user', async () => {
      isTrackedFn.mockResolvedValue(true)

      const response = await app.inject({
        method: 'POST',
        url: '/api/topics',
        headers: { authorization: 'Bearer test-token' },
        payload: {
          title: 'Another Post',
          content: 'Already tracked.',
          category: 'general',
        },
      })

      expect(response.statusCode).toBe(201)
      expect(isTrackedFn).toHaveBeenCalledWith(TEST_DID)
      expect(trackRepoFn).not.toHaveBeenCalled()
    })

    it('returns 400 for missing title', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/topics',
        headers: { authorization: 'Bearer test-token' },
        payload: {
          content: 'No title provided.',
          category: 'general',
        },
      })

      expect(response.statusCode).toBe(400)
    })

    it('returns 400 for missing content', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/topics',
        headers: { authorization: 'Bearer test-token' },
        payload: {
          title: 'No Content',
          category: 'general',
        },
      })

      expect(response.statusCode).toBe(400)
    })

    it('returns 400 for missing category', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/topics',
        headers: { authorization: 'Bearer test-token' },
        payload: {
          title: 'No Category',
          content: 'Missing required field.',
        },
      })

      expect(response.statusCode).toBe(400)
    })

    it('returns 400 for title exceeding max length', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/topics',
        headers: { authorization: 'Bearer test-token' },
        payload: {
          title: 'A'.repeat(201),
          content: 'Valid content.',
          category: 'general',
        },
      })

      expect(response.statusCode).toBe(400)
    })

    it('returns 400 for too many tags', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/topics',
        headers: { authorization: 'Bearer test-token' },
        payload: {
          title: 'Too Many Tags',
          content: 'Tags overload.',
          category: 'general',
          tags: ['a', 'b', 'c', 'd', 'e', 'f'],
        },
      })

      expect(response.statusCode).toBe(400)
    })

    it('returns 400 for empty body', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/topics',
        headers: { authorization: 'Bearer test-token' },
        payload: {},
      })

      expect(response.statusCode).toBe(400)
    })

    it('returns 502 when PDS write fails', async () => {
      createRecordFn.mockRejectedValueOnce(new Error('PDS unreachable'))

      const response = await app.inject({
        method: 'POST',
        url: '/api/topics',
        headers: { authorization: 'Bearer test-token' },
        payload: {
          title: 'PDS Fail Topic',
          content: 'Should fail because PDS is down.',
          category: 'general',
        },
      })

      expect(response.statusCode).toBe(502)
    })

    it('creates a topic with self-labels and includes them in PDS record and DB insert', async () => {
      const labels = { values: [{ val: 'nsfw' }, { val: 'spoiler' }] }

      const response = await app.inject({
        method: 'POST',
        url: '/api/topics',
        headers: { authorization: 'Bearer test-token' },
        payload: {
          title: 'Labeled Topic',
          content: 'This topic has self-labels.',
          category: 'general',
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

    it('creates a topic without labels (backwards compatible)', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/topics',
        headers: { authorization: 'Bearer test-token' },
        payload: {
          title: 'No Labels Topic',
          content: 'This topic has no labels.',
          category: 'general',
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

  describe('POST /api/topics (unauthenticated)', () => {
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
        url: '/api/topics',
        payload: {
          title: 'Unauth Topic',
          content: 'Should not work.',
          category: 'general',
        },
      })

      expect(response.statusCode).toBe(401)
    })
  })

  // =========================================================================
  // GET /api/topics (list)
  // =========================================================================

  describe('GET /api/topics', () => {
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

    it('returns empty list when no topics exist', async () => {
      setupMaturityMocks(true)
      // The list query ends with .limit() -- make it resolve to empty
      selectChain.limit.mockResolvedValueOnce([])

      const response = await app.inject({
        method: 'GET',
        url: '/api/topics',
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{ topics: unknown[]; cursor: string | null }>()
      expect(body.topics).toEqual([])
      expect(body.cursor).toBeNull()
    })

    it('returns topics with pagination cursor', async () => {
      setupMaturityMocks(true)
      // Request limit=2 -> route fetches limit+1=3 items
      // Return 3 items to trigger "hasMore"
      const rows = [
        sampleTopicRow(),
        sampleTopicRow({ uri: `at://${TEST_DID}/forum.barazo.topic.post/def456`, rkey: 'def456' }),
        sampleTopicRow({ uri: `at://${TEST_DID}/forum.barazo.topic.post/ghi789`, rkey: 'ghi789' }),
      ]
      selectChain.limit.mockResolvedValueOnce(rows)

      const response = await app.inject({
        method: 'GET',
        url: '/api/topics?limit=2',
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{ topics: unknown[]; cursor: string | null }>()
      expect(body.topics).toHaveLength(2)
      expect(body.cursor).toBeTruthy()
    })

    it('returns null cursor when fewer items than limit', async () => {
      setupMaturityMocks(true)
      const rows = [sampleTopicRow()]
      selectChain.limit.mockResolvedValueOnce(rows)

      const response = await app.inject({
        method: 'GET',
        url: '/api/topics?limit=25',
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{ topics: unknown[]; cursor: string | null }>()
      expect(body.topics).toHaveLength(1)
      expect(body.cursor).toBeNull()
    })

    it('filters by category', async () => {
      setupMaturityMocks(true, ['general', 'support'])
      selectChain.limit.mockResolvedValueOnce([])

      const response = await app.inject({
        method: 'GET',
        url: '/api/topics?category=support',
      })

      expect(response.statusCode).toBe(200)
      expect(selectChain.where).toHaveBeenCalled()
    })

    it('filters by tag', async () => {
      setupMaturityMocks(true)
      selectChain.limit.mockResolvedValueOnce([])

      const response = await app.inject({
        method: 'GET',
        url: '/api/topics?tag=help',
      })

      expect(response.statusCode).toBe(200)
      expect(selectChain.where).toHaveBeenCalled()
    })

    it('respects custom limit', async () => {
      setupMaturityMocks(true)
      selectChain.limit.mockResolvedValueOnce([])

      const response = await app.inject({
        method: 'GET',
        url: '/api/topics?limit=5',
      })

      expect(response.statusCode).toBe(200)
      expect(selectChain.limit).toHaveBeenCalled()
    })

    it('returns 400 for invalid limit (over max)', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/topics?limit=999',
      })

      expect(response.statusCode).toBe(400)
    })

    it('returns 400 for invalid limit (zero)', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/topics?limit=0',
      })

      expect(response.statusCode).toBe(400)
    })

    it('returns 400 for non-numeric limit', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/topics?limit=abc',
      })

      expect(response.statusCode).toBe(400)
    })

    it('accepts cursor parameter', async () => {
      setupMaturityMocks(true)
      const cursor = Buffer.from(
        JSON.stringify({ lastActivityAt: TEST_NOW, uri: TEST_URI })
      ).toString('base64')
      selectChain.limit.mockResolvedValueOnce([])

      const response = await app.inject({
        method: 'GET',
        url: `/api/topics?cursor=${encodeURIComponent(cursor)}`,
      })

      expect(response.statusCode).toBe(200)
    })

    it('works without authentication (public endpoint)', async () => {
      const noAuthApp = await buildTestApp(undefined)
      setupMaturityMocks(false) // no user profile query when unauthenticated
      selectChain.limit.mockResolvedValueOnce([])

      const response = await noAuthApp.inject({
        method: 'GET',
        url: '/api/topics',
      })

      expect(response.statusCode).toBe(200)
      await noAuthApp.close()
    })

    it('includes labels in topic list response', async () => {
      setupMaturityMocks(true)
      const labels = { values: [{ val: 'nsfw' }] }
      const rows = [
        sampleTopicRow({ labels }),
        sampleTopicRow({
          uri: `at://${TEST_DID}/forum.barazo.topic.post/nolabel`,
          rkey: 'nolabel',
          labels: null,
        }),
      ]
      selectChain.limit.mockResolvedValueOnce(rows)

      const response = await app.inject({
        method: 'GET',
        url: '/api/topics',
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{
        topics: Array<{ uri: string; labels: { values: Array<{ val: string }> } | null }>
      }>()
      expect(body.topics).toHaveLength(2)
      expect(body.topics[0]?.labels).toEqual(labels)
      expect(body.topics[1]?.labels).toBeNull()
    })

    it('excludes topics by blocked users from list', async () => {
      const blockedDid = 'did:plc:blockeduser'

      // Query order for authenticated GET /api/topics:
      // 1. User profile (maturity)
      // 2. Allowed categories (maturity)
      // 3. Block/mute preferences
      // 4. Topics query (limit)
      setupMaturityMocks(true)
      // Block/mute preferences query
      selectChain.where.mockResolvedValueOnce([
        {
          blockedDids: [blockedDid],
          mutedDids: [],
        },
      ])

      // Return only non-blocked topics (the route should have applied the filter)
      const rows = [sampleTopicRow({ authorDid: TEST_DID })]
      selectChain.limit.mockResolvedValueOnce(rows)

      const response = await app.inject({
        method: 'GET',
        url: '/api/topics',
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{ topics: Array<{ authorDid: string; isMuted: boolean }> }>()
      // The blocked user's topics should not appear at all
      expect(body.topics.every((t) => t.authorDid !== blockedDid)).toBe(true)
    })

    it('annotates topics by muted users with isMuted: true', async () => {
      const mutedDid = 'did:plc:muteduser'

      setupMaturityMocks(true)
      // Block/mute preferences query
      selectChain.where.mockResolvedValueOnce([
        {
          blockedDids: [],
          mutedDids: [mutedDid],
        },
      ])

      const rows = [
        sampleTopicRow({
          authorDid: mutedDid,
          uri: `at://${mutedDid}/forum.barazo.topic.post/m1`,
          rkey: 'm1',
        }),
        sampleTopicRow({ authorDid: TEST_DID }),
      ]
      selectChain.limit.mockResolvedValueOnce(rows)

      const response = await app.inject({
        method: 'GET',
        url: '/api/topics',
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{ topics: Array<{ authorDid: string; isMuted: boolean }> }>()
      expect(body.topics).toHaveLength(2)

      const mutedTopic = body.topics.find((t) => t.authorDid === mutedDid)
      const normalTopic = body.topics.find((t) => t.authorDid === TEST_DID)
      expect(mutedTopic?.isMuted).toBe(true)
      expect(normalTopic?.isMuted).toBe(false)
    })

    it('returns isMuted: false for all topics when unauthenticated', async () => {
      const noAuthApp = await buildTestApp(undefined)
      setupMaturityMocks(false) // no user profile query
      // No block/mute preferences query for unauthenticated users

      const rows = [
        sampleTopicRow({ authorDid: TEST_DID }),
        sampleTopicRow({
          authorDid: OTHER_DID,
          uri: `at://${OTHER_DID}/forum.barazo.topic.post/o1`,
          rkey: 'o1',
        }),
      ]
      selectChain.limit.mockResolvedValueOnce(rows)

      const response = await noAuthApp.inject({
        method: 'GET',
        url: '/api/topics',
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{ topics: Array<{ authorDid: string; isMuted: boolean }> }>()
      expect(body.topics).toHaveLength(2)
      expect(body.topics.every((t) => !t.isMuted)).toBe(true)

      await noAuthApp.close()
    })

    it('includes pinned topics in list response with pinned fields', async () => {
      setupMaturityMocks(true)
      const pinnedRow = sampleTopicRow({
        uri: `at://${TEST_DID}/forum.barazo.topic.post/pinned1`,
        rkey: 'pinned1',
        isPinned: true,
        pinnedScope: 'forum',
        pinnedAt: new Date('2026-02-14T00:00:00.000Z'),
      })
      const normalRow = sampleTopicRow({
        uri: `at://${TEST_DID}/forum.barazo.topic.post/normal1`,
        rkey: 'normal1',
        lastActivityAt: new Date('2026-02-15T00:00:00.000Z'),
      })
      selectChain.limit.mockResolvedValueOnce([pinnedRow, normalRow])

      const response = await app.inject({
        method: 'GET',
        url: '/api/topics',
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{
        topics: Array<{
          uri: string
          isPinned: boolean
          pinnedScope: string | null
          pinnedAt: string | null
        }>
      }>()
      expect(body.topics).toHaveLength(2)
      expect(body.topics[0]?.isPinned).toBe(true)
      expect(body.topics[0]?.pinnedScope).toBe('forum')
      expect(body.topics[0]?.pinnedAt).toBe('2026-02-14T00:00:00.000Z')
      expect(body.topics[1]?.isPinned).toBe(false)
      expect(body.topics[1]?.pinnedScope).toBeNull()
    })

    it('calls orderBy for pinned-first sorting', async () => {
      setupMaturityMocks(true)
      selectChain.limit.mockResolvedValueOnce([])

      const response = await app.inject({
        method: 'GET',
        url: '/api/topics',
      })

      expect(response.statusCode).toBe(200)
      // The query chain goes .where().orderBy().limit(), so orderBy must have been called
      expect(selectChain.orderBy).toHaveBeenCalled()
    })

    it('includes author profile in topic response', async () => {
      resetAllDbMocks()
      setupMaturityMocks(true)

      // Topics query (terminal via .limit)
      selectChain.limit.mockResolvedValueOnce([sampleTopicRow({ authorDid: TEST_DID })])

      // After maturity mocks (3 .where calls consumed), 5 more .where calls follow:
      //   4. loadBlockMuteLists .where (terminal)
      //   5. topics .where (chained to .orderBy().limit())
      //   6. loadMutedWords global .where (terminal)
      //   7. loadMutedWords community .where (terminal)
      //   8. resolveAuthors users .where (terminal)
      // We must explicitly mock calls 4-8 so that:
      //   - Call 5 returns the chain (not a Promise) for .orderBy().limit() to work
      //   - Call 8 returns the author user row

      selectChain.where.mockResolvedValueOnce([]) // 4: loadBlockMuteLists

      selectChain.where.mockImplementationOnce(() => selectChain) // 5: topics .where
      selectChain.where.mockResolvedValueOnce([]) // 6: loadMutedWords global
      selectChain.where.mockResolvedValueOnce([]) // 7: loadMutedWords community
      selectChain.where.mockResolvedValueOnce([
        // 8: resolveAuthors users
        {
          did: TEST_DID,
          handle: TEST_HANDLE,
          displayName: 'Jay',
          avatarUrl: 'https://cdn.example.com/jay.jpg',
          bannerUrl: null,
          bio: null,
        },
      ])

      const res = await app.inject({
        method: 'GET',
        url: '/api/topics',
        headers: { authorization: 'Bearer test' },
      })

      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.payload) as { topics: Array<{ author: unknown }> }
      expect(body.topics[0].author).toEqual({
        did: TEST_DID,
        handle: TEST_HANDLE,
        displayName: 'Jay',
        avatarUrl: 'https://cdn.example.com/jay.jpg',
      })
    })
  })

  // =========================================================================
  // GET /api/topics/:uri (single topic)
  // =========================================================================

  describe('GET /api/topics/:uri', () => {
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

    it('returns a single topic by URI', async () => {
      const row = sampleTopicRow()
      // select().from(topics).where() is the terminal call
      selectChain.where.mockResolvedValueOnce([row])

      const encodedUri = encodeURIComponent(TEST_URI)
      const response = await app.inject({
        method: 'GET',
        url: `/api/topics/${encodedUri}`,
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{ uri: string; title: string }>()
      expect(body.uri).toBe(TEST_URI)
      expect(body.title).toBe('Test Topic Title')
    })

    it('enriches author profile in single topic response', async () => {
      const row = sampleTopicRow()
      // 1. find topic
      selectChain.where.mockResolvedValueOnce([row])
      // 2. category maturity rating
      selectChain.where.mockResolvedValueOnce([{ maturityRating: 'safe' }])
      // 3. user profile (maturity)
      selectChain.where.mockResolvedValueOnce([{ declaredAge: null, maturityPref: 'safe' }])
      // 4. age threshold
      selectChain.where.mockResolvedValueOnce([{ ageThreshold: 16 }])
      // 5. resolveAuthors: users table
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
      // 6. resolveAuthors: community profiles
      selectChain.where.mockResolvedValueOnce([])

      const encodedUri = encodeURIComponent(TEST_URI)
      const response = await app.inject({
        method: 'GET',
        url: `/api/topics/${encodedUri}`,
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

    it('returns 404 for non-existent topic', async () => {
      selectChain.where.mockResolvedValueOnce([])

      const encodedUri = encodeURIComponent('at://did:plc:nonexistent/forum.barazo.topic.post/xyz')
      const response = await app.inject({
        method: 'GET',
        url: `/api/topics/${encodedUri}`,
      })

      expect(response.statusCode).toBe(404)
    })

    it('works without authentication (public endpoint)', async () => {
      const noAuthApp = await buildTestApp(undefined)
      selectChain.where.mockResolvedValueOnce([sampleTopicRow()])

      const encodedUri = encodeURIComponent(TEST_URI)
      const response = await noAuthApp.inject({
        method: 'GET',
        url: `/api/topics/${encodedUri}`,
      })

      expect(response.statusCode).toBe(200)
      await noAuthApp.close()
    })

    it('includes labels in single topic response', async () => {
      const labels = { values: [{ val: 'spoiler' }, { val: 'nsfw' }] }
      const row = sampleTopicRow({ labels })
      selectChain.where.mockResolvedValueOnce([row])

      const encodedUri = encodeURIComponent(TEST_URI)
      const response = await app.inject({
        method: 'GET',
        url: `/api/topics/${encodedUri}`,
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{ uri: string; labels: { values: Array<{ val: string }> } }>()
      expect(body.labels).toEqual(labels)
    })

    it('returns null labels when topic has no labels', async () => {
      const row = sampleTopicRow({ labels: null })
      selectChain.where.mockResolvedValueOnce([row])

      const encodedUri = encodeURIComponent(TEST_URI)
      const response = await app.inject({
        method: 'GET',
        url: `/api/topics/${encodedUri}`,
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{ uri: string; labels: null }>()
      expect(body.labels).toBeNull()
    })
  })

  // =========================================================================
  // GET /api/topics/by-rkey/:rkey
  // =========================================================================

  describe('GET /api/topics/by-rkey/:rkey', () => {
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

    it('returns a single topic by rkey', async () => {
      const row = sampleTopicRow()
      // 1. select().from(topics).where(rkey) -> find topic
      selectChain.where.mockResolvedValueOnce([row])
      // 2. select(maturityRating).from(categories).where() -> category lookup
      selectChain.where.mockResolvedValueOnce([{ maturityRating: 'safe' }])
      // 3. select(declaredAge, maturityPref).from(users).where() -> user profile
      selectChain.where.mockResolvedValueOnce([{ declaredAge: null, maturityPref: 'safe' }])
      // 4. select(ageThreshold).from(communitySettings).where() -> age threshold
      selectChain.where.mockResolvedValueOnce([{ ageThreshold: 16 }])

      const response = await app.inject({
        method: 'GET',
        url: '/api/topics/by-rkey/abc123',
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{ uri: string; title: string; rkey: string }>()
      expect(body.uri).toBe(TEST_URI)
      expect(body.title).toBe('Test Topic Title')
    })

    it('enriches author profile in by-rkey response', async () => {
      const row = sampleTopicRow()
      // 1. find topic
      selectChain.where.mockResolvedValueOnce([row])
      // 2. category maturity rating
      selectChain.where.mockResolvedValueOnce([{ maturityRating: 'safe' }])
      // 3. user profile (maturity)
      selectChain.where.mockResolvedValueOnce([{ declaredAge: null, maturityPref: 'safe' }])
      // 4. age threshold
      selectChain.where.mockResolvedValueOnce([{ ageThreshold: 16 }])
      // 5. resolveAuthors: users table
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
      // 6. resolveAuthors: community profiles
      selectChain.where.mockResolvedValueOnce([])

      const response = await app.inject({
        method: 'GET',
        url: '/api/topics/by-rkey/abc123',
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

    it('returns 404 for non-existent rkey', async () => {
      selectChain.where.mockResolvedValueOnce([])

      const response = await app.inject({
        method: 'GET',
        url: '/api/topics/by-rkey/nonexistent',
      })

      expect(response.statusCode).toBe(404)
    })

    it('returns 403 when maturity blocks access for unauthenticated user', async () => {
      const noAuthApp = await buildTestApp(undefined)

      const row = sampleTopicRow({ category: 'mature-cat' })
      // 1. find topic
      selectChain.where.mockResolvedValueOnce([row])
      // 2. category maturity rating: mature
      selectChain.where.mockResolvedValueOnce([{ maturityRating: 'mature' }])
      // 3. no user profile (unauthenticated)
      // 4. age threshold
      selectChain.where.mockResolvedValueOnce([{ ageThreshold: 16 }])

      const response = await noAuthApp.inject({
        method: 'GET',
        url: '/api/topics/by-rkey/abc123',
      })

      expect(response.statusCode).toBe(403)

      await noAuthApp.close()
    })

    it('allows access when user maturity level is sufficient', async () => {
      const row = sampleTopicRow({ category: 'mature-cat' })
      // 1. find topic
      selectChain.where.mockResolvedValueOnce([row])
      // 2. category maturity rating: mature
      selectChain.where.mockResolvedValueOnce([{ maturityRating: 'mature' }])
      // 3. user profile: adult with mature pref
      selectChain.where.mockResolvedValueOnce([{ declaredAge: 18, maturityPref: 'mature' }])
      // 4. age threshold
      selectChain.where.mockResolvedValueOnce([{ ageThreshold: 16 }])

      const response = await app.inject({
        method: 'GET',
        url: '/api/topics/by-rkey/abc123',
      })

      expect(response.statusCode).toBe(200)
    })

    it('works without authentication for safe content', async () => {
      const noAuthApp = await buildTestApp(undefined)

      const row = sampleTopicRow()
      // 1. find topic
      selectChain.where.mockResolvedValueOnce([row])
      // 2. category maturity rating: safe
      selectChain.where.mockResolvedValueOnce([{ maturityRating: 'safe' }])
      // 3. no user profile (unauthenticated)
      // 4. age threshold
      selectChain.where.mockResolvedValueOnce([{ ageThreshold: 16 }])

      const response = await noAuthApp.inject({
        method: 'GET',
        url: '/api/topics/by-rkey/abc123',
      })

      expect(response.statusCode).toBe(200)

      await noAuthApp.close()
    })
  })

  // =========================================================================
  // GET /api/topics/by-author-rkey/:handle/:rkey
  // =========================================================================

  describe('GET /api/topics/by-author-rkey/:handle/:rkey', () => {
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

    it('returns a topic by author handle and rkey', async () => {
      resolveHandleToDidFn.mockResolvedValueOnce(TEST_DID)
      const row = sampleTopicRow()
      // 1. select().from(topics).where(authorDid, rkey) -> find topic
      selectChain.where.mockResolvedValueOnce([row])
      // 2. select(maturityRating).from(categories).where() -> category lookup
      selectChain.where.mockResolvedValueOnce([{ maturityRating: 'safe' }])
      // 3. select(declaredAge, maturityPref).from(users).where() -> user profile
      selectChain.where.mockResolvedValueOnce([{ declaredAge: null, maturityPref: 'safe' }])
      // 4. select(ageThreshold).from(communitySettings).where() -> age threshold
      selectChain.where.mockResolvedValueOnce([{ ageThreshold: 16 }])

      const response = await app.inject({
        method: 'GET',
        url: `/api/topics/by-author-rkey/${TEST_HANDLE}/${TEST_RKEY}`,
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{ uri: string; title: string }>()
      expect(body.uri).toBe(TEST_URI)
      expect(body.title).toBe('Test Topic Title')
    })

    it('returns 404 when handle cannot be resolved', async () => {
      resolveHandleToDidFn.mockResolvedValueOnce(null)

      const response = await app.inject({
        method: 'GET',
        url: '/api/topics/by-author-rkey/unknown.handle/abc123',
      })

      expect(response.statusCode).toBe(404)
    })

    it('returns 404 when topic not found for author', async () => {
      resolveHandleToDidFn.mockResolvedValueOnce(TEST_DID)
      selectChain.where.mockResolvedValueOnce([]) // no topic found

      const response = await app.inject({
        method: 'GET',
        url: `/api/topics/by-author-rkey/${TEST_HANDLE}/nonexistent`,
      })

      expect(response.statusCode).toBe(404)
    })

    it('enriches author profile in by-author-rkey response', async () => {
      resolveHandleToDidFn.mockResolvedValueOnce(TEST_DID)
      const row = sampleTopicRow()
      // 1. find topic by authorDid + rkey
      selectChain.where.mockResolvedValueOnce([row])
      // 2. category maturity rating
      selectChain.where.mockResolvedValueOnce([{ maturityRating: 'safe' }])
      // 3. user profile (maturity)
      selectChain.where.mockResolvedValueOnce([{ declaredAge: null, maturityPref: 'safe' }])
      // 4. age threshold
      selectChain.where.mockResolvedValueOnce([{ ageThreshold: 16 }])
      // 5. resolveAuthors: users table
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
      // 6. resolveAuthors: community profiles
      selectChain.where.mockResolvedValueOnce([])

      const response = await app.inject({
        method: 'GET',
        url: `/api/topics/by-author-rkey/${TEST_HANDLE}/${TEST_RKEY}`,
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

    it('returns 403 when maturity blocks access', async () => {
      const noAuthApp = await buildTestApp(undefined)

      resolveHandleToDidFn.mockResolvedValueOnce(TEST_DID)
      const row = sampleTopicRow({ category: 'mature-cat' })
      selectChain.where.mockResolvedValueOnce([row])
      selectChain.where.mockResolvedValueOnce([{ maturityRating: 'mature' }])
      selectChain.where.mockResolvedValueOnce([{ ageThreshold: 16 }])

      const response = await noAuthApp.inject({
        method: 'GET',
        url: `/api/topics/by-author-rkey/${TEST_HANDLE}/${TEST_RKEY}`,
      })

      expect(response.statusCode).toBe(403)
      await noAuthApp.close()
    })
  })

  // =========================================================================
  // PUT /api/topics/:uri
  // =========================================================================

  describe('PUT /api/topics/:uri', () => {
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
      updateRecordFn.mockResolvedValue({ uri: TEST_URI, cid: 'bafyreinewcid' })
    })

    it('updates a topic when user is the author', async () => {
      const existingRow = sampleTopicRow()
      // First: select().from(topics).where() -> find topic
      selectChain.where.mockResolvedValueOnce([existingRow])
      // Then: update().set().where().returning() -> return updated row
      const updatedRow = { ...existingRow, title: 'Updated Title', cid: 'bafyreinewcid' }
      updateChain.returning.mockResolvedValueOnce([updatedRow])

      const encodedUri = encodeURIComponent(TEST_URI)
      const response = await app.inject({
        method: 'PUT',
        url: `/api/topics/${encodedUri}`,
        headers: { authorization: 'Bearer test-token' },
        payload: {
          title: 'Updated Title',
        },
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{ title: string }>()
      expect(body.title).toBe('Updated Title')
      expect(updateRecordFn).toHaveBeenCalledOnce()
    })

    it('returns 403 when user is not the author', async () => {
      const existingRow = sampleTopicRow({ authorDid: OTHER_DID })
      selectChain.where.mockResolvedValueOnce([existingRow])

      const encodedUri = encodeURIComponent(TEST_URI)
      const response = await app.inject({
        method: 'PUT',
        url: `/api/topics/${encodedUri}`,
        headers: { authorization: 'Bearer test-token' },
        payload: {
          title: 'Attempted Edit',
        },
      })

      expect(response.statusCode).toBe(403)
    })

    it('returns 404 when topic does not exist', async () => {
      selectChain.where.mockResolvedValueOnce([])

      const encodedUri = encodeURIComponent('at://did:plc:nobody/forum.barazo.topic.post/ghost')
      const response = await app.inject({
        method: 'PUT',
        url: `/api/topics/${encodedUri}`,
        headers: { authorization: 'Bearer test-token' },
        payload: {
          title: 'Ghost Topic',
        },
      })

      expect(response.statusCode).toBe(404)
    })

    it('returns 400 for title exceeding max length', async () => {
      const response = await app.inject({
        method: 'PUT',
        url: `/api/topics/${encodeURIComponent(TEST_URI)}`,
        headers: { authorization: 'Bearer test-token' },
        payload: {
          title: 'A'.repeat(201),
        },
      })

      expect(response.statusCode).toBe(400)
    })

    it('returns 502 when PDS update fails', async () => {
      const existingRow = sampleTopicRow()
      selectChain.where.mockResolvedValueOnce([existingRow])
      updateRecordFn.mockRejectedValueOnce(new Error('PDS error'))

      const encodedUri = encodeURIComponent(TEST_URI)
      const response = await app.inject({
        method: 'PUT',
        url: `/api/topics/${encodedUri}`,
        headers: { authorization: 'Bearer test-token' },
        payload: {
          title: 'Will Fail',
        },
      })

      expect(response.statusCode).toBe(502)
    })

    it('accepts empty update (all fields optional)', async () => {
      const existingRow = sampleTopicRow()
      selectChain.where.mockResolvedValueOnce([existingRow])
      updateChain.returning.mockResolvedValueOnce([existingRow])

      const encodedUri = encodeURIComponent(TEST_URI)
      const response = await app.inject({
        method: 'PUT',
        url: `/api/topics/${encodedUri}`,
        headers: { authorization: 'Bearer test-token' },
        payload: {},
      })

      expect(response.statusCode).toBe(200)
    })

    it('updates a topic with self-labels (PDS record + DB)', async () => {
      const existingRow = sampleTopicRow()
      selectChain.where.mockResolvedValueOnce([existingRow])
      const labels = { values: [{ val: 'nsfw' }, { val: 'spoiler' }] }
      const updatedRow = { ...existingRow, labels, cid: 'bafyreinewcid' }
      updateChain.returning.mockResolvedValueOnce([updatedRow])

      const encodedUri = encodeURIComponent(TEST_URI)
      const response = await app.inject({
        method: 'PUT',
        url: `/api/topics/${encodedUri}`,
        headers: { authorization: 'Bearer test-token' },
        payload: { labels },
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
      const existingRow = sampleTopicRow({ labels: existingLabels })
      selectChain.where.mockResolvedValueOnce([existingRow])
      const updatedRow = { ...existingRow, title: 'New Title', cid: 'bafyreinewcid' }
      updateChain.returning.mockResolvedValueOnce([updatedRow])

      const encodedUri = encodeURIComponent(TEST_URI)
      const response = await app.inject({
        method: 'PUT',
        url: `/api/topics/${encodedUri}`,
        headers: { authorization: 'Bearer test-token' },
        payload: { title: 'New Title' },
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

  describe('PUT /api/topics/:uri (unauthenticated)', () => {
    let app: FastifyInstance

    beforeAll(async () => {
      app = await buildTestApp(undefined)
    })

    afterAll(async () => {
      await app.close()
    })

    it('returns 401 without auth', async () => {
      const encodedUri = encodeURIComponent(TEST_URI)
      const response = await app.inject({
        method: 'PUT',
        url: `/api/topics/${encodedUri}`,
        payload: { title: 'Unauth Edit' },
      })

      expect(response.statusCode).toBe(401)
    })
  })

  // =========================================================================
  // DELETE /api/topics/:uri
  // =========================================================================

  describe('DELETE /api/topics/:uri', () => {
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

    it('deletes a topic when user is the author (deletes from PDS + DB)', async () => {
      const existingRow = sampleTopicRow() // authorDid = TEST_DID
      // First select: find topic
      selectChain.where.mockResolvedValueOnce([existingRow])
      // Author === user, so NO second select (no role lookup needed)

      const encodedUri = encodeURIComponent(TEST_URI)
      const response = await app.inject({
        method: 'DELETE',
        url: `/api/topics/${encodedUri}`,
        headers: { authorization: 'Bearer test-token' },
      })

      expect(response.statusCode).toBe(204)

      // Should have deleted from PDS
      expect(deleteRecordFn).toHaveBeenCalledOnce()
      expect(deleteRecordFn.mock.calls[0]?.[0]).toBe(TEST_DID)

      // Should have soft-deleted topic in DB via update (not hard-delete)
      expect(mockDb.update).toHaveBeenCalled()
      // No transaction needed (no cascade delete of replies)
      expect(mockDb.transaction).not.toHaveBeenCalled()
    })

    it('deletes topic as moderator (index-only delete, not from PDS)', async () => {
      const modApp = await buildTestApp(testUser({ did: MOD_DID, handle: 'mod.bsky.social' }))

      const existingRow = sampleTopicRow({ authorDid: OTHER_DID })
      // First select: find topic
      selectChain.where.mockResolvedValueOnce([existingRow])
      // Second select: check user role (moderator is not author)
      selectChain.where.mockResolvedValueOnce([{ did: MOD_DID, role: 'moderator' }])

      const encodedUri = encodeURIComponent(TEST_URI)
      const response = await modApp.inject({
        method: 'DELETE',
        url: `/api/topics/${encodedUri}`,
        headers: { authorization: 'Bearer test-token' },
      })

      expect(response.statusCode).toBe(204)

      // Moderator should NOT delete from PDS
      expect(deleteRecordFn).not.toHaveBeenCalled()

      // But should soft-delete in DB index
      expect(mockDb.update).toHaveBeenCalled()

      await modApp.close()
    })

    it('deletes topic as admin (index-only delete, not from PDS)', async () => {
      const adminApp = await buildTestApp(testUser({ did: MOD_DID, handle: 'admin.bsky.social' }))

      const existingRow = sampleTopicRow({ authorDid: OTHER_DID })
      selectChain.where.mockResolvedValueOnce([existingRow])
      selectChain.where.mockResolvedValueOnce([{ did: MOD_DID, role: 'admin' }])

      const encodedUri = encodeURIComponent(TEST_URI)
      const response = await adminApp.inject({
        method: 'DELETE',
        url: `/api/topics/${encodedUri}`,
        headers: { authorization: 'Bearer test-token' },
      })

      expect(response.statusCode).toBe(204)
      expect(deleteRecordFn).not.toHaveBeenCalled()

      await adminApp.close()
    })

    it('returns 403 when non-author regular user tries to delete', async () => {
      const existingRow = sampleTopicRow({ authorDid: OTHER_DID })
      selectChain.where.mockResolvedValueOnce([existingRow])
      // User role lookup: regular user
      selectChain.where.mockResolvedValueOnce([{ did: TEST_DID, role: 'user' }])

      const encodedUri = encodeURIComponent(TEST_URI)
      const response = await app.inject({
        method: 'DELETE',
        url: `/api/topics/${encodedUri}`,
        headers: { authorization: 'Bearer test-token' },
      })

      expect(response.statusCode).toBe(403)
    })

    it('returns 404 when topic does not exist', async () => {
      selectChain.where.mockResolvedValueOnce([])

      const encodedUri = encodeURIComponent('at://did:plc:nobody/forum.barazo.topic.post/ghost')
      const response = await app.inject({
        method: 'DELETE',
        url: `/api/topics/${encodedUri}`,
        headers: { authorization: 'Bearer test-token' },
      })

      expect(response.statusCode).toBe(404)
    })

    it('returns 502 when PDS delete fails', async () => {
      const existingRow = sampleTopicRow() // author = TEST_DID
      selectChain.where.mockResolvedValueOnce([existingRow])
      deleteRecordFn.mockRejectedValueOnce(new Error('PDS delete failed'))

      const encodedUri = encodeURIComponent(TEST_URI)
      const response = await app.inject({
        method: 'DELETE',
        url: `/api/topics/${encodedUri}`,
        headers: { authorization: 'Bearer test-token' },
      })

      expect(response.statusCode).toBe(502)
    })
  })

  describe('DELETE /api/topics/:uri (unauthenticated)', () => {
    let app: FastifyInstance

    beforeAll(async () => {
      app = await buildTestApp(undefined)
    })

    afterAll(async () => {
      await app.close()
    })

    it('returns 401 without auth', async () => {
      const encodedUri = encodeURIComponent(TEST_URI)
      const response = await app.inject({
        method: 'DELETE',
        url: `/api/topics/${encodedUri}`,
        headers: {},
      })

      expect(response.statusCode).toBe(401)
    })
  })

  // =========================================================================
  // GET /api/topics (global mode)
  // =========================================================================

  describe('GET /api/topics (global mode)', () => {
    const globalMockEnv = {
      ...mockEnv,
      COMMUNITY_MODE: 'multi' as const,
      COMMUNITY_DID: undefined,
    } as Env

    let app: FastifyInstance

    async function buildGlobalTestApp(user?: RequestUser): Promise<FastifyInstance> {
      const globalApp = Fastify({ logger: false })

      globalApp.decorate('db', mockDb as never)
      globalApp.decorate('env', globalMockEnv)
      globalApp.decorate('authMiddleware', createMockAuthMiddleware(user))
      globalApp.decorate('firehose', mockFirehose as never)
      globalApp.decorate('oauthClient', {} as never)
      globalApp.decorate('sessionService', {} as SessionService)
      globalApp.decorate('setupService', {} as SetupService)
      globalApp.decorate('cache', {} as never)
      globalApp.decorateRequest('user', undefined as RequestUser | undefined)
      globalApp.decorateRequest('communityDid', undefined as string | undefined)
      globalApp.addHook('onRequest', (request, _reply, done) => {
        request.communityDid = 'did:plc:test'
        done()
      })

      await globalApp.register(topicRoutes())
      await globalApp.ready()

      return globalApp
    }

    /**
     * Set up mock DB responses for global-mode GET /api/topics.
     *
     * Query order:
     * 1. (if authenticated) User profile query -> selectChain.where
     * 2. Community settings ageThreshold query -> selectChain.where
     * 3. Community settings query -> selectChain.where (with isNotNull filter)
     * 4. Category slugs query -> selectChain.where (categories by community + maturity)
     * 5. (if authenticated) Block/mute preferences -> selectChain.where
     * 6. Topics query -> selectChain.limit
     */
    function setupGlobalMaturityMocks(opts: {
      authenticated: boolean
      userProfile?: { declaredAge: number | null; maturityPref: string }
      communities: Array<{ communityDid: string | null; maturityRating: string }>
      categorySlugs: string[]
    }): void {
      if (opts.authenticated) {
        // User profile query
        const profile = opts.userProfile ?? { declaredAge: null, maturityPref: 'safe' }
        selectChain.where.mockResolvedValueOnce([profile])
      }
      // Community settings: ageThreshold
      selectChain.where.mockResolvedValueOnce([{ ageThreshold: 16 }])
      // Community settings query (all communities)
      selectChain.where.mockResolvedValueOnce(opts.communities)
      // Category slugs query (filtered by allowed communities + maturity)
      selectChain.where.mockResolvedValueOnce(opts.categorySlugs.map((slug) => ({ slug })))
    }

    beforeAll(async () => {
      app = await buildGlobalTestApp(testUser())
    })

    afterAll(async () => {
      await app.close()
    })

    beforeEach(() => {
      vi.clearAllMocks()
      resetAllDbMocks()
    })

    it('excludes topics from adult-rated communities in global mode', async () => {
      setupGlobalMaturityMocks({
        authenticated: true,
        userProfile: { declaredAge: 18, maturityPref: 'adult' },
        communities: [
          { communityDid: 'did:plc:sfw-community', maturityRating: 'safe' },
          { communityDid: 'did:plc:adult-community', maturityRating: 'adult' },
        ],
        categorySlugs: ['general'],
      })
      // Topics query: return one topic from the SFW community
      const rows = [sampleTopicRow({ communityDid: 'did:plc:sfw-community' })]
      selectChain.limit.mockResolvedValueOnce(rows)

      const response = await app.inject({
        method: 'GET',
        url: '/api/topics',
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{ topics: Array<{ communityDid: string }> }>()
      // Adult community topics should not be present
      expect(body.topics.every((t) => t.communityDid !== 'did:plc:adult-community')).toBe(true)
      expect(body.topics).toHaveLength(1)
    })

    it('excludes mature-rated communities for SFW-only users', async () => {
      setupGlobalMaturityMocks({
        authenticated: true,
        userProfile: { declaredAge: null, maturityPref: 'safe' },
        communities: [
          { communityDid: 'did:plc:sfw-community', maturityRating: 'safe' },
          { communityDid: 'did:plc:mature-community', maturityRating: 'mature' },
        ],
        categorySlugs: ['general'],
      })
      // Topics from SFW community only
      const rows = [sampleTopicRow({ communityDid: 'did:plc:sfw-community' })]
      selectChain.limit.mockResolvedValueOnce(rows)

      const response = await app.inject({
        method: 'GET',
        url: '/api/topics',
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{ topics: Array<{ communityDid: string }> }>()
      expect(body.topics.every((t) => t.communityDid !== 'did:plc:mature-community')).toBe(true)
      expect(body.topics).toHaveLength(1)
    })

    it('includes mature-rated communities for users with mature preference', async () => {
      setupGlobalMaturityMocks({
        authenticated: true,
        userProfile: { declaredAge: 18, maturityPref: 'mature' },
        communities: [
          { communityDid: 'did:plc:sfw-community', maturityRating: 'safe' },
          { communityDid: 'did:plc:mature-community', maturityRating: 'mature' },
        ],
        categorySlugs: ['general', 'nsfw-general'],
      })
      // Topics from both allowed communities
      const rows = [
        sampleTopicRow({ communityDid: 'did:plc:sfw-community' }),
        sampleTopicRow({
          communityDid: 'did:plc:mature-community',
          uri: `at://${TEST_DID}/forum.barazo.topic.post/mature1`,
          rkey: 'mature1',
        }),
      ]
      selectChain.limit.mockResolvedValueOnce(rows)

      const response = await app.inject({
        method: 'GET',
        url: '/api/topics',
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{ topics: Array<{ communityDid: string }> }>()
      expect(body.topics).toHaveLength(2)
      const communityDids = body.topics.map((t) => t.communityDid)
      expect(communityDids).toContain('did:plc:sfw-community')
      expect(communityDids).toContain('did:plc:mature-community')
    })

    it('always includes SFW communities in global mode', async () => {
      const noAuthApp = await buildGlobalTestApp(undefined)

      setupGlobalMaturityMocks({
        authenticated: false,
        communities: [
          { communityDid: 'did:plc:sfw1', maturityRating: 'safe' },
          { communityDid: 'did:plc:sfw2', maturityRating: 'safe' },
          { communityDid: 'did:plc:mature1', maturityRating: 'mature' },
        ],
        categorySlugs: ['general', 'support'],
      })
      const rows = [
        sampleTopicRow({ communityDid: 'did:plc:sfw1' }),
        sampleTopicRow({
          communityDid: 'did:plc:sfw2',
          uri: `at://${TEST_DID}/forum.barazo.topic.post/sfw2topic`,
          rkey: 'sfw2topic',
        }),
      ]
      selectChain.limit.mockResolvedValueOnce(rows)

      const response = await noAuthApp.inject({
        method: 'GET',
        url: '/api/topics',
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{ topics: Array<{ communityDid: string }> }>()
      expect(body.topics).toHaveLength(2)
      const communityDids = body.topics.map((t) => t.communityDid)
      expect(communityDids).toContain('did:plc:sfw1')
      expect(communityDids).toContain('did:plc:sfw2')

      await noAuthApp.close()
    })

    it('excludes adult communities even for users with adult maturity level', async () => {
      setupGlobalMaturityMocks({
        authenticated: true,
        userProfile: { declaredAge: 18, maturityPref: 'adult' },
        communities: [
          { communityDid: 'did:plc:sfw-community', maturityRating: 'safe' },
          { communityDid: 'did:plc:adult-community', maturityRating: 'adult' },
        ],
        categorySlugs: ['general'],
      })
      const rows = [sampleTopicRow({ communityDid: 'did:plc:sfw-community' })]
      selectChain.limit.mockResolvedValueOnce(rows)

      const response = await app.inject({
        method: 'GET',
        url: '/api/topics',
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{ topics: Array<{ communityDid: string }> }>()
      // Even though user has adult maturity, adult communities are NEVER shown in global mode
      expect(body.topics.every((t) => t.communityDid !== 'did:plc:adult-community')).toBe(true)
    })

    it('returns empty result when no communities pass the filter', async () => {
      // In global mode, when all communities are adult-rated, the handler
      // should return early without even querying categories or topics.
      // unauthenticated user: no user profile query
      const noAuthApp = await buildGlobalTestApp(undefined)

      // Community settings query: only adult community
      selectChain.where.mockResolvedValueOnce([
        { communityDid: 'did:plc:adult-only', maturityRating: 'adult' },
      ])
      // No further mocks needed -- handler should return early

      const response = await noAuthApp.inject({
        method: 'GET',
        url: '/api/topics',
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{ topics: unknown[]; cursor: string | null }>()
      expect(body.topics).toEqual([])
      expect(body.cursor).toBeNull()

      await noAuthApp.close()
    })

    it('returns empty result when no categories pass the maturity filter in global mode', async () => {
      setupGlobalMaturityMocks({
        authenticated: true,
        userProfile: { declaredAge: null, maturityPref: 'safe' },
        communities: [{ communityDid: 'did:plc:sfw-community', maturityRating: 'safe' }],
        categorySlugs: [], // No categories pass the filter
      })

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
  // Additional branch coverage tests
  // =========================================================================

  // -------------------------------------------------------------------------
  // POST /api/topics - onboarding, maturity, anti-spam, held content branches
  // -------------------------------------------------------------------------

  describe('POST /api/topics (onboarding gate)', () => {
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
      createRecordFn.mockResolvedValue({ uri: TEST_URI, cid: TEST_CID })
      isTrackedFn.mockResolvedValue(true)
    })

    it('returns 403 when onboarding is incomplete', async () => {
      checkOnboardingCompleteFn.mockResolvedValueOnce({
        complete: false,
        missingFields: [{ id: 'bio', label: 'Bio', fieldType: 'text' }],
      })

      const response = await app.inject({
        method: 'POST',
        url: '/api/topics',
        headers: { authorization: 'Bearer test-token' },
        payload: {
          title: 'Onboarding Blocked',
          content: 'Should not work.',
          category: 'general',
        },
      })

      expect(response.statusCode).toBe(403)
      const body = response.json<{ error: string }>()
      expect(body.error).toBe('Onboarding required')
    })
  })

  describe('POST /api/topics (maturity restriction on create)', () => {
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
      createRecordFn.mockResolvedValue({ uri: TEST_URI, cid: TEST_CID })
      isTrackedFn.mockResolvedValue(true)
    })

    it('returns 403 when user maturity level is insufficient for category', async () => {
      // Onboarding passes
      checkOnboardingCompleteFn.mockResolvedValueOnce({ complete: true, missingFields: [] })
      // Category maturity query: category is "mature"
      selectChain.where.mockResolvedValueOnce([{ maturityRating: 'mature' }])
      // User profile: no age declared -> safe only
      selectChain.where.mockResolvedValueOnce([{ declaredAge: null, maturityPref: 'safe' }])
      // Community settings: age threshold
      selectChain.where.mockResolvedValueOnce([{ ageThreshold: 16 }])

      const response = await app.inject({
        method: 'POST',
        url: '/api/topics',
        headers: { authorization: 'Bearer test-token' },
        payload: {
          title: 'Mature Topic',
          content: 'Content for mature category.',
          category: 'mature-category',
        },
      })

      expect(response.statusCode).toBe(403)
    })

    it('defaults category maturity to safe when category not found', async () => {
      // Onboarding passes
      checkOnboardingCompleteFn.mockResolvedValueOnce({ complete: true, missingFields: [] })
      // Category maturity query: empty (no category found) -> defaults to 'safe'
      selectChain.where.mockResolvedValueOnce([])
      // User profile query
      selectChain.where.mockResolvedValueOnce([{ declaredAge: null, maturityPref: 'safe' }])
      // Community settings: age threshold
      selectChain.where.mockResolvedValueOnce([{ ageThreshold: 16 }])

      const response = await app.inject({
        method: 'POST',
        url: '/api/topics',
        headers: { authorization: 'Bearer test-token' },
        payload: {
          title: 'Topic in Missing Category',
          content: 'Should still work because safe is default.',
          category: 'nonexistent',
        },
      })

      // Safe user + safe default = allowed
      expect(response.statusCode).toBe(201)
    })

    it('defaults user profile to undefined when no user row exists', async () => {
      // Onboarding passes
      checkOnboardingCompleteFn.mockResolvedValueOnce({ complete: true, missingFields: [] })
      // Category maturity query: safe
      selectChain.where.mockResolvedValueOnce([{ maturityRating: 'safe' }])
      // User profile query: empty (no user row) -> undefined -> safe
      selectChain.where.mockResolvedValueOnce([])
      // Community settings: age threshold
      selectChain.where.mockResolvedValueOnce([{ ageThreshold: 16 }])

      const response = await app.inject({
        method: 'POST',
        url: '/api/topics',
        headers: { authorization: 'Bearer test-token' },
        payload: {
          title: 'Topic from Unknown User Profile',
          content: 'Should still work for safe category.',
          category: 'general',
        },
      })

      expect(response.statusCode).toBe(201)
    })

    it('defaults age threshold to 16 when no community settings exist', async () => {
      // Onboarding passes
      checkOnboardingCompleteFn.mockResolvedValueOnce({ complete: true, missingFields: [] })
      // Category maturity query: safe
      selectChain.where.mockResolvedValueOnce([{ maturityRating: 'safe' }])
      // User profile
      selectChain.where.mockResolvedValueOnce([{ declaredAge: 15, maturityPref: 'mature' }])
      // Community settings: empty (no settings row)
      selectChain.where.mockResolvedValueOnce([])

      const response = await app.inject({
        method: 'POST',
        url: '/api/topics',
        headers: { authorization: 'Bearer test-token' },
        payload: {
          title: 'Topic from Underage User',
          content: 'User is under default threshold of 16.',
          category: 'general',
        },
      })

      // User age 15 < default threshold 16 -> safe only -> can post to safe category
      expect(response.statusCode).toBe(201)
    })
  })

  describe('POST /api/topics (anti-spam untrusted path)', () => {
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
      createRecordFn.mockResolvedValue({ uri: TEST_URI, cid: TEST_CID })
      isTrackedFn.mockResolvedValue(true)
      checkOnboardingCompleteFn.mockResolvedValue({ complete: true, missingFields: [] })
    })

    it('returns 429 when untrusted user hits write rate limit', async () => {
      isAccountTrustedFn.mockResolvedValueOnce(false)
      isNewAccountFn.mockResolvedValueOnce(true)
      checkWriteRateLimitFn.mockResolvedValueOnce(true)

      const response = await app.inject({
        method: 'POST',
        url: '/api/topics',
        headers: { authorization: 'Bearer test-token' },
        payload: {
          title: 'Rate Limited',
          content: 'Should hit rate limit.',
          category: 'general',
        },
      })

      expect(response.statusCode).toBe(429)
    })

    it('returns 403 when topic creation delay blocks new accounts', async () => {
      isAccountTrustedFn.mockResolvedValueOnce(false)
      isNewAccountFn.mockResolvedValueOnce(true)
      checkWriteRateLimitFn.mockResolvedValueOnce(false)
      loadAntiSpamSettingsFn.mockResolvedValueOnce({
        wordFilter: [],
        firstPostQueueCount: 3,
        newAccountDays: 7,
        newAccountWriteRatePerMin: 3,
        establishedWriteRatePerMin: 10,
        linkHoldEnabled: true,
        topicCreationDelayEnabled: true,
        burstPostCount: 5,
        burstWindowMinutes: 10,
        trustedPostThreshold: 10,
      })
      canCreateTopicFn.mockResolvedValueOnce(false)

      const response = await app.inject({
        method: 'POST',
        url: '/api/topics',
        headers: { authorization: 'Bearer test-token' },
        payload: {
          title: 'Delayed',
          content: 'New account without approved replies.',
          category: 'general',
        },
      })

      expect(response.statusCode).toBe(403)
    })

    it('allows untrusted user to create topic when rate limit and delay pass', async () => {
      isAccountTrustedFn.mockResolvedValueOnce(false)
      isNewAccountFn.mockResolvedValueOnce(false)
      checkWriteRateLimitFn.mockResolvedValueOnce(false)

      const response = await app.inject({
        method: 'POST',
        url: '/api/topics',
        headers: { authorization: 'Bearer test-token' },
        payload: {
          title: 'Untrusted But OK',
          content: 'Passes rate limit and delay checks.',
          category: 'general',
        },
      })

      expect(response.statusCode).toBe(201)
    })
  })

  describe('POST /api/topics (content held for moderation)', () => {
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
      createRecordFn.mockResolvedValue({ uri: TEST_URI, cid: TEST_CID })
      isTrackedFn.mockResolvedValue(true)
      checkOnboardingCompleteFn.mockResolvedValue({ complete: true, missingFields: [] })
    })

    it('creates topic with held status when anti-spam flags content', async () => {
      runAntiSpamChecksFn.mockResolvedValueOnce({
        held: true,
        reasons: [
          { reason: 'word_filter', matchedWords: ['spam'] },
          { reason: 'first_post_queue' },
        ],
      })

      const response = await app.inject({
        method: 'POST',
        url: '/api/topics',
        headers: { authorization: 'Bearer test-token' },
        payload: {
          title: 'Spam Topic',
          content: 'This contains spam words.',
          category: 'general',
        },
      })

      expect(response.statusCode).toBe(201)
      const body = response.json<{ moderationStatus: string }>()
      expect(body.moderationStatus).toBe('held')

      // Should have inserted moderation queue entries
      expect(mockDb.insert).toHaveBeenCalledTimes(2) // topics + moderationQueue
    })

    it('does not cross-post when content is held', async () => {
      runAntiSpamChecksFn.mockResolvedValueOnce({
        held: true,
        reasons: [{ reason: 'word_filter', matchedWords: ['spam'] }],
      })

      const response = await app.inject({
        method: 'POST',
        url: '/api/topics',
        headers: { authorization: 'Bearer test-token' },
        payload: {
          title: 'Held Topic',
          content: 'Will be held.',
          category: 'general',
        },
      })

      expect(response.statusCode).toBe(201)
      // Cross-posting should NOT be called for held content
      expect(crossPostTopicFn).not.toHaveBeenCalled()
      // Mention notifications should NOT be called for held content
      expect(notifyOnMentionsFn).not.toHaveBeenCalled()
    })

    it('fires cross-post when content is approved and feature flags are set', async () => {
      const crossPostApp = Fastify({ logger: false })
      const crossPostEnv = {
        ...mockEnv,
        FEATURE_CROSSPOST_BLUESKY: true,
        FEATURE_CROSSPOST_FRONTPAGE: false,
      } as Env

      crossPostApp.decorate('db', mockDb as never)
      crossPostApp.decorate('env', crossPostEnv)
      crossPostApp.decorate('authMiddleware', createMockAuthMiddleware(testUser()))
      crossPostApp.decorate('firehose', mockFirehose as never)
      crossPostApp.decorate('oauthClient', {} as never)
      crossPostApp.decorate('sessionService', {} as SessionService)
      crossPostApp.decorate('setupService', {} as SetupService)
      crossPostApp.decorate('cache', {} as never)
      crossPostApp.decorateRequest('user', undefined as RequestUser | undefined)
      crossPostApp.decorateRequest('communityDid', undefined as string | undefined)
      crossPostApp.addHook('onRequest', (request, _reply, done) => {
        request.communityDid = 'did:plc:test'
        done()
      })
      await crossPostApp.register(topicRoutes())
      await crossPostApp.ready()

      runAntiSpamChecksFn.mockResolvedValueOnce({ held: false, reasons: [] })

      const response = await crossPostApp.inject({
        method: 'POST',
        url: '/api/topics',
        headers: { authorization: 'Bearer test-token' },
        payload: {
          title: 'Cross-Posted Topic',
          content: 'This will be cross-posted.',
          category: 'general',
        },
      })

      expect(response.statusCode).toBe(201)
      expect(crossPostTopicFn).toHaveBeenCalledOnce()
      expect(notifyOnMentionsFn).toHaveBeenCalledOnce()

      await crossPostApp.close()
    })
  })

  describe('POST /api/topics (PDS and DB error branches)', () => {
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
      checkOnboardingCompleteFn.mockResolvedValue({ complete: true, missingFields: [] })
    })

    it('re-throws PDS error that has statusCode property', async () => {
      const pdsError = new Error('Forbidden') as Error & { statusCode: number }
      pdsError.statusCode = 403
      createRecordFn.mockRejectedValueOnce(pdsError)

      const response = await app.inject({
        method: 'POST',
        url: '/api/topics',
        headers: { authorization: 'Bearer test-token' },
        payload: {
          title: 'PDS Error With Status',
          content: 'Should re-throw.',
          category: 'general',
        },
      })

      expect(response.statusCode).toBe(403)
    })

    it('returns 500 when local DB insert fails', async () => {
      createRecordFn.mockResolvedValueOnce({ uri: TEST_URI, cid: TEST_CID })
      // Make the insert chain throw on the values call
      insertChain.values.mockImplementationOnce(() => {
        throw new Error('DB insert failed')
      })

      const response = await app.inject({
        method: 'POST',
        url: '/api/topics',
        headers: { authorization: 'Bearer test-token' },
        payload: {
          title: 'DB Fail Topic',
          content: 'Should fail on DB insert.',
          category: 'general',
        },
      })

      expect(response.statusCode).toBe(500)
    })

    it('re-throws DB error that has statusCode property', async () => {
      createRecordFn.mockResolvedValueOnce({ uri: TEST_URI, cid: TEST_CID })
      const dbError = new Error('Not found') as Error & { statusCode: number }
      dbError.statusCode = 404
      insertChain.values.mockImplementationOnce(() => {
        throw dbError
      })

      const response = await app.inject({
        method: 'POST',
        url: '/api/topics',
        headers: { authorization: 'Bearer test-token' },
        payload: {
          title: 'DB Error Rethrow',
          content: 'Should re-throw statusCode error.',
          category: 'general',
        },
      })

      expect(response.statusCode).toBe(404)
    })
  })

  describe('POST /api/topics (ozone spam label)', () => {
    let app: FastifyInstance

    beforeAll(async () => {
      const ozoneApp = Fastify({ logger: false })
      ozoneApp.decorate('db', mockDb as never)
      ozoneApp.decorate('env', mockEnv)
      ozoneApp.decorate('authMiddleware', createMockAuthMiddleware(testUser()))
      ozoneApp.decorate('firehose', mockFirehose as never)
      ozoneApp.decorate('oauthClient', {} as never)
      ozoneApp.decorate('sessionService', {} as SessionService)
      ozoneApp.decorate('setupService', {} as SetupService)
      ozoneApp.decorate('cache', {} as never)
      ozoneApp.decorate('ozoneService', {
        isSpamLabeled: vi.fn().mockResolvedValue(true),
        batchIsSpamLabeled: vi.fn().mockResolvedValue(new Map()),
      } as never)
      ozoneApp.decorateRequest('user', undefined as RequestUser | undefined)
      ozoneApp.decorateRequest('communityDid', undefined as string | undefined)
      ozoneApp.addHook('onRequest', (request, _reply, done) => {
        request.communityDid = 'did:plc:test'
        done()
      })
      await ozoneApp.register(topicRoutes())
      await ozoneApp.ready()
      app = ozoneApp
    })

    afterAll(async () => {
      await app.close()
    })

    beforeEach(() => {
      vi.clearAllMocks()
      resetAllDbMocks()
      createRecordFn.mockResolvedValue({ uri: TEST_URI, cid: TEST_CID })
      isTrackedFn.mockResolvedValue(true)
      checkOnboardingCompleteFn.mockResolvedValue({ complete: true, missingFields: [] })
    })

    it('applies stricter rate limits for ozone spam-labeled accounts', async () => {
      // When ozoneSpamLabeled is true:
      // - isAccountTrusted returns false (because ozoneSpamLabeled negates trust)
      // - isNewAccount is skipped; isNew is set to true due to ozoneSpamLabeled
      // The user is untrusted, and treated as new, so rate limit check fires
      isAccountTrustedFn.mockResolvedValueOnce(true) // trust check returns true but ozoneSpamLabeled overrides
      checkWriteRateLimitFn.mockResolvedValueOnce(true) // rate limited

      const response = await app.inject({
        method: 'POST',
        url: '/api/topics',
        headers: { authorization: 'Bearer test-token' },
        payload: {
          title: 'Ozone Spam User',
          content: 'Should be rate limited.',
          category: 'general',
        },
      })

      // ozoneSpamLabeled=true -> trusted = false (because !ozoneSpamLabeled && ...) -> untrusted path
      // ozoneSpamLabeled=true -> isNew=true -> stricter rate limits
      expect(response.statusCode).toBe(429)
    })
  })

  // -------------------------------------------------------------------------
  // GET /api/topics - cursor, ozone, serialization branches
  // -------------------------------------------------------------------------

  describe('GET /api/topics (cursor edge cases)', () => {
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

    it('ignores invalid base64 cursor gracefully', async () => {
      setupMaturityMocks(true)
      selectChain.limit.mockResolvedValueOnce([])

      const response = await app.inject({
        method: 'GET',
        url: '/api/topics?cursor=not-valid-base64!!!',
      })

      // Should not fail -- invalid cursor is silently ignored
      expect(response.statusCode).toBe(200)
    })

    it('ignores cursor with missing fields in JSON', async () => {
      setupMaturityMocks(true)
      selectChain.limit.mockResolvedValueOnce([])

      // Valid base64 but JSON lacks required fields
      const cursor = Buffer.from(JSON.stringify({ foo: 'bar' })).toString('base64')
      const response = await app.inject({
        method: 'GET',
        url: `/api/topics?cursor=${encodeURIComponent(cursor)}`,
      })

      expect(response.statusCode).toBe(200)
    })

    it('ignores cursor with non-string fields', async () => {
      setupMaturityMocks(true)
      selectChain.limit.mockResolvedValueOnce([])

      // Valid base64 but fields are wrong types
      const cursor = Buffer.from(JSON.stringify({ lastActivityAt: 123, uri: true })).toString(
        'base64'
      )
      const response = await app.inject({
        method: 'GET',
        url: `/api/topics?cursor=${encodeURIComponent(cursor)}`,
      })

      expect(response.statusCode).toBe(200)
    })
  })

  describe('GET /api/topics (ozone annotation)', () => {
    let app: FastifyInstance
    const batchIsSpamLabeledFn = vi.fn()

    beforeAll(async () => {
      const ozoneApp = Fastify({ logger: false })
      ozoneApp.decorate('db', mockDb as never)
      ozoneApp.decorate('env', mockEnv)
      ozoneApp.decorate('authMiddleware', createMockAuthMiddleware(testUser()))
      ozoneApp.decorate('firehose', mockFirehose as never)
      ozoneApp.decorate('oauthClient', {} as never)
      ozoneApp.decorate('sessionService', {} as SessionService)
      ozoneApp.decorate('setupService', {} as SetupService)
      ozoneApp.decorate('cache', {} as never)
      ozoneApp.decorate('ozoneService', {
        isSpamLabeled: vi.fn(),
        batchIsSpamLabeled: batchIsSpamLabeledFn,
      } as never)
      ozoneApp.decorateRequest('user', undefined as RequestUser | undefined)
      ozoneApp.decorateRequest('communityDid', undefined as string | undefined)
      ozoneApp.addHook('onRequest', (request, _reply, done) => {
        request.communityDid = 'did:plc:test'
        done()
      })
      await ozoneApp.register(topicRoutes())
      await ozoneApp.ready()
      app = ozoneApp
    })

    afterAll(async () => {
      await app.close()
    })

    beforeEach(() => {
      vi.clearAllMocks()
      resetAllDbMocks()
    })

    it('annotates topics with ozoneLabel: spam for spam-labeled authors', async () => {
      setupMaturityMocks(true)

      const spamDid = 'did:plc:spammer'
      batchIsSpamLabeledFn.mockResolvedValueOnce(
        new Map([
          [spamDid, true],
          [TEST_DID, false],
        ])
      )

      const rows = [
        sampleTopicRow({
          authorDid: spamDid,
          uri: `at://${spamDid}/forum.barazo.topic.post/s1`,
          rkey: 's1',
        }),
        sampleTopicRow({ authorDid: TEST_DID }),
      ]
      selectChain.limit.mockResolvedValueOnce(rows)

      const response = await app.inject({
        method: 'GET',
        url: '/api/topics',
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{
        topics: Array<{ authorDid: string; ozoneLabel: string | null }>
      }>()
      expect(body.topics).toHaveLength(2)
      const spamTopic = body.topics.find((t) => t.authorDid === spamDid)
      const normalTopic = body.topics.find((t) => t.authorDid === TEST_DID)
      expect(spamTopic?.ozoneLabel).toBe('spam')
      expect(normalTopic?.ozoneLabel).toBeNull()
    })
  })

  describe('GET /api/topics (serialization branches)', () => {
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

    it('serializes author-deleted topics with redacted title and empty content', async () => {
      setupMaturityMocks(true)

      const rows = [
        sampleTopicRow({
          isAuthorDeleted: true,
          title: 'Original Title',
          content: 'Original content',
        }),
      ]
      selectChain.limit.mockResolvedValueOnce(rows)

      const response = await app.inject({
        method: 'GET',
        url: '/api/topics',
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{
        topics: Array<{
          title: string
          content: string
          isAuthorDeleted: boolean
        }>
      }>()
      expect(body.topics).toHaveLength(1)
      expect(body.topics[0]?.title).toBe('[Deleted by author]')
      expect(body.topics[0]?.content).toBe('')
    })

    it('serializes topics with null tags as null', async () => {
      setupMaturityMocks(true)

      const rows = [sampleTopicRow({ tags: null })]
      selectChain.limit.mockResolvedValueOnce(rows)

      const response = await app.inject({
        method: 'GET',
        url: '/api/topics',
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{ topics: Array<{ tags: string[] | null }> }>()
      expect(body.topics[0]?.tags).toBeNull()
    })

    it('includes isPinned, isLocked, pinnedScope, and pinnedAt in response', async () => {
      setupMaturityMocks(true)

      const pinnedDate = new Date('2026-03-01T12:00:00.000Z')
      const rows = [
        sampleTopicRow({
          isPinned: true,
          isLocked: true,
          pinnedScope: 'category',
          pinnedAt: pinnedDate,
        }),
      ]
      selectChain.limit.mockResolvedValueOnce(rows)

      const response = await app.inject({
        method: 'GET',
        url: '/api/topics',
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{
        topics: Array<{
          isPinned: boolean
          isLocked: boolean
          pinnedScope: string | null
          pinnedAt: string | null
        }>
      }>()
      expect(body.topics).toHaveLength(1)
      expect(body.topics[0]?.isPinned).toBe(true)
      expect(body.topics[0]?.isLocked).toBe(true)
      expect(body.topics[0]?.pinnedScope).toBe('category')
      expect(body.topics[0]?.pinnedAt).toBe('2026-03-01T12:00:00.000Z')
    })

    it('returns null for pinnedScope and pinnedAt when topic is not pinned', async () => {
      setupMaturityMocks(true)

      const rows = [sampleTopicRow()]
      selectChain.limit.mockResolvedValueOnce(rows)

      const response = await app.inject({
        method: 'GET',
        url: '/api/topics',
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{
        topics: Array<{
          isPinned: boolean
          isLocked: boolean
          pinnedScope: string | null
          pinnedAt: string | null
        }>
      }>()
      expect(body.topics).toHaveLength(1)
      expect(body.topics[0]?.isPinned).toBe(false)
      expect(body.topics[0]?.isLocked).toBe(false)
      expect(body.topics[0]?.pinnedScope).toBeNull()
      expect(body.topics[0]?.pinnedAt).toBeNull()
    })

    it('provides fallback author profile when author not found in DB', async () => {
      resetAllDbMocks()
      setupMaturityMocks(true)

      const unknownDid = 'did:plc:unknownauthor'
      selectChain.limit.mockResolvedValueOnce([
        sampleTopicRow({
          authorDid: unknownDid,
          uri: `at://${unknownDid}/forum.barazo.topic.post/u1`,
          rkey: 'u1',
        }),
      ])

      // Block/mute: empty
      selectChain.where.mockResolvedValueOnce([])
      // topics .where -> chain
      selectChain.where.mockImplementationOnce(() => selectChain)
      // loadMutedWords: empty
      selectChain.where.mockResolvedValueOnce([])
      // resolveAuthors: no user found for unknownDid
      selectChain.where.mockResolvedValueOnce([])

      const res = await app.inject({
        method: 'GET',
        url: '/api/topics',
      })

      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.payload) as {
        topics: Array<{
          author: { did: string; handle: string; displayName: null; avatarUrl: null }
        }>
      }
      // Fallback profile: handle = did, displayName/avatarUrl = null
      expect(body.topics[0]?.author.did).toBe(unknownDid)
      expect(body.topics[0]?.author.handle).toBe(unknownDid)
      expect(body.topics[0]?.author.displayName).toBeNull()
      expect(body.topics[0]?.author.avatarUrl).toBeNull()
    })

    it('maps categoryMaturityRating from category maturity map', async () => {
      // Set up maturity mocks with a non-safe category
      selectChain.where.mockResolvedValueOnce([{ declaredAge: 18, maturityPref: 'mature' }])
      selectChain.where.mockResolvedValueOnce([{ ageThreshold: 16 }])
      selectChain.where.mockResolvedValueOnce([
        { slug: 'general', maturityRating: 'safe' },
        { slug: 'nsfw', maturityRating: 'mature' },
      ])

      const rows = [
        sampleTopicRow({ category: 'nsfw' }),
        sampleTopicRow({
          uri: `at://${TEST_DID}/forum.barazo.topic.post/safe1`,
          rkey: 'safe1',
          category: 'general',
        }),
      ]
      selectChain.limit.mockResolvedValueOnce(rows)

      const response = await app.inject({
        method: 'GET',
        url: '/api/topics',
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{
        topics: Array<{ category: string; categoryMaturityRating: string }>
      }>()
      expect(body.topics).toHaveLength(2)
      const nsfwTopic = body.topics.find((t) => t.category === 'nsfw')
      const safeTopic = body.topics.find((t) => t.category === 'general')
      expect(nsfwTopic?.categoryMaturityRating).toBe('mature')
      expect(safeTopic?.categoryMaturityRating).toBe('safe')
    })
  })

  describe('GET /api/topics (single mode - no allowed categories)', () => {
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

    it('returns empty result when no categories are allowed in single mode', async () => {
      // User profile
      selectChain.where.mockResolvedValueOnce([{ declaredAge: null, maturityPref: 'safe' }])
      // Community settings: age threshold
      selectChain.where.mockResolvedValueOnce([{ ageThreshold: 16 }])
      // Categories query: empty (all categories are mature/adult, user is safe-only)
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

  describe('GET /api/topics (combined category + tag filters)', () => {
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

    it('applies both category and tag filters simultaneously', async () => {
      setupMaturityMocks(true, ['general', 'support'])
      selectChain.limit.mockResolvedValueOnce([])

      const response = await app.inject({
        method: 'GET',
        url: '/api/topics?category=support&tag=help',
      })

      expect(response.statusCode).toBe(200)
      // Verify where was called (filters applied)
      expect(selectChain.where).toHaveBeenCalled()
    })

    it('applies category filter with cursor and limit together', async () => {
      setupMaturityMocks(true)
      const cursor = Buffer.from(
        JSON.stringify({ lastActivityAt: TEST_NOW, uri: TEST_URI })
      ).toString('base64')
      selectChain.limit.mockResolvedValueOnce([])

      const response = await app.inject({
        method: 'GET',
        url: `/api/topics?category=general&limit=5&cursor=${encodeURIComponent(cursor)}`,
      })

      expect(response.statusCode).toBe(200)
    })
  })

  // -------------------------------------------------------------------------
  // GET /api/topics/:uri - maturity branches
  // -------------------------------------------------------------------------

  describe('GET /api/topics/:uri (maturity branches)', () => {
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

    it('returns 403 when maturity blocks access for authenticated user', async () => {
      const row = sampleTopicRow({ category: 'mature-cat' })
      // 1. find topic
      selectChain.where.mockResolvedValueOnce([row])
      // 2. category maturity: mature
      selectChain.where.mockResolvedValueOnce([{ maturityRating: 'mature' }])
      // 3. user profile: no age declared -> safe only
      selectChain.where.mockResolvedValueOnce([{ declaredAge: null, maturityPref: 'safe' }])
      // 4. age threshold
      selectChain.where.mockResolvedValueOnce([{ ageThreshold: 16 }])

      const encodedUri = encodeURIComponent(TEST_URI)
      const response = await app.inject({
        method: 'GET',
        url: `/api/topics/${encodedUri}`,
      })

      expect(response.statusCode).toBe(403)
    })

    it('logs warning and defaults to safe when category not found', async () => {
      const row = sampleTopicRow({ category: 'nonexistent-cat' })
      // 1. find topic
      selectChain.where.mockResolvedValueOnce([row])
      // 2. category lookup: empty -> defaults to 'safe'
      selectChain.where.mockResolvedValueOnce([])
      // 3. user profile
      selectChain.where.mockResolvedValueOnce([{ declaredAge: null, maturityPref: 'safe' }])
      // 4. age threshold
      selectChain.where.mockResolvedValueOnce([{ ageThreshold: 16 }])

      const encodedUri = encodeURIComponent(TEST_URI)
      const response = await app.inject({
        method: 'GET',
        url: `/api/topics/${encodedUri}`,
      })

      // Category not found -> defaults to safe -> safe user can access
      expect(response.statusCode).toBe(200)
    })

    it('returns topic when user has sufficient maturity level', async () => {
      const row = sampleTopicRow({ category: 'mature-cat' })
      // 1. find topic
      selectChain.where.mockResolvedValueOnce([row])
      // 2. category maturity: mature
      selectChain.where.mockResolvedValueOnce([{ maturityRating: 'mature' }])
      // 3. user profile: adult age, mature pref
      selectChain.where.mockResolvedValueOnce([{ declaredAge: 18, maturityPref: 'mature' }])
      // 4. age threshold
      selectChain.where.mockResolvedValueOnce([{ ageThreshold: 16 }])

      const encodedUri = encodeURIComponent(TEST_URI)
      const response = await app.inject({
        method: 'GET',
        url: `/api/topics/${encodedUri}`,
      })

      expect(response.statusCode).toBe(200)
    })

    it('defaults age threshold when no settings row exists', async () => {
      const row = sampleTopicRow()
      // 1. find topic
      selectChain.where.mockResolvedValueOnce([row])
      // 2. category maturity: safe
      selectChain.where.mockResolvedValueOnce([{ maturityRating: 'safe' }])
      // 3. user profile
      selectChain.where.mockResolvedValueOnce([{ declaredAge: null, maturityPref: 'safe' }])
      // 4. age threshold: empty -> defaults to 16
      selectChain.where.mockResolvedValueOnce([])

      const encodedUri = encodeURIComponent(TEST_URI)
      const response = await app.inject({
        method: 'GET',
        url: `/api/topics/${encodedUri}`,
      })

      expect(response.statusCode).toBe(200)
    })

    it('works for unauthenticated user accessing safe content', async () => {
      const noAuthApp = await buildTestApp(undefined)

      const row = sampleTopicRow()
      // 1. find topic
      selectChain.where.mockResolvedValueOnce([row])
      // 2. category maturity: safe
      selectChain.where.mockResolvedValueOnce([{ maturityRating: 'safe' }])
      // 3. no user profile query (unauthenticated)
      // 4. age threshold
      selectChain.where.mockResolvedValueOnce([{ ageThreshold: 16 }])

      const encodedUri = encodeURIComponent(TEST_URI)
      const response = await noAuthApp.inject({
        method: 'GET',
        url: `/api/topics/${encodedUri}`,
      })

      expect(response.statusCode).toBe(200)
      await noAuthApp.close()
    })

    it('returns 403 for unauthenticated user accessing mature content', async () => {
      const noAuthApp = await buildTestApp(undefined)

      const row = sampleTopicRow({ category: 'mature-cat' })
      // 1. find topic
      selectChain.where.mockResolvedValueOnce([row])
      // 2. category maturity: mature
      selectChain.where.mockResolvedValueOnce([{ maturityRating: 'mature' }])
      // 3. no user profile query (unauthenticated)
      // 4. age threshold
      selectChain.where.mockResolvedValueOnce([{ ageThreshold: 16 }])

      const encodedUri = encodeURIComponent(TEST_URI)
      const response = await noAuthApp.inject({
        method: 'GET',
        url: `/api/topics/${encodedUri}`,
      })

      expect(response.statusCode).toBe(403)
      await noAuthApp.close()
    })
  })

  // -------------------------------------------------------------------------
  // GET /api/topics/by-rkey/:rkey - additional branches
  // -------------------------------------------------------------------------

  describe('GET /api/topics/by-rkey/:rkey (additional branches)', () => {
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

    it('defaults category maturity to safe when no category row found', async () => {
      const row = sampleTopicRow({ category: 'unknown-category' })
      // 1. find topic
      selectChain.where.mockResolvedValueOnce([row])
      // 2. category lookup: empty -> defaults to 'safe'
      selectChain.where.mockResolvedValueOnce([])
      // 3. user profile
      selectChain.where.mockResolvedValueOnce([{ declaredAge: null, maturityPref: 'safe' }])
      // 4. age threshold
      selectChain.where.mockResolvedValueOnce([{ ageThreshold: 16 }])

      const response = await app.inject({
        method: 'GET',
        url: '/api/topics/by-rkey/abc123',
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{ categoryMaturityRating: string }>()
      expect(body.categoryMaturityRating).toBe('safe')
    })

    it('defaults user profile to undefined when user row not found', async () => {
      const row = sampleTopicRow()
      // 1. find topic
      selectChain.where.mockResolvedValueOnce([row])
      // 2. category maturity: safe
      selectChain.where.mockResolvedValueOnce([{ maturityRating: 'safe' }])
      // 3. user profile: empty -> undefined
      selectChain.where.mockResolvedValueOnce([])
      // 4. age threshold
      selectChain.where.mockResolvedValueOnce([{ ageThreshold: 16 }])

      const response = await app.inject({
        method: 'GET',
        url: '/api/topics/by-rkey/abc123',
      })

      // undefined user -> safe -> can access safe content
      expect(response.statusCode).toBe(200)
    })

    it('defaults age threshold when no community settings row exists', async () => {
      const row = sampleTopicRow()
      // 1. find topic
      selectChain.where.mockResolvedValueOnce([row])
      // 2. category maturity: safe
      selectChain.where.mockResolvedValueOnce([{ maturityRating: 'safe' }])
      // 3. user profile
      selectChain.where.mockResolvedValueOnce([{ declaredAge: null, maturityPref: 'safe' }])
      // 4. age threshold: empty -> defaults to 16
      selectChain.where.mockResolvedValueOnce([])

      const response = await app.inject({
        method: 'GET',
        url: '/api/topics/by-rkey/abc123',
      })

      expect(response.statusCode).toBe(200)
    })
  })

  // -------------------------------------------------------------------------
  // PUT /api/topics/:uri - additional DB/PDS error branches
  // -------------------------------------------------------------------------

  describe('PUT /api/topics/:uri (additional error branches)', () => {
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
      updateRecordFn.mockResolvedValue({ uri: TEST_URI, cid: 'bafyreinewcid' })
    })

    it('returns 400 when Zod validation fails (whitespace-only title)', async () => {
      // JSON Schema sees minLength 1 satisfied by " ", but Zod trims to "" then fails min(1)
      const encodedUri = encodeURIComponent(TEST_URI)
      const response = await app.inject({
        method: 'PUT',
        url: `/api/topics/${encodedUri}`,
        headers: { authorization: 'Bearer test-token' },
        payload: {
          title: '   ', // Whitespace-only -> passes JSON Schema but fails Zod after trim
        },
      })

      expect(response.statusCode).toBe(400)
    })

    it('returns 404 when DB update returns empty result', async () => {
      const existingRow = sampleTopicRow()
      selectChain.where.mockResolvedValueOnce([existingRow])
      // update().set().where().returning() -> empty
      updateChain.returning.mockResolvedValueOnce([])

      const encodedUri = encodeURIComponent(TEST_URI)
      const response = await app.inject({
        method: 'PUT',
        url: `/api/topics/${encodedUri}`,
        headers: { authorization: 'Bearer test-token' },
        payload: { title: 'Vanished Topic' },
      })

      expect(response.statusCode).toBe(404)
    })

    it('returns 500 when local DB update fails', async () => {
      const existingRow = sampleTopicRow()
      selectChain.where.mockResolvedValueOnce([existingRow])
      updateChain.returning.mockRejectedValueOnce(new Error('DB update error'))

      const encodedUri = encodeURIComponent(TEST_URI)
      const response = await app.inject({
        method: 'PUT',
        url: `/api/topics/${encodedUri}`,
        headers: { authorization: 'Bearer test-token' },
        payload: { content: 'Updated content' },
      })

      expect(response.statusCode).toBe(500)
    })

    it('re-throws DB update error with statusCode property', async () => {
      const existingRow = sampleTopicRow()
      selectChain.where.mockResolvedValueOnce([existingRow])
      const dbError = new Error('Forbidden') as Error & { statusCode: number }
      dbError.statusCode = 403
      updateChain.returning.mockRejectedValueOnce(dbError)

      const encodedUri = encodeURIComponent(TEST_URI)
      const response = await app.inject({
        method: 'PUT',
        url: `/api/topics/${encodedUri}`,
        headers: { authorization: 'Bearer test-token' },
        payload: { title: 'DB Error Rethrow' },
      })

      expect(response.statusCode).toBe(403)
    })

    it('re-throws PDS update error with statusCode property', async () => {
      const existingRow = sampleTopicRow()
      selectChain.where.mockResolvedValueOnce([existingRow])
      const pdsError = new Error('Forbidden') as Error & { statusCode: number }
      pdsError.statusCode = 403
      updateRecordFn.mockRejectedValueOnce(pdsError)

      const encodedUri = encodeURIComponent(TEST_URI)
      const response = await app.inject({
        method: 'PUT',
        url: `/api/topics/${encodedUri}`,
        headers: { authorization: 'Bearer test-token' },
        payload: { title: 'PDS Error With Status' },
      })

      expect(response.statusCode).toBe(403)
    })

    it('updates multiple fields simultaneously', async () => {
      const existingRow = sampleTopicRow()
      selectChain.where.mockResolvedValueOnce([existingRow])
      const updatedRow = {
        ...existingRow,
        title: 'New Title',
        content: 'New content',
        category: 'support',
        tags: ['new-tag'],
        cid: 'bafyreinewcid',
      }
      updateChain.returning.mockResolvedValueOnce([updatedRow])

      const encodedUri = encodeURIComponent(TEST_URI)
      const response = await app.inject({
        method: 'PUT',
        url: `/api/topics/${encodedUri}`,
        headers: { authorization: 'Bearer test-token' },
        payload: {
          title: 'New Title',
          content: 'New content',
          category: 'support',
          tags: ['new-tag'],
        },
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{ title: string; content: string; category: string }>()
      expect(body.title).toBe('New Title')
      expect(body.content).toBe('New content')
      expect(body.category).toBe('support')

      // Verify all fields sent to DB update
      const dbUpdateSet = updateChain.set.mock.calls[0]?.[0] as Record<string, unknown>
      expect(dbUpdateSet.title).toBe('New Title')
      expect(dbUpdateSet.content).toBe('New content')
      expect(dbUpdateSet.category).toBe('support')
      expect(dbUpdateSet.tags).toEqual(['new-tag'])
    })

    it('preserves existing labels in PDS record when labels not in update but exist on topic', async () => {
      const existingLabels = { values: [{ val: 'nsfw' }] }
      const existingRow = sampleTopicRow({ labels: existingLabels })
      selectChain.where.mockResolvedValueOnce([existingRow])
      updateChain.returning.mockResolvedValueOnce([{ ...existingRow, cid: 'bafyreinewcid' }])

      const encodedUri = encodeURIComponent(TEST_URI)
      const response = await app.inject({
        method: 'PUT',
        url: `/api/topics/${encodedUri}`,
        headers: { authorization: 'Bearer test-token' },
        payload: { title: 'Updated' },
      })

      expect(response.statusCode).toBe(200)
      // PDS record should include existing labels
      const pdsRecord = updateRecordFn.mock.calls[0]?.[3] as Record<string, unknown>
      expect(pdsRecord.labels).toEqual(existingLabels)
    })

    it('removes labels when labels explicitly excluded from update and topic had no labels', async () => {
      const existingRow = sampleTopicRow({ labels: null })
      selectChain.where.mockResolvedValueOnce([existingRow])
      updateChain.returning.mockResolvedValueOnce([{ ...existingRow, cid: 'bafyreinewcid' }])

      const encodedUri = encodeURIComponent(TEST_URI)
      const response = await app.inject({
        method: 'PUT',
        url: `/api/topics/${encodedUri}`,
        headers: { authorization: 'Bearer test-token' },
        payload: { title: 'No Labels' },
      })

      expect(response.statusCode).toBe(200)
      // PDS record should NOT have labels key (resolvedLabels is null)
      const pdsRecord = updateRecordFn.mock.calls[0]?.[3] as Record<string, unknown>
      expect(pdsRecord).not.toHaveProperty('labels')
    })
  })

  // -------------------------------------------------------------------------
  // DELETE /api/topics/:uri - additional branches
  // -------------------------------------------------------------------------

  describe('DELETE /api/topics/:uri (additional branches)', () => {
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

    it('returns 403 when user is not author and user row not found', async () => {
      const existingRow = sampleTopicRow({ authorDid: OTHER_DID })
      selectChain.where.mockResolvedValueOnce([existingRow])
      // Role lookup: no user row found
      selectChain.where.mockResolvedValueOnce([])

      const encodedUri = encodeURIComponent(TEST_URI)
      const response = await app.inject({
        method: 'DELETE',
        url: `/api/topics/${encodedUri}`,
        headers: { authorization: 'Bearer test-token' },
      })

      expect(response.statusCode).toBe(403)
    })

    it('returns 500 when local DB soft-delete fails', async () => {
      const existingRow = sampleTopicRow()
      selectChain.where.mockResolvedValueOnce([existingRow])
      // DB update (soft delete) throws
      updateChain.where.mockRejectedValueOnce(new Error('DB delete error'))

      const encodedUri = encodeURIComponent(TEST_URI)
      const response = await app.inject({
        method: 'DELETE',
        url: `/api/topics/${encodedUri}`,
        headers: { authorization: 'Bearer test-token' },
      })

      // PDS delete succeeds for author, then DB soft-delete fails -> 500
      expect(response.statusCode).toBe(500)
    })

    it('re-throws DB delete error with statusCode property', async () => {
      const existingRow = sampleTopicRow()
      selectChain.where.mockResolvedValueOnce([existingRow])
      const dbError = new Error('Not found') as Error & { statusCode: number }
      dbError.statusCode = 404
      // The soft-delete uses update().set().where() which is chained
      // set returns chain, where is the terminal call that resolves
      updateChain.where.mockRejectedValueOnce(dbError)

      const encodedUri = encodeURIComponent(TEST_URI)
      const response = await app.inject({
        method: 'DELETE',
        url: `/api/topics/${encodedUri}`,
        headers: { authorization: 'Bearer test-token' },
      })

      // Error has statusCode so it should be re-thrown
      expect(response.statusCode).toBe(404)
    })

    it('re-throws PDS delete error with statusCode property', async () => {
      const existingRow = sampleTopicRow() // author = TEST_DID
      selectChain.where.mockResolvedValueOnce([existingRow])
      const pdsError = new Error('Forbidden') as Error & { statusCode: number }
      pdsError.statusCode = 403
      deleteRecordFn.mockRejectedValueOnce(pdsError)

      const encodedUri = encodeURIComponent(TEST_URI)
      const response = await app.inject({
        method: 'DELETE',
        url: `/api/topics/${encodedUri}`,
        headers: { authorization: 'Bearer test-token' },
      })

      expect(response.statusCode).toBe(403)
    })

    it('fires cross-post deletion when deleting as author', async () => {
      const existingRow = sampleTopicRow()
      selectChain.where.mockResolvedValueOnce([existingRow])

      const encodedUri = encodeURIComponent(TEST_URI)
      const response = await app.inject({
        method: 'DELETE',
        url: `/api/topics/${encodedUri}`,
        headers: { authorization: 'Bearer test-token' },
      })

      expect(response.statusCode).toBe(204)
      expect(deleteCrossPostsFn).toHaveBeenCalledOnce()
    })

    it('handles cross-post deletion failure gracefully (fire-and-forget)', async () => {
      const existingRow = sampleTopicRow()
      selectChain.where.mockResolvedValueOnce([existingRow])
      // deleteCrossPosts rejects -- should not prevent 204 response
      deleteCrossPostsFn.mockRejectedValueOnce(new Error('Cross-post delete failed'))

      const encodedUri = encodeURIComponent(TEST_URI)
      const response = await app.inject({
        method: 'DELETE',
        url: `/api/topics/${encodedUri}`,
        headers: { authorization: 'Bearer test-token' },
      })

      // Should still return 204 despite cross-post failure
      expect(response.statusCode).toBe(204)
      expect(deleteCrossPostsFn).toHaveBeenCalledOnce()
    })

    it('fires cross-post deletion when deleting as moderator', async () => {
      const modApp = await buildTestApp(testUser({ did: MOD_DID, handle: 'mod.bsky.social' }))

      const existingRow = sampleTopicRow({ authorDid: OTHER_DID })
      selectChain.where.mockResolvedValueOnce([existingRow])
      selectChain.where.mockResolvedValueOnce([{ did: MOD_DID, role: 'moderator' }])

      const encodedUri = encodeURIComponent(TEST_URI)
      const response = await modApp.inject({
        method: 'DELETE',
        url: `/api/topics/${encodedUri}`,
        headers: { authorization: 'Bearer test-token' },
      })

      expect(response.statusCode).toBe(204)
      // Cross-post deletion should fire even for moderator deletes
      expect(deleteCrossPostsFn).toHaveBeenCalledOnce()

      await modApp.close()
    })
  })

  // -------------------------------------------------------------------------
  // GET /api/topics (global mode - additional branches)
  // -------------------------------------------------------------------------

  describe('GET /api/topics (global mode - additional branches)', () => {
    const globalMockEnv = {
      ...mockEnv,
      COMMUNITY_MODE: 'multi' as const,
      COMMUNITY_DID: undefined,
    } as Env

    async function buildGlobalTestApp(user?: RequestUser): Promise<FastifyInstance> {
      const globalApp = Fastify({ logger: false })

      globalApp.decorate('db', mockDb as never)
      globalApp.decorate('env', globalMockEnv)
      globalApp.decorate('authMiddleware', createMockAuthMiddleware(user))
      globalApp.decorate('firehose', mockFirehose as never)
      globalApp.decorate('oauthClient', {} as never)
      globalApp.decorate('sessionService', {} as SessionService)
      globalApp.decorate('setupService', {} as SetupService)
      globalApp.decorate('cache', {} as never)
      globalApp.decorateRequest('user', undefined as RequestUser | undefined)
      globalApp.decorateRequest('communityDid', undefined as string | undefined)
      globalApp.addHook('onRequest', (request, _reply, done) => {
        request.communityDid = 'did:plc:test'
        done()
      })

      await globalApp.register(topicRoutes())
      await globalApp.ready()

      return globalApp
    }

    it('excludes communities with null communityDid in global mode', async () => {
      const app = await buildGlobalTestApp(undefined)

      // Community settings: ageThreshold
      selectChain.where.mockResolvedValueOnce([{ ageThreshold: 16 }])
      // Community settings: includes a row with null communityDid (filtered by isNotNull in query)
      // But the filter also happens in JS code: communityDid must be truthy
      selectChain.where.mockResolvedValueOnce([
        { communityDid: 'did:plc:valid', maturityRating: 'safe' },
        { communityDid: null, maturityRating: 'safe' },
      ])
      // Categories
      selectChain.where.mockResolvedValueOnce([{ slug: 'general', maturityRating: 'safe' }])
      // Topics
      selectChain.limit.mockResolvedValueOnce([sampleTopicRow({ communityDid: 'did:plc:valid' })])

      const response = await app.inject({
        method: 'GET',
        url: '/api/topics',
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{ topics: Array<{ communityDid: string }> }>()
      expect(body.topics).toHaveLength(1)
      expect(body.topics[0]?.communityDid).toBe('did:plc:valid')

      await app.close()
    })

    it('returns empty when all allowed communities have no allowed categories in global mode', async () => {
      const app = await buildGlobalTestApp(testUser())

      // User profile
      selectChain.where.mockResolvedValueOnce([{ declaredAge: null, maturityPref: 'safe' }])
      // Community settings: ageThreshold
      selectChain.where.mockResolvedValueOnce([{ ageThreshold: 16 }])
      // Communities: valid safe community
      selectChain.where.mockResolvedValueOnce([
        { communityDid: 'did:plc:valid', maturityRating: 'safe' },
      ])
      // Categories: empty (no categories match)
      selectChain.where.mockResolvedValueOnce([])

      const response = await app.inject({
        method: 'GET',
        url: '/api/topics',
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{ topics: unknown[]; cursor: string | null }>()
      expect(body.topics).toEqual([])
      expect(body.cursor).toBeNull()

      await app.close()
    })
  })

  // -------------------------------------------------------------------------
  // GET /api/topics (muted word annotation)
  // -------------------------------------------------------------------------

  describe('GET /api/topics (muted word content matching)', () => {
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

    it('annotates isMutedWord: true when topic content matches muted words', async () => {
      resetAllDbMocks()
      setupMaturityMocks(true)

      const rows = [
        sampleTopicRow({
          authorDid: TEST_DID,
          content: 'This contains a badword in the content',
        }),
      ]
      selectChain.limit.mockResolvedValueOnce(rows)

      // Block/mute: empty
      selectChain.where.mockResolvedValueOnce([])
      // topics .where -> chain
      selectChain.where.mockImplementationOnce(() => selectChain)
      // loadMutedWords global: returns muted words
      selectChain.where.mockResolvedValueOnce([{ mutedWords: ['badword'] }])
      // loadMutedWords community (single mode, communityDid defined):
      selectChain.where.mockResolvedValueOnce([{ mutedWords: null }])
      // resolveAuthors
      selectChain.where.mockResolvedValueOnce([
        {
          did: TEST_DID,
          handle: TEST_HANDLE,
          displayName: 'Jay',
          avatarUrl: null,
          bannerUrl: null,
          bio: null,
        },
      ])

      const res = await app.inject({
        method: 'GET',
        url: '/api/topics',
      })

      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.payload) as {
        topics: Array<{ isMutedWord: boolean }>
      }
      expect(body.topics[0]?.isMutedWord).toBe(true)
    })
  })
})
