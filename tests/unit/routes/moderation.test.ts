import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest'
import Fastify from 'fastify'
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import type { Env } from '../../../src/config/env.js'
import type { AuthMiddleware, RequestUser } from '../../../src/auth/middleware.js'
import type { SessionService } from '../../../src/auth/session.js'
import type { SetupService } from '../../../src/setup/service.js'
import { type DbChain, createChainableProxy, createMockDb } from '../../helpers/mock-db.js'

// ---------------------------------------------------------------------------
// Mock requireModerator module (must be before importing routes)
// ---------------------------------------------------------------------------

const mockRequireModerator =
  vi.fn<(request: FastifyRequest, reply: FastifyReply) => Promise<void>>()

vi.mock('../../../src/auth/require-moderator.js', () => ({
  createRequireModerator: () => mockRequireModerator,
}))

// Import routes AFTER mocking
import { moderationRoutes } from '../../../src/routes/moderation.js'

// ---------------------------------------------------------------------------
// Mock env (minimal subset for moderation routes)
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
const ADMIN_DID = 'did:plc:admin999'
const OTHER_DID = 'did:plc:otheruser456'
const COMMUNITY_DID = 'did:plc:community123'

const TEST_TOPIC_URI = `at://${OTHER_DID}/forum.barazo.topic.post/topic123`
const TEST_REPLY_URI = `at://${OTHER_DID}/forum.barazo.topic.reply/reply123`
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

function adminUser(): RequestUser {
  return testUser({ did: ADMIN_DID, handle: 'admin.bsky.social' })
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

  // Add groupBy support for reported users endpoint
  // groupBy returns a chainable that ends with orderBy -> limit -> then
  // eslint-disable-next-line @typescript-eslint/no-misused-promises -- Intentionally thenable mock for Drizzle query chain
  selectChain.where.mockImplementation(() => {
    const chainResult = {
      ...selectChain,
      then: (resolve: (val: unknown) => void, reject?: (err: unknown) => void) =>
        Promise.resolve([]).then(resolve, reject),
      orderBy: selectChain.orderBy,
      limit: selectChain.limit,
      returning: selectChain.returning,
      groupBy: vi.fn().mockImplementation(() => chainResult),
    }
    return chainResult
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
// Mock requireAdmin factory
// ---------------------------------------------------------------------------

function createMockRequireAdmin(user?: RequestUser) {
  return async (
    request: { user?: RequestUser },
    reply: { sent: boolean; status: (code: number) => { send: (body: unknown) => Promise<void> } }
  ) => {
    if (!user) {
      await reply.status(401).send({ error: 'Authentication required' })
      return
    }
    request.user = user
    if (user.did !== ADMIN_DID) {
      await reply.status(403).send({ error: 'Admin access required' })
      return
    }
  }
}

// ---------------------------------------------------------------------------
// Sample data builders
// ---------------------------------------------------------------------------

function sampleTopicRow(overrides?: Record<string, unknown>) {
  return {
    uri: TEST_TOPIC_URI,
    rkey: 'topic123',
    authorDid: OTHER_DID,
    title: 'Test Topic',
    content: 'Test content',
    category: 'general',
    tags: null,
    communityDid: COMMUNITY_DID,
    cid: 'bafyreitopic123',
    labels: null,
    replyCount: 0,
    reactionCount: 0,
    lastActivityAt: new Date(TEST_NOW),
    publishedAt: new Date(TEST_NOW),
    indexedAt: new Date(TEST_NOW),
    isLocked: false,
    isPinned: false,
    pinnedAt: null,
    pinnedScope: null,
    isModDeleted: false,
    embedding: null,
    ...overrides,
  }
}

function sampleReplyRow(overrides?: Record<string, unknown>) {
  return {
    uri: TEST_REPLY_URI,
    rkey: 'reply123',
    authorDid: OTHER_DID,
    content: 'Test reply',
    rootUri: TEST_TOPIC_URI,
    rootCid: 'bafyreitopic123',
    parentUri: TEST_TOPIC_URI,
    parentCid: 'bafyreitopic123',
    communityDid: COMMUNITY_DID,
    cid: 'bafyreireply123',
    labels: null,
    reactionCount: 0,
    createdAt: new Date(TEST_NOW),
    indexedAt: new Date(TEST_NOW),
    isAuthorDeleted: false,
    isModDeleted: false,
    embedding: null,
    ...overrides,
  }
}

function sampleUserRow(overrides?: Record<string, unknown>) {
  return {
    did: OTHER_DID,
    handle: 'alex.bsky.team',
    displayName: 'Alex',
    avatarUrl: null,
    role: 'user',
    isBanned: false,
    reputationScore: 0,
    firstSeenAt: new Date(TEST_NOW),
    lastActiveAt: new Date(TEST_NOW),
    declaredAge: null,
    maturityPref: 'safe',
    ...overrides,
  }
}

function sampleModerationAction(overrides?: Record<string, unknown>) {
  return {
    id: 1,
    action: 'lock',
    targetUri: TEST_TOPIC_URI,
    targetDid: null,
    moderatorDid: TEST_DID,
    communityDid: COMMUNITY_DID,
    reason: null,
    createdAt: new Date(TEST_NOW),
    ...overrides,
  }
}

function sampleReport(overrides?: Record<string, unknown>) {
  return {
    id: 1,
    reporterDid: TEST_DID,
    targetUri: TEST_TOPIC_URI,
    targetDid: OTHER_DID,
    reasonType: 'spam',
    description: null,
    communityDid: COMMUNITY_DID,
    status: 'pending',
    resolutionType: null,
    resolvedBy: null,
    resolvedAt: null,
    createdAt: new Date(TEST_NOW),
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Helper: build app with mocked deps
// ---------------------------------------------------------------------------

async function buildTestApp(
  user?: RequestUser,
  adminUserObj?: RequestUser
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })

  const authMiddleware = createMockAuthMiddleware(user)
  const requireAdmin = createMockRequireAdmin(adminUserObj)

  app.decorate('db', mockDb as never)
  app.decorate('env', mockEnv)
  app.decorate('authMiddleware', authMiddleware)
  app.decorate('requireAdmin', requireAdmin as never)
  app.decorate('firehose', {} as never)
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

  await app.register(moderationRoutes())
  await app.ready()

  return app
}

// ---------------------------------------------------------------------------
// Helper: build app with passthrough auth (reaches !user handler branch)
// ---------------------------------------------------------------------------

/**
 * Builds an app where authMiddleware.requireAuth passes through without
 * setting request.user. This exercises the defensive `!user` checks inside
 * route handlers (lines 1270, 1359, etc.).
 */
async function buildPassthroughAuthApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })

  const passthroughAuth: AuthMiddleware = {
    requireAuth: async () => {
      // Intentionally does NOT set request.user or send 401
    },
    optionalAuth: () => Promise.resolve(),
  }

  app.decorate('db', mockDb as never)
  app.decorate('env', mockEnv)
  app.decorate('authMiddleware', passthroughAuth)
  app.decorate('requireAdmin', createMockRequireAdmin(undefined) as never)
  app.decorate('firehose', {} as never)
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

  await app.register(moderationRoutes())
  await app.ready()

  return app
}

// ===========================================================================
// Test suite
// ===========================================================================

describe('moderation routes', () => {
  // =========================================================================
  // POST /api/moderation/lock/:id
  // =========================================================================

  describe('POST /api/moderation/lock/:id', () => {
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

      // Default: requireModerator passes and sets user
      mockRequireModerator.mockImplementation((request) => {
        request.user = testUser()
        return Promise.resolve()
      })
    })

    it('locks an unlocked topic and returns isLocked: true', async () => {
      // Topic lookup -> unlocked topic found
      selectChain.where.mockResolvedValueOnce([sampleTopicRow({ isLocked: false })])

      const encodedUri = encodeURIComponent(TEST_TOPIC_URI)
      const response = await app.inject({
        method: 'POST',
        url: `/api/moderation/lock/${encodedUri}`,
        headers: { authorization: 'Bearer test-token' },
        payload: { reason: 'Duplicate discussion' },
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{ uri: string; isLocked: boolean }>()
      expect(body.uri).toBe(TEST_TOPIC_URI)
      expect(body.isLocked).toBe(true)

      // Should have used transaction for update + log
      expect(mockDb.transaction).toHaveBeenCalledOnce()
      expect(mockDb.update).toHaveBeenCalled()
      expect(mockDb.insert).toHaveBeenCalled()
    })

    it('unlocks a locked topic and returns isLocked: false', async () => {
      selectChain.where.mockResolvedValueOnce([sampleTopicRow({ isLocked: true })])

      const encodedUri = encodeURIComponent(TEST_TOPIC_URI)
      const response = await app.inject({
        method: 'POST',
        url: `/api/moderation/lock/${encodedUri}`,
        headers: { authorization: 'Bearer test-token' },
        payload: {},
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{ uri: string; isLocked: boolean }>()
      expect(body.uri).toBe(TEST_TOPIC_URI)
      expect(body.isLocked).toBe(false)
    })

    it('returns 404 for non-existent topic', async () => {
      selectChain.where.mockResolvedValueOnce([])

      const encodedUri = encodeURIComponent('at://did:plc:nobody/forum.barazo.topic.post/ghost')
      const response = await app.inject({
        method: 'POST',
        url: `/api/moderation/lock/${encodedUri}`,
        headers: { authorization: 'Bearer test-token' },
        payload: {},
      })

      expect(response.statusCode).toBe(404)
    })

    it('returns 403 for non-moderators', async () => {
      mockRequireModerator.mockImplementation(async (_request, reply) => {
        await reply.status(403).send({ error: 'Moderator access required' })
      })

      const encodedUri = encodeURIComponent(TEST_TOPIC_URI)
      const response = await app.inject({
        method: 'POST',
        url: `/api/moderation/lock/${encodedUri}`,
        headers: { authorization: 'Bearer test-token' },
        payload: {},
      })

      expect(response.statusCode).toBe(403)
    })
  })

  // =========================================================================
  // POST /api/moderation/pin/:id
  // =========================================================================

  describe('POST /api/moderation/pin/:id', () => {
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

      mockRequireModerator.mockImplementation((request) => {
        request.user = testUser()
        return Promise.resolve()
      })
    })

    it('pins an unpinned topic', async () => {
      selectChain.where.mockResolvedValueOnce([sampleTopicRow({ isPinned: false })])

      const encodedUri = encodeURIComponent(TEST_TOPIC_URI)
      const response = await app.inject({
        method: 'POST',
        url: `/api/moderation/pin/${encodedUri}`,
        headers: { authorization: 'Bearer test-token' },
        payload: { reason: 'Important announcement' },
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{ uri: string; isPinned: boolean }>()
      expect(body.uri).toBe(TEST_TOPIC_URI)
      expect(body.isPinned).toBe(true)

      expect(mockDb.transaction).toHaveBeenCalledOnce()
      expect(mockDb.update).toHaveBeenCalled()
      expect(mockDb.insert).toHaveBeenCalled()
    })

    it('unpins a pinned topic', async () => {
      selectChain.where.mockResolvedValueOnce([sampleTopicRow({ isPinned: true })])

      const encodedUri = encodeURIComponent(TEST_TOPIC_URI)
      const response = await app.inject({
        method: 'POST',
        url: `/api/moderation/pin/${encodedUri}`,
        headers: { authorization: 'Bearer test-token' },
        payload: {},
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{ uri: string; isPinned: boolean }>()
      expect(body.uri).toBe(TEST_TOPIC_URI)
      expect(body.isPinned).toBe(false)
    })

    it('returns 404 for non-existent topic', async () => {
      selectChain.where.mockResolvedValueOnce([])

      const encodedUri = encodeURIComponent('at://did:plc:nobody/forum.barazo.topic.post/ghost')
      const response = await app.inject({
        method: 'POST',
        url: `/api/moderation/pin/${encodedUri}`,
        headers: { authorization: 'Bearer test-token' },
        payload: {},
      })

      expect(response.statusCode).toBe(404)
    })

    it('should pin with category scope by default', async () => {
      selectChain.where.mockResolvedValueOnce([sampleTopicRow({ isPinned: false })])

      const encodedUri = encodeURIComponent(TEST_TOPIC_URI)
      const response = await app.inject({
        method: 'POST',
        url: `/api/moderation/pin/${encodedUri}`,
        headers: { authorization: 'Bearer test-token' },
        payload: {},
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{ uri: string; isPinned: boolean; pinnedScope: string | null }>()
      expect(body.isPinned).toBe(true)
      expect(body.pinnedScope).toBe('category')
    })

    it('should pin with forum scope', async () => {
      // User lookup for admin check -- return admin role
      selectChain.where.mockResolvedValueOnce([sampleTopicRow({ isPinned: false })])
      selectChain.where.mockResolvedValueOnce([sampleUserRow({ did: TEST_DID, role: 'admin' })])

      const encodedUri = encodeURIComponent(TEST_TOPIC_URI)
      const response = await app.inject({
        method: 'POST',
        url: `/api/moderation/pin/${encodedUri}`,
        headers: { authorization: 'Bearer test-token' },
        payload: { scope: 'forum' },
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{ uri: string; isPinned: boolean; pinnedScope: string | null }>()
      expect(body.isPinned).toBe(true)
      expect(body.pinnedScope).toBe('forum')
    })

    it('should clear pinnedScope and pinnedAt when unpinning', async () => {
      selectChain.where.mockResolvedValueOnce([
        sampleTopicRow({ isPinned: true, pinnedAt: new Date(TEST_NOW), pinnedScope: 'category' }),
      ])

      const encodedUri = encodeURIComponent(TEST_TOPIC_URI)
      const response = await app.inject({
        method: 'POST',
        url: `/api/moderation/pin/${encodedUri}`,
        headers: { authorization: 'Bearer test-token' },
        payload: {},
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{ uri: string; isPinned: boolean; pinnedScope: string | null }>()
      expect(body.isPinned).toBe(false)
      expect(body.pinnedScope).toBeNull()
    })

    it('should reject forum-wide pin from non-admin moderator', async () => {
      selectChain.where.mockResolvedValueOnce([sampleTopicRow({ isPinned: false })])
      // User lookup returns moderator role (not admin)
      selectChain.where.mockResolvedValueOnce([sampleUserRow({ did: TEST_DID, role: 'moderator' })])

      const encodedUri = encodeURIComponent(TEST_TOPIC_URI)
      const response = await app.inject({
        method: 'POST',
        url: `/api/moderation/pin/${encodedUri}`,
        headers: { authorization: 'Bearer test-token' },
        payload: { scope: 'forum' },
      })

      expect(response.statusCode).toBe(403)
    })
  })

  // =========================================================================
  // POST /api/moderation/delete/:id
  // =========================================================================

  describe('POST /api/moderation/delete/:id', () => {
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

      mockRequireModerator.mockImplementation((request) => {
        request.user = testUser()
        return Promise.resolve()
      })
    })

    it('mod-deletes a topic and returns isModDeleted: true', async () => {
      // Topic found, not yet mod-deleted
      selectChain.where.mockResolvedValueOnce([sampleTopicRow({ isModDeleted: false })])

      const encodedUri = encodeURIComponent(TEST_TOPIC_URI)
      const response = await app.inject({
        method: 'POST',
        url: `/api/moderation/delete/${encodedUri}`,
        headers: { authorization: 'Bearer test-token' },
        payload: { reason: 'Violates community guidelines' },
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{ uri: string; isModDeleted: boolean }>()
      expect(body.uri).toBe(TEST_TOPIC_URI)
      expect(body.isModDeleted).toBe(true)

      expect(mockDb.transaction).toHaveBeenCalledOnce()
      expect(mockDb.update).toHaveBeenCalled()
      expect(mockDb.insert).toHaveBeenCalled()
    })

    it('mod-deletes a reply via soft-delete (sets isModDeleted flag)', async () => {
      // Topic query returns nothing (not a topic)
      selectChain.where.mockResolvedValueOnce([])
      // Reply query returns a reply
      selectChain.where.mockResolvedValueOnce([sampleReplyRow()])

      const encodedUri = encodeURIComponent(TEST_REPLY_URI)
      const response = await app.inject({
        method: 'POST',
        url: `/api/moderation/delete/${encodedUri}`,
        headers: { authorization: 'Bearer test-token' },
        payload: { reason: 'Spam content' },
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{ uri: string; isModDeleted: boolean }>()
      expect(body.uri).toBe(TEST_REPLY_URI)
      expect(body.isModDeleted).toBe(true)

      expect(mockDb.transaction).toHaveBeenCalledOnce()
      // Should soft-delete (update) reply, NOT hard-delete
      expect(mockDb.update).toHaveBeenCalled()
      expect(mockDb.delete).not.toHaveBeenCalled()
      expect(mockDb.insert).toHaveBeenCalled()
    })

    it('returns 409 when reply is already mod-deleted', async () => {
      // Topic query returns nothing (not a topic)
      selectChain.where.mockResolvedValueOnce([])
      // Reply query returns an already mod-deleted reply
      selectChain.where.mockResolvedValueOnce([sampleReplyRow({ isModDeleted: true })])

      const encodedUri = encodeURIComponent(TEST_REPLY_URI)
      const response = await app.inject({
        method: 'POST',
        url: `/api/moderation/delete/${encodedUri}`,
        headers: { authorization: 'Bearer test-token' },
        payload: { reason: 'Already deleted' },
      })

      expect(response.statusCode).toBe(409)
    })

    it('returns 400 when reason is missing', async () => {
      const encodedUri = encodeURIComponent(TEST_TOPIC_URI)
      const response = await app.inject({
        method: 'POST',
        url: `/api/moderation/delete/${encodedUri}`,
        headers: { authorization: 'Bearer test-token' },
        payload: {},
      })

      expect(response.statusCode).toBe(400)
    })

    it('returns 404 when content not found (neither topic nor reply)', async () => {
      // Topic query returns nothing
      selectChain.where.mockResolvedValueOnce([])
      // Reply query returns nothing
      selectChain.where.mockResolvedValueOnce([])

      const encodedUri = encodeURIComponent('at://did:plc:nobody/forum.barazo.topic.post/ghost')
      const response = await app.inject({
        method: 'POST',
        url: `/api/moderation/delete/${encodedUri}`,
        headers: { authorization: 'Bearer test-token' },
        payload: { reason: 'Test reason' },
      })

      expect(response.statusCode).toBe(404)
    })

    it('returns 409 when topic is already mod-deleted', async () => {
      selectChain.where.mockResolvedValueOnce([sampleTopicRow({ isModDeleted: true })])

      const encodedUri = encodeURIComponent(TEST_TOPIC_URI)
      const response = await app.inject({
        method: 'POST',
        url: `/api/moderation/delete/${encodedUri}`,
        headers: { authorization: 'Bearer test-token' },
        payload: { reason: 'Already deleted' },
      })

      expect(response.statusCode).toBe(409)
    })
  })

  // =========================================================================
  // POST /api/moderation/ban
  // =========================================================================

  describe('POST /api/moderation/ban', () => {
    let app: FastifyInstance

    beforeAll(async () => {
      app = await buildTestApp(adminUser(), adminUser())
    })

    afterAll(async () => {
      await app.close()
    })

    beforeEach(() => {
      vi.clearAllMocks()
      resetAllDbMocks()
    })

    it('bans a regular user and returns isBanned: true', async () => {
      // User lookup -> regular user found, not banned
      selectChain.where.mockResolvedValueOnce([sampleUserRow({ isBanned: false })])

      const response = await app.inject({
        method: 'POST',
        url: '/api/moderation/ban',
        headers: { authorization: 'Bearer test-token' },
        payload: { did: OTHER_DID, reason: 'Repeated harassment' },
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{ did: string; isBanned: boolean }>()
      expect(body.did).toBe(OTHER_DID)
      expect(body.isBanned).toBe(true)

      expect(mockDb.transaction).toHaveBeenCalledOnce()
      expect(mockDb.update).toHaveBeenCalled()
      expect(mockDb.insert).toHaveBeenCalled()
    })

    it('unbans a banned user', async () => {
      selectChain.where.mockResolvedValueOnce([sampleUserRow({ isBanned: true })])

      const response = await app.inject({
        method: 'POST',
        url: '/api/moderation/ban',
        headers: { authorization: 'Bearer test-token' },
        payload: { did: OTHER_DID, reason: 'Appeal accepted' },
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{ did: string; isBanned: boolean }>()
      expect(body.did).toBe(OTHER_DID)
      expect(body.isBanned).toBe(false)
    })

    it('returns 400 when trying to ban self', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/moderation/ban',
        headers: { authorization: 'Bearer test-token' },
        payload: { did: ADMIN_DID, reason: 'Self ban' },
      })

      expect(response.statusCode).toBe(400)
    })

    it('returns 403 when trying to ban another admin', async () => {
      const otherAdmin = sampleUserRow({ did: 'did:plc:otheradmin', role: 'admin' })
      selectChain.where.mockResolvedValueOnce([otherAdmin])

      const response = await app.inject({
        method: 'POST',
        url: '/api/moderation/ban',
        headers: { authorization: 'Bearer test-token' },
        payload: { did: 'did:plc:otheradmin', reason: 'Ban admin' },
      })

      expect(response.statusCode).toBe(403)
    })

    it('returns 404 when user not found', async () => {
      selectChain.where.mockResolvedValueOnce([])

      const response = await app.inject({
        method: 'POST',
        url: '/api/moderation/ban',
        headers: { authorization: 'Bearer test-token' },
        payload: { did: 'did:plc:nonexistent', reason: 'Nobody here' },
      })

      expect(response.statusCode).toBe(404)
    })
  })

  describe('POST /api/moderation/ban (non-admin)', () => {
    let app: FastifyInstance

    beforeAll(async () => {
      // Non-admin user: will be blocked by requireAdmin
      app = await buildTestApp(testUser(), testUser())
    })

    afterAll(async () => {
      await app.close()
    })

    it('returns 403 for non-admin user', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/moderation/ban',
        headers: { authorization: 'Bearer test-token' },
        payload: { did: OTHER_DID, reason: 'Not allowed' },
      })

      expect(response.statusCode).toBe(403)
    })
  })

  // =========================================================================
  // GET /api/moderation/log
  // =========================================================================

  describe('GET /api/moderation/log', () => {
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

      mockRequireModerator.mockImplementation((request) => {
        request.user = testUser()
        return Promise.resolve()
      })
    })

    it('returns paginated moderation actions', async () => {
      const actions = [
        sampleModerationAction({ id: 3, action: 'lock' }),
        sampleModerationAction({ id: 2, action: 'pin' }),
      ]
      selectChain.limit.mockResolvedValueOnce(actions)

      const response = await app.inject({
        method: 'GET',
        url: '/api/moderation/log',
        headers: { authorization: 'Bearer test-token' },
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{
        actions: Array<{ id: number; action: string; createdAt: string }>
        cursor: string | null
      }>()
      expect(body.actions).toHaveLength(2)
      expect(body.actions[0]?.action).toBe('lock')
      expect(body.actions[0]?.createdAt).toBe(TEST_NOW)
      expect(body.cursor).toBeNull()
    })

    it('filters by action type', async () => {
      selectChain.limit.mockResolvedValueOnce([])

      const response = await app.inject({
        method: 'GET',
        url: '/api/moderation/log?action=ban',
        headers: { authorization: 'Bearer test-token' },
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{ actions: unknown[]; cursor: string | null }>()
      expect(body.actions).toEqual([])
      expect(body.cursor).toBeNull()
    })

    it('returns empty list when no actions exist', async () => {
      selectChain.limit.mockResolvedValueOnce([])

      const response = await app.inject({
        method: 'GET',
        url: '/api/moderation/log',
        headers: { authorization: 'Bearer test-token' },
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{ actions: unknown[]; cursor: string | null }>()
      expect(body.actions).toEqual([])
      expect(body.cursor).toBeNull()
    })

    it('returns cursor when more results exist', async () => {
      // Default limit is 25; return 26 items to trigger cursor
      const baseDate = new Date('2026-02-13T12:00:00.000Z')
      const actions = Array.from({ length: 26 }, (_, i) => {
        const d = new Date(baseDate.getTime() - i * 3600000) // subtract i hours
        return sampleModerationAction({ id: 26 - i, createdAt: d })
      })
      selectChain.limit.mockResolvedValueOnce(actions)

      const response = await app.inject({
        method: 'GET',
        url: '/api/moderation/log',
        headers: { authorization: 'Bearer test-token' },
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{ actions: unknown[]; cursor: string | null }>()
      expect(body.actions).toHaveLength(25)
      expect(body.cursor).toBeTruthy()
    })
  })

  // =========================================================================
  // POST /api/moderation/report
  // =========================================================================

  describe('POST /api/moderation/report', () => {
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

    it('creates a report successfully', async () => {
      // Topic exists
      selectChain.where.mockResolvedValueOnce([{ uri: TEST_TOPIC_URI }])
      // No existing report (duplicate check)
      selectChain.where.mockResolvedValueOnce([])
      // Insert returning
      insertChain.returning.mockResolvedValueOnce([sampleReport()])

      const response = await app.inject({
        method: 'POST',
        url: '/api/moderation/report',
        headers: { authorization: 'Bearer test-token' },
        payload: {
          targetUri: TEST_TOPIC_URI,
          reasonType: 'spam',
          description: 'This is spam',
        },
      })

      expect(response.statusCode).toBe(201)
      const body = response.json<{
        id: number
        reporterDid: string
        targetUri: string
        reasonType: string
        status: string
      }>()
      expect(body.id).toBe(1)
      expect(body.reporterDid).toBe(TEST_DID)
      expect(body.targetUri).toBe(TEST_TOPIC_URI)
      expect(body.reasonType).toBe('spam')
      expect(body.status).toBe('pending')
    })

    it('returns 400 for invalid URI format (no DID)', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/moderation/report',
        headers: { authorization: 'Bearer test-token' },
        payload: {
          targetUri: 'invalid-uri',
          reasonType: 'spam',
        },
      })

      expect(response.statusCode).toBe(400)
    })

    it('returns 400 when reporting own content', async () => {
      // URI contains the reporter's own DID
      const ownContentUri = `at://${TEST_DID}/forum.barazo.topic.post/mytopic`
      const response = await app.inject({
        method: 'POST',
        url: '/api/moderation/report',
        headers: { authorization: 'Bearer test-token' },
        payload: {
          targetUri: ownContentUri,
          reasonType: 'spam',
        },
      })

      expect(response.statusCode).toBe(400)
    })

    it('returns 404 when target content not found', async () => {
      // Topic query returns nothing
      selectChain.where.mockResolvedValueOnce([])
      // Reply query returns nothing
      selectChain.where.mockResolvedValueOnce([])

      const nonExistentUri = `at://${OTHER_DID}/forum.barazo.topic.post/ghost`
      const response = await app.inject({
        method: 'POST',
        url: '/api/moderation/report',
        headers: { authorization: 'Bearer test-token' },
        payload: {
          targetUri: nonExistentUri,
          reasonType: 'harassment',
        },
      })

      expect(response.statusCode).toBe(404)
    })

    it('returns 409 for duplicate report', async () => {
      // Topic exists
      selectChain.where.mockResolvedValueOnce([{ uri: TEST_TOPIC_URI }])
      // Existing report found (duplicate check)
      selectChain.where.mockResolvedValueOnce([{ id: 1 }])

      const response = await app.inject({
        method: 'POST',
        url: '/api/moderation/report',
        headers: { authorization: 'Bearer test-token' },
        payload: {
          targetUri: TEST_TOPIC_URI,
          reasonType: 'spam',
        },
      })

      expect(response.statusCode).toBe(409)
    })
  })

  describe('POST /api/moderation/report (unauthenticated)', () => {
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
        url: '/api/moderation/report',
        payload: {
          targetUri: TEST_TOPIC_URI,
          reasonType: 'spam',
        },
      })

      expect(response.statusCode).toBe(401)
    })
  })

  // =========================================================================
  // GET /api/moderation/reports
  // =========================================================================

  describe('GET /api/moderation/reports', () => {
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

      mockRequireModerator.mockImplementation((request) => {
        request.user = testUser()
        return Promise.resolve()
      })
    })

    it('returns paginated reports', async () => {
      const reportRows = [sampleReport({ id: 2 }), sampleReport({ id: 1 })]
      selectChain.limit.mockResolvedValueOnce(reportRows)

      const response = await app.inject({
        method: 'GET',
        url: '/api/moderation/reports',
        headers: { authorization: 'Bearer test-token' },
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{
        reports: Array<{ id: number; status: string; createdAt: string }>
        cursor: string | null
      }>()
      expect(body.reports).toHaveLength(2)
      expect(body.reports[0]?.id).toBe(2)
      expect(body.reports[0]?.createdAt).toBe(TEST_NOW)
      expect(body.cursor).toBeNull()
    })

    it('filters by status', async () => {
      selectChain.limit.mockResolvedValueOnce([])

      const response = await app.inject({
        method: 'GET',
        url: '/api/moderation/reports?status=pending',
        headers: { authorization: 'Bearer test-token' },
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{ reports: unknown[]; cursor: string | null }>()
      expect(body.reports).toEqual([])
      expect(body.cursor).toBeNull()
    })

    it('returns cursor when more results exist', async () => {
      const baseDate = new Date('2026-02-13T12:00:00.000Z')
      const reportRows = Array.from({ length: 26 }, (_, i) => {
        const d = new Date(baseDate.getTime() - i * 3600000) // subtract i hours
        return sampleReport({ id: 26 - i, createdAt: d })
      })
      selectChain.limit.mockResolvedValueOnce(reportRows)

      const response = await app.inject({
        method: 'GET',
        url: '/api/moderation/reports',
        headers: { authorization: 'Bearer test-token' },
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{ reports: unknown[]; cursor: string | null }>()
      expect(body.reports).toHaveLength(25)
      expect(body.cursor).toBeTruthy()
    })
  })

  // =========================================================================
  // PUT /api/moderation/reports/:id
  // =========================================================================

  describe('PUT /api/moderation/reports/:id', () => {
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

      mockRequireModerator.mockImplementation((request) => {
        request.user = testUser()
        return Promise.resolve()
      })
    })

    it('resolves a pending report', async () => {
      // Report found, status pending
      selectChain.where.mockResolvedValueOnce([sampleReport({ status: 'pending' })])
      // Update returning
      const resolvedReport = sampleReport({
        status: 'resolved',
        resolutionType: 'dismissed',
        resolvedBy: TEST_DID,
        resolvedAt: new Date(TEST_NOW),
      })
      updateChain.returning.mockResolvedValueOnce([resolvedReport])

      const response = await app.inject({
        method: 'PUT',
        url: '/api/moderation/reports/1',
        headers: { authorization: 'Bearer test-token' },
        payload: { resolutionType: 'dismissed' },
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{
        id: number
        status: string
        resolutionType: string
        resolvedBy: string
      }>()
      expect(body.id).toBe(1)
      expect(body.status).toBe('resolved')
      expect(body.resolutionType).toBe('dismissed')
      expect(body.resolvedBy).toBe(TEST_DID)
    })

    it('returns 404 for non-existent report', async () => {
      selectChain.where.mockResolvedValueOnce([])

      const response = await app.inject({
        method: 'PUT',
        url: '/api/moderation/reports/999',
        headers: { authorization: 'Bearer test-token' },
        payload: { resolutionType: 'dismissed' },
      })

      expect(response.statusCode).toBe(404)
    })

    it('returns 409 for already resolved report', async () => {
      selectChain.where.mockResolvedValueOnce([sampleReport({ status: 'resolved' })])

      const response = await app.inject({
        method: 'PUT',
        url: '/api/moderation/reports/1',
        headers: { authorization: 'Bearer test-token' },
        payload: { resolutionType: 'warned' },
      })

      expect(response.statusCode).toBe(409)
    })
  })

  // =========================================================================
  // GET /api/admin/reports/users
  // =========================================================================

  describe('GET /api/admin/reports/users', () => {
    let app: FastifyInstance

    beforeAll(async () => {
      app = await buildTestApp(adminUser(), adminUser())
    })

    afterAll(async () => {
      await app.close()
    })

    beforeEach(() => {
      vi.clearAllMocks()
      resetAllDbMocks()
    })

    it('returns most-reported users', async () => {
      const reportedUsers = [
        { did: OTHER_DID, reportCount: 5 },
        { did: 'did:plc:badactor', reportCount: 3 },
      ]
      selectChain.limit.mockResolvedValueOnce(reportedUsers)

      const response = await app.inject({
        method: 'GET',
        url: '/api/admin/reports/users',
        headers: { authorization: 'Bearer test-token' },
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{ users: Array<{ did: string; reportCount: number }> }>()
      expect(body.users).toHaveLength(2)
      expect(body.users[0]?.did).toBe(OTHER_DID)
      expect(body.users[0]?.reportCount).toBe(5)
    })

    it('returns empty list when no reported users', async () => {
      selectChain.limit.mockResolvedValueOnce([])

      const response = await app.inject({
        method: 'GET',
        url: '/api/admin/reports/users',
        headers: { authorization: 'Bearer test-token' },
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{ users: unknown[] }>()
      expect(body.users).toEqual([])
    })
  })

  // =========================================================================
  // GET /api/admin/moderation/thresholds
  // =========================================================================

  describe('GET /api/admin/moderation/thresholds', () => {
    let app: FastifyInstance

    beforeAll(async () => {
      app = await buildTestApp(adminUser(), adminUser())
    })

    afterAll(async () => {
      await app.close()
    })

    beforeEach(() => {
      vi.clearAllMocks()
      resetAllDbMocks()
    })

    it('returns default thresholds when no settings exist', async () => {
      // No community settings row
      selectChain.where.mockResolvedValueOnce([])

      const response = await app.inject({
        method: 'GET',
        url: '/api/admin/moderation/thresholds',
        headers: { authorization: 'Bearer test-token' },
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{ autoBlockReportCount: number; warnThreshold: number }>()
      expect(body.autoBlockReportCount).toBe(5)
      expect(body.warnThreshold).toBe(3)
    })

    it('returns stored thresholds from community settings', async () => {
      selectChain.where.mockResolvedValueOnce([
        { moderationThresholds: { autoBlockReportCount: 10, warnThreshold: 7 } },
      ])

      const response = await app.inject({
        method: 'GET',
        url: '/api/admin/moderation/thresholds',
        headers: { authorization: 'Bearer test-token' },
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{ autoBlockReportCount: number; warnThreshold: number }>()
      expect(body.autoBlockReportCount).toBe(10)
      expect(body.warnThreshold).toBe(7)
    })
  })

  // =========================================================================
  // PUT /api/admin/moderation/thresholds
  // =========================================================================

  describe('PUT /api/admin/moderation/thresholds', () => {
    let app: FastifyInstance

    beforeAll(async () => {
      app = await buildTestApp(adminUser(), adminUser())
    })

    afterAll(async () => {
      await app.close()
    })

    beforeEach(() => {
      vi.clearAllMocks()
      resetAllDbMocks()
    })

    it('updates thresholds successfully', async () => {
      const response = await app.inject({
        method: 'PUT',
        url: '/api/admin/moderation/thresholds',
        headers: { authorization: 'Bearer test-token' },
        payload: {
          autoBlockReportCount: 10,
          warnThreshold: 5,
        },
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{ autoBlockReportCount: number; warnThreshold: number }>()
      expect(body.autoBlockReportCount).toBe(10)
      expect(body.warnThreshold).toBe(5)

      expect(mockDb.update).toHaveBeenCalled()
    })

    it('returns 400 for invalid threshold values', async () => {
      const response = await app.inject({
        method: 'PUT',
        url: '/api/admin/moderation/thresholds',
        headers: { authorization: 'Bearer test-token' },
        payload: {
          autoBlockReportCount: 0, // min is 1
          warnThreshold: 5,
        },
      })

      expect(response.statusCode).toBe(400)
    })

    it('returns 400 for threshold exceeding maximum', async () => {
      const response = await app.inject({
        method: 'PUT',
        url: '/api/admin/moderation/thresholds',
        headers: { authorization: 'Bearer test-token' },
        payload: {
          autoBlockReportCount: 101, // max is 100
          warnThreshold: 5,
        },
      })

      expect(response.statusCode).toBe(400)
    })
  })

  describe('PUT /api/admin/moderation/thresholds (non-admin)', () => {
    let app: FastifyInstance

    beforeAll(async () => {
      app = await buildTestApp(testUser(), testUser())
    })

    afterAll(async () => {
      await app.close()
    })

    it('returns 403 for non-admin user', async () => {
      const response = await app.inject({
        method: 'PUT',
        url: '/api/admin/moderation/thresholds',
        headers: { authorization: 'Bearer test-token' },
        payload: {
          autoBlockReportCount: 10,
          warnThreshold: 5,
        },
      })

      expect(response.statusCode).toBe(403)
    })
  })

  // =========================================================================
  // Additional branch coverage tests
  // =========================================================================

  // -------------------------------------------------------------------------
  // POST /api/moderation/lock/:id -- auth & reason branches
  // -------------------------------------------------------------------------

  describe('POST /api/moderation/lock/:id (unauthenticated)', () => {
    let app: FastifyInstance

    beforeAll(async () => {
      app = await buildTestApp(undefined)
    })

    afterAll(async () => {
      await app.close()
    })

    beforeEach(() => {
      vi.clearAllMocks()
      resetAllDbMocks()

      // requireModerator passes but sets no user (simulates auth gap)
      mockRequireModerator.mockImplementation(() => {
        return Promise.resolve()
      })
    })

    it('returns 401 when user is not set on request', async () => {
      const encodedUri = encodeURIComponent(TEST_TOPIC_URI)
      const response = await app.inject({
        method: 'POST',
        url: `/api/moderation/lock/${encodedUri}`,
        headers: { authorization: 'Bearer test-token' },
        payload: {},
      })

      expect(response.statusCode).toBe(401)
    })
  })

  describe('POST /api/moderation/lock/:id (reason branch)', () => {
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

      mockRequireModerator.mockImplementation((request) => {
        request.user = testUser()
        return Promise.resolve()
      })
    })

    it('locks a topic without reason when body reason fails validation', async () => {
      // Reason parsing fails -- the route still proceeds without reason
      selectChain.where.mockResolvedValueOnce([sampleTopicRow({ isLocked: false })])

      const encodedUri = encodeURIComponent(TEST_TOPIC_URI)
      const response = await app.inject({
        method: 'POST',
        url: `/api/moderation/lock/${encodedUri}`,
        headers: { authorization: 'Bearer test-token' },
        // Send a body where reason is not a string, so lockTopicSchema.safeParse fails
        payload: { reason: 12345 },
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{ uri: string; isLocked: boolean }>()
      expect(body.isLocked).toBe(true)
    })
  })

  // -------------------------------------------------------------------------
  // POST /api/moderation/pin/:id -- auth & reason branches
  // -------------------------------------------------------------------------

  describe('POST /api/moderation/pin/:id (unauthenticated)', () => {
    let app: FastifyInstance

    beforeAll(async () => {
      app = await buildTestApp(undefined)
    })

    afterAll(async () => {
      await app.close()
    })

    beforeEach(() => {
      vi.clearAllMocks()
      resetAllDbMocks()

      mockRequireModerator.mockImplementation(() => {
        return Promise.resolve()
      })
    })

    it('returns 401 when user is not set on request', async () => {
      const encodedUri = encodeURIComponent(TEST_TOPIC_URI)
      const response = await app.inject({
        method: 'POST',
        url: `/api/moderation/pin/${encodedUri}`,
        headers: { authorization: 'Bearer test-token' },
        payload: {},
      })

      expect(response.statusCode).toBe(401)
    })
  })

  describe('POST /api/moderation/pin/:id (reason branch)', () => {
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

      mockRequireModerator.mockImplementation((request) => {
        request.user = testUser()
        return Promise.resolve()
      })
    })

    it('pins a topic without reason when body reason fails validation', async () => {
      selectChain.where.mockResolvedValueOnce([sampleTopicRow({ isPinned: false })])

      const encodedUri = encodeURIComponent(TEST_TOPIC_URI)
      const response = await app.inject({
        method: 'POST',
        url: `/api/moderation/pin/${encodedUri}`,
        headers: { authorization: 'Bearer test-token' },
        payload: { reason: 12345 },
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{ uri: string; isPinned: boolean }>()
      expect(body.isPinned).toBe(true)
    })

    it('returns 403 for non-moderators', async () => {
      mockRequireModerator.mockImplementation(async (_request, reply) => {
        await reply.status(403).send({ error: 'Moderator access required' })
      })

      const encodedUri = encodeURIComponent(TEST_TOPIC_URI)
      const response = await app.inject({
        method: 'POST',
        url: `/api/moderation/pin/${encodedUri}`,
        headers: { authorization: 'Bearer test-token' },
        payload: {},
      })

      expect(response.statusCode).toBe(403)
    })
  })

  // -------------------------------------------------------------------------
  // POST /api/moderation/delete/:id -- auth branch
  // -------------------------------------------------------------------------

  describe('POST /api/moderation/delete/:id (unauthenticated)', () => {
    let app: FastifyInstance

    beforeAll(async () => {
      app = await buildTestApp(undefined)
    })

    afterAll(async () => {
      await app.close()
    })

    beforeEach(() => {
      vi.clearAllMocks()
      resetAllDbMocks()

      mockRequireModerator.mockImplementation(() => {
        return Promise.resolve()
      })
    })

    it('returns 401 when user is not set on request', async () => {
      const encodedUri = encodeURIComponent(TEST_TOPIC_URI)
      const response = await app.inject({
        method: 'POST',
        url: `/api/moderation/delete/${encodedUri}`,
        headers: { authorization: 'Bearer test-token' },
        payload: { reason: 'Test' },
      })

      expect(response.statusCode).toBe(401)
    })
  })

  // -------------------------------------------------------------------------
  // POST /api/moderation/ban -- auth, validation, global mode branches
  // -------------------------------------------------------------------------

  describe('POST /api/moderation/ban (unauthenticated)', () => {
    let app: FastifyInstance

    beforeAll(async () => {
      // Build with no admin user so requireAdmin lets it through but user is not set
      app = await buildTestApp(undefined, undefined)
    })

    afterAll(async () => {
      await app.close()
    })

    beforeEach(() => {
      vi.clearAllMocks()
      resetAllDbMocks()
    })

    it('returns 401 when user is not set on request', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/moderation/ban',
        headers: { authorization: 'Bearer test-token' },
        payload: { did: OTHER_DID, reason: 'Spam' },
      })

      expect(response.statusCode).toBe(401)
    })
  })

  describe('POST /api/moderation/ban (validation failure)', () => {
    let app: FastifyInstance

    beforeAll(async () => {
      app = await buildTestApp(adminUser(), adminUser())
    })

    afterAll(async () => {
      await app.close()
    })

    beforeEach(() => {
      vi.clearAllMocks()
      resetAllDbMocks()
    })

    it('returns 400 when body is empty (validation failure)', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/moderation/ban',
        headers: { authorization: 'Bearer test-token' },
        payload: {},
      })

      expect(response.statusCode).toBe(400)
    })

    it('returns 400 when reason is missing', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/moderation/ban',
        headers: { authorization: 'Bearer test-token' },
        payload: { did: OTHER_DID },
      })

      expect(response.statusCode).toBe(400)
    })
  })

  describe('POST /api/moderation/ban (global mode)', () => {
    let globalApp: FastifyInstance

    beforeAll(async () => {
      // Build a special app with COMMUNITY_MODE='multi'
      const globalEnv = {
        ...mockEnv,
        COMMUNITY_MODE: 'multi',
      } as Env

      const app = Fastify({ logger: false })
      const authMiddleware = createMockAuthMiddleware(adminUser())
      const requireAdmin = createMockRequireAdmin(adminUser())

      app.decorate('db', mockDb as never)
      app.decorate('env', globalEnv)
      app.decorate('authMiddleware', authMiddleware)
      app.decorate('requireAdmin', requireAdmin as never)
      app.decorate('firehose', {} as never)
      app.decorate('oauthClient', {} as never)
      app.decorate('sessionService', {} as SessionService)
      app.decorate('setupService', {} as SetupService)
      app.decorate('cache', {
        del: vi.fn().mockResolvedValue(undefined),
      } as never)
      app.decorateRequest('user', undefined as RequestUser | undefined)
      app.decorateRequest('communityDid', undefined as string | undefined)
      app.addHook('onRequest', (request, _reply, done) => {
        request.communityDid = 'did:plc:test'
        done()
      })

      await app.register(moderationRoutes())
      await app.ready()
      globalApp = app
    })

    afterAll(async () => {
      await globalApp.close()
    })

    beforeEach(() => {
      vi.clearAllMocks()
      resetAllDbMocks()
    })

    it('triggers ban propagation in global mode when banning a user', async () => {
      selectChain.where.mockResolvedValueOnce([sampleUserRow({ isBanned: false })])

      const response = await globalApp.inject({
        method: 'POST',
        url: '/api/moderation/ban',
        headers: { authorization: 'Bearer test-token' },
        payload: { did: OTHER_DID, reason: 'Global ban test' },
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{ did: string; isBanned: boolean }>()
      expect(body.isBanned).toBe(true)
    })

    it('does not trigger ban propagation in global mode when unbanning a user', async () => {
      selectChain.where.mockResolvedValueOnce([sampleUserRow({ isBanned: true })])

      const response = await globalApp.inject({
        method: 'POST',
        url: '/api/moderation/ban',
        headers: { authorization: 'Bearer test-token' },
        payload: { did: OTHER_DID, reason: 'Global unban test' },
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{ did: string; isBanned: boolean }>()
      expect(body.isBanned).toBe(false)
    })
  })

  // -------------------------------------------------------------------------
  // GET /api/moderation/log -- cursor branches
  // -------------------------------------------------------------------------

  describe('GET /api/moderation/log (cursor branches)', () => {
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

      mockRequireModerator.mockImplementation((request) => {
        request.user = testUser()
        return Promise.resolve()
      })
    })

    it('accepts a valid cursor parameter', async () => {
      const cursorData = { createdAt: '2026-02-13T10:00:00.000Z', id: 5 }
      const cursor = Buffer.from(JSON.stringify(cursorData)).toString('base64')
      selectChain.limit.mockResolvedValueOnce([])

      const response = await app.inject({
        method: 'GET',
        url: `/api/moderation/log?cursor=${cursor}`,
        headers: { authorization: 'Bearer test-token' },
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{ actions: unknown[]; cursor: string | null }>()
      expect(body.actions).toEqual([])
      expect(body.cursor).toBeNull()
    })

    it('ignores an invalid (non-decodable) cursor', async () => {
      selectChain.limit.mockResolvedValueOnce([])

      const response = await app.inject({
        method: 'GET',
        url: '/api/moderation/log?cursor=not-valid-base64!!!',
        headers: { authorization: 'Bearer test-token' },
      })

      expect(response.statusCode).toBe(200)
    })

    it('ignores a cursor with wrong shape (missing id field)', async () => {
      const badCursor = Buffer.from(JSON.stringify({ createdAt: 'x' })).toString('base64')
      selectChain.limit.mockResolvedValueOnce([])

      const response = await app.inject({
        method: 'GET',
        url: `/api/moderation/log?cursor=${badCursor}`,
        headers: { authorization: 'Bearer test-token' },
      })

      expect(response.statusCode).toBe(200)
    })

    it('respects a custom limit parameter', async () => {
      const actions = [
        sampleModerationAction({ id: 3 }),
        sampleModerationAction({ id: 2 }),
        sampleModerationAction({ id: 1 }),
      ]
      selectChain.limit.mockResolvedValueOnce(actions)

      const response = await app.inject({
        method: 'GET',
        url: '/api/moderation/log?limit=2',
        headers: { authorization: 'Bearer test-token' },
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{ actions: unknown[]; cursor: string | null }>()
      // 3 items returned with limit=2 means hasMore=true, so 2 returned with cursor
      expect(body.actions).toHaveLength(2)
      expect(body.cursor).toBeTruthy()
    })
  })

  // -------------------------------------------------------------------------
  // POST /api/moderation/report -- reply content, insert failure, global mode
  // -------------------------------------------------------------------------

  describe('POST /api/moderation/report (additional branches)', () => {
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

    it('creates a report when content is a reply (not topic)', async () => {
      // Topic lookup returns nothing
      selectChain.where.mockResolvedValueOnce([])
      // Reply lookup finds it
      selectChain.where.mockResolvedValueOnce([{ uri: TEST_REPLY_URI }])
      // Duplicate check returns nothing
      selectChain.where.mockResolvedValueOnce([])
      // Insert returns report
      insertChain.returning.mockResolvedValueOnce([
        sampleReport({ targetUri: TEST_REPLY_URI, appealStatus: 'none' }),
      ])

      const response = await app.inject({
        method: 'POST',
        url: '/api/moderation/report',
        headers: { authorization: 'Bearer test-token' },
        payload: {
          targetUri: TEST_REPLY_URI,
          reasonType: 'harassment',
        },
      })

      expect(response.statusCode).toBe(201)
      const body = response.json<{ id: number; targetUri: string }>()
      expect(body.targetUri).toBe(TEST_REPLY_URI)
    })

    it('returns 400 when insert fails to return a report row', async () => {
      // Topic exists
      selectChain.where.mockResolvedValueOnce([{ uri: TEST_TOPIC_URI }])
      // No duplicate
      selectChain.where.mockResolvedValueOnce([])
      // Insert returns empty array (failure)
      insertChain.returning.mockResolvedValueOnce([])

      const response = await app.inject({
        method: 'POST',
        url: '/api/moderation/report',
        headers: { authorization: 'Bearer test-token' },
        payload: {
          targetUri: TEST_TOPIC_URI,
          reasonType: 'spam',
        },
      })

      expect(response.statusCode).toBe(400)
    })

    it('creates a report with description', async () => {
      // Topic exists
      selectChain.where.mockResolvedValueOnce([{ uri: TEST_TOPIC_URI }])
      // No duplicate
      selectChain.where.mockResolvedValueOnce([])
      // Insert returns report with description
      insertChain.returning.mockResolvedValueOnce([
        sampleReport({ description: 'Detailed description', appealStatus: 'none' }),
      ])

      const response = await app.inject({
        method: 'POST',
        url: '/api/moderation/report',
        headers: { authorization: 'Bearer test-token' },
        payload: {
          targetUri: TEST_TOPIC_URI,
          reasonType: 'other',
          description: 'Detailed description',
        },
      })

      expect(response.statusCode).toBe(201)
      const body = response.json<{ description: string | null }>()
      expect(body.description).toBe('Detailed description')
    })
  })

  describe('POST /api/moderation/report (global mode)', () => {
    let globalApp: FastifyInstance

    beforeAll(async () => {
      const globalEnv = {
        ...mockEnv,
        COMMUNITY_MODE: 'multi',
      } as Env

      const app = Fastify({ logger: false })
      const authMiddleware = createMockAuthMiddleware(testUser())

      app.decorate('db', mockDb as never)
      app.decorate('env', globalEnv)
      app.decorate('authMiddleware', authMiddleware)
      app.decorate('requireAdmin', createMockRequireAdmin(adminUser()) as never)
      app.decorate('firehose', {} as never)
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

      await app.register(moderationRoutes())
      await app.ready()
      globalApp = app
    })

    afterAll(async () => {
      await globalApp.close()
    })

    beforeEach(() => {
      vi.clearAllMocks()
      resetAllDbMocks()
    })

    it('sends admin notification in global mode when report is created', async () => {
      // Topic exists
      selectChain.where.mockResolvedValueOnce([{ uri: TEST_TOPIC_URI }])
      // No duplicate
      selectChain.where.mockResolvedValueOnce([])
      // Insert returns report
      insertChain.returning.mockResolvedValueOnce([sampleReport({ appealStatus: 'none' })])
      // communityFilters lookup returns adminDid
      selectChain.where.mockResolvedValueOnce([{ adminDid: ADMIN_DID }])

      const response = await globalApp.inject({
        method: 'POST',
        url: '/api/moderation/report',
        headers: { authorization: 'Bearer test-token' },
        payload: {
          targetUri: TEST_TOPIC_URI,
          reasonType: 'spam',
        },
      })

      expect(response.statusCode).toBe(201)
      // The insert should have been called twice: once for the report, once for the notification
      expect(mockDb.insert).toHaveBeenCalledTimes(2)
    })

    it('handles global mode when no admin is configured for community', async () => {
      // Topic exists
      selectChain.where.mockResolvedValueOnce([{ uri: TEST_TOPIC_URI }])
      // No duplicate
      selectChain.where.mockResolvedValueOnce([])
      // Insert returns report
      insertChain.returning.mockResolvedValueOnce([sampleReport({ appealStatus: 'none' })])
      // communityFilters lookup returns empty (no admin configured)
      selectChain.where.mockResolvedValueOnce([])

      const response = await globalApp.inject({
        method: 'POST',
        url: '/api/moderation/report',
        headers: { authorization: 'Bearer test-token' },
        payload: {
          targetUri: TEST_TOPIC_URI,
          reasonType: 'spam',
        },
      })

      expect(response.statusCode).toBe(201)
    })

    it('handles global mode notification insert failure gracefully', async () => {
      // Topic exists
      selectChain.where.mockResolvedValueOnce([{ uri: TEST_TOPIC_URI }])
      // No duplicate
      selectChain.where.mockResolvedValueOnce([])
      // Insert: first call returns report, second call (notification) throws
      const originalInsert = mockDb.insert
      let insertCallCount = 0
      originalInsert.mockImplementation(() => {
        insertCallCount++
        if (insertCallCount === 2) {
          // Notification insert fails -- communityFilters select throws
          throw new Error('DB error')
        }
        return insertChain
      })
      insertChain.returning.mockResolvedValueOnce([sampleReport({ appealStatus: 'none' })])
      // communityFilters select will throw before reaching insert
      selectChain.where.mockRejectedValueOnce(new Error('DB error'))

      const response = await globalApp.inject({
        method: 'POST',
        url: '/api/moderation/report',
        headers: { authorization: 'Bearer test-token' },
        payload: {
          targetUri: TEST_TOPIC_URI,
          reasonType: 'spam',
        },
      })

      // Should still return 201 because the global notification is non-critical
      expect(response.statusCode).toBe(201)
    })
  })

  // -------------------------------------------------------------------------
  // GET /api/moderation/reports -- cursor & filter branches
  // -------------------------------------------------------------------------

  describe('GET /api/moderation/reports (cursor branches)', () => {
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

      mockRequireModerator.mockImplementation((request) => {
        request.user = testUser()
        return Promise.resolve()
      })
    })

    it('accepts a valid cursor parameter', async () => {
      const cursorData = { createdAt: '2026-02-13T10:00:00.000Z', id: 5 }
      const cursor = Buffer.from(JSON.stringify(cursorData)).toString('base64')
      selectChain.limit.mockResolvedValueOnce([])

      const response = await app.inject({
        method: 'GET',
        url: `/api/moderation/reports?cursor=${cursor}`,
        headers: { authorization: 'Bearer test-token' },
      })

      expect(response.statusCode).toBe(200)
    })

    it('ignores an invalid cursor gracefully', async () => {
      selectChain.limit.mockResolvedValueOnce([])

      const response = await app.inject({
        method: 'GET',
        url: '/api/moderation/reports?cursor=garbage!!!',
        headers: { authorization: 'Bearer test-token' },
      })

      expect(response.statusCode).toBe(200)
    })

    it('filters by resolved status', async () => {
      selectChain.limit.mockResolvedValueOnce([])

      const response = await app.inject({
        method: 'GET',
        url: '/api/moderation/reports?status=resolved',
        headers: { authorization: 'Bearer test-token' },
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{ reports: unknown[]; cursor: string | null }>()
      expect(body.reports).toEqual([])
    })

    it('respects a custom limit parameter', async () => {
      const reportRows = [
        sampleReport({ id: 3, appealStatus: 'none' }),
        sampleReport({ id: 2, appealStatus: 'none' }),
        sampleReport({ id: 1, appealStatus: 'none' }),
      ]
      selectChain.limit.mockResolvedValueOnce(reportRows)

      const response = await app.inject({
        method: 'GET',
        url: '/api/moderation/reports?limit=2',
        headers: { authorization: 'Bearer test-token' },
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{ reports: unknown[]; cursor: string | null }>()
      expect(body.reports).toHaveLength(2)
      expect(body.cursor).toBeTruthy()
    })
  })

  // -------------------------------------------------------------------------
  // PUT /api/moderation/reports/:id -- additional error branches
  // -------------------------------------------------------------------------

  describe('PUT /api/moderation/reports/:id (additional branches)', () => {
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

      mockRequireModerator.mockImplementation((request) => {
        request.user = testUser()
        return Promise.resolve()
      })
    })

    it('returns 400 for non-numeric report ID', async () => {
      const response = await app.inject({
        method: 'PUT',
        url: '/api/moderation/reports/not-a-number',
        headers: { authorization: 'Bearer test-token' },
        payload: { resolutionType: 'dismissed' },
      })

      expect(response.statusCode).toBe(400)
    })

    it('returns 400 for invalid resolution data (missing resolutionType)', async () => {
      const response = await app.inject({
        method: 'PUT',
        url: '/api/moderation/reports/1',
        headers: { authorization: 'Bearer test-token' },
        payload: {},
      })

      expect(response.statusCode).toBe(400)
    })

    it('returns 404 when update returns empty result', async () => {
      // Report found pending
      selectChain.where.mockResolvedValueOnce([sampleReport({ status: 'pending' })])
      // Update returning empty
      updateChain.returning.mockResolvedValueOnce([])

      const response = await app.inject({
        method: 'PUT',
        url: '/api/moderation/reports/1',
        headers: { authorization: 'Bearer test-token' },
        payload: { resolutionType: 'warned' },
      })

      expect(response.statusCode).toBe(404)
    })

    it('resolves a report with different resolution types', async () => {
      const resTypes = ['warned', 'labeled', 'removed', 'banned'] as const
      for (const resType of resTypes) {
        vi.clearAllMocks()
        resetAllDbMocks()

        mockRequireModerator.mockImplementation((request) => {
          request.user = testUser()
          return Promise.resolve()
        })

        selectChain.where.mockResolvedValueOnce([
          sampleReport({ status: 'pending', appealStatus: 'none' }),
        ])
        updateChain.returning.mockResolvedValueOnce([
          sampleReport({
            status: 'resolved',
            resolutionType: resType,
            resolvedBy: TEST_DID,
            resolvedAt: new Date(TEST_NOW),
            appealStatus: 'none',
          }),
        ])

        const response = await app.inject({
          method: 'PUT',
          url: '/api/moderation/reports/1',
          headers: { authorization: 'Bearer test-token' },
          payload: { resolutionType: resType },
        })

        expect(response.statusCode).toBe(200)
        const body = response.json<{ resolutionType: string }>()
        expect(body.resolutionType).toBe(resType)
      }
    })
  })

  describe('PUT /api/moderation/reports/:id (unauthenticated)', () => {
    let app: FastifyInstance

    beforeAll(async () => {
      app = await buildTestApp(undefined)
    })

    afterAll(async () => {
      await app.close()
    })

    beforeEach(() => {
      vi.clearAllMocks()
      resetAllDbMocks()

      mockRequireModerator.mockImplementation(() => {
        return Promise.resolve()
      })
    })

    it('returns 401 when user is not set on request', async () => {
      const response = await app.inject({
        method: 'PUT',
        url: '/api/moderation/reports/1',
        headers: { authorization: 'Bearer test-token' },
        payload: { resolutionType: 'dismissed' },
      })

      expect(response.statusCode).toBe(401)
    })
  })

  // -------------------------------------------------------------------------
  // GET /api/admin/reports/users -- custom limit, failed parse
  // -------------------------------------------------------------------------

  describe('GET /api/admin/reports/users (additional branches)', () => {
    let app: FastifyInstance

    beforeAll(async () => {
      app = await buildTestApp(adminUser(), adminUser())
    })

    afterAll(async () => {
      await app.close()
    })

    beforeEach(() => {
      vi.clearAllMocks()
      resetAllDbMocks()
    })

    it('uses custom limit when provided', async () => {
      selectChain.limit.mockResolvedValueOnce([{ did: OTHER_DID, reportCount: 5 }])

      const response = await app.inject({
        method: 'GET',
        url: '/api/admin/reports/users?limit=10',
        headers: { authorization: 'Bearer test-token' },
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{ users: unknown[] }>()
      expect(body.users).toHaveLength(1)
    })

    it('uses default limit of 25 when parse fails', async () => {
      selectChain.limit.mockResolvedValueOnce([])

      const response = await app.inject({
        method: 'GET',
        url: '/api/admin/reports/users?limit=invalid',
        headers: { authorization: 'Bearer test-token' },
      })

      expect(response.statusCode).toBe(200)
    })
  })

  // -------------------------------------------------------------------------
  // GET /api/admin/moderation/thresholds -- partial stored thresholds
  // -------------------------------------------------------------------------

  describe('GET /api/admin/moderation/thresholds (partial thresholds)', () => {
    let app: FastifyInstance

    beforeAll(async () => {
      app = await buildTestApp(adminUser(), adminUser())
    })

    afterAll(async () => {
      await app.close()
    })

    beforeEach(() => {
      vi.clearAllMocks()
      resetAllDbMocks()
    })

    it('fills defaults for missing threshold fields', async () => {
      // Return partial thresholds -- only some fields set
      selectChain.where.mockResolvedValueOnce([
        {
          moderationThresholds: {
            autoBlockReportCount: 8,
            // warnThreshold, firstPostQueueCount, etc. are missing
          },
        },
      ])

      const response = await app.inject({
        method: 'GET',
        url: '/api/admin/moderation/thresholds',
        headers: { authorization: 'Bearer test-token' },
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{
        autoBlockReportCount: number
        warnThreshold: number
        firstPostQueueCount: number
        newAccountDays: number
        newAccountWriteRatePerMin: number
        establishedWriteRatePerMin: number
        linkHoldEnabled: boolean
        topicCreationDelayEnabled: boolean
        burstPostCount: number
        burstWindowMinutes: number
        trustedPostThreshold: number
      }>()
      expect(body.autoBlockReportCount).toBe(8)
      expect(body.warnThreshold).toBe(3) // default
      expect(body.firstPostQueueCount).toBe(0) // default
      expect(body.newAccountDays).toBe(7) // default
      expect(body.newAccountWriteRatePerMin).toBe(3) // default
      expect(body.establishedWriteRatePerMin).toBe(10) // default
      expect(body.linkHoldEnabled).toBe(false) // default
      expect(body.topicCreationDelayEnabled).toBe(false) // default
      expect(body.burstPostCount).toBe(5) // default
      expect(body.burstWindowMinutes).toBe(10) // default
      expect(body.trustedPostThreshold).toBe(10) // default
    })

    it('returns defaults when settings row has null moderationThresholds', async () => {
      selectChain.where.mockResolvedValueOnce([{ moderationThresholds: null }])

      const response = await app.inject({
        method: 'GET',
        url: '/api/admin/moderation/thresholds',
        headers: { authorization: 'Bearer test-token' },
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{ autoBlockReportCount: number }>()
      expect(body.autoBlockReportCount).toBe(5) // default
    })
  })

  // -------------------------------------------------------------------------
  // PUT /api/admin/moderation/thresholds -- merge with existing, partial update
  // -------------------------------------------------------------------------

  describe('PUT /api/admin/moderation/thresholds (merge branches)', () => {
    let app: FastifyInstance

    beforeAll(async () => {
      app = await buildTestApp(adminUser(), adminUser())
    })

    afterAll(async () => {
      await app.close()
    })

    beforeEach(() => {
      vi.clearAllMocks()
      resetAllDbMocks()
    })

    it('merges partial update with existing thresholds', async () => {
      // Existing thresholds present
      selectChain.where.mockResolvedValueOnce([
        {
          moderationThresholds: {
            autoBlockReportCount: 8,
            warnThreshold: 4,
            firstPostQueueCount: 2,
            newAccountDays: 5,
            newAccountWriteRatePerMin: 2,
            establishedWriteRatePerMin: 8,
            linkHoldEnabled: false,
            topicCreationDelayEnabled: false,
            burstPostCount: 3,
            burstWindowMinutes: 5,
            trustedPostThreshold: 7,
          },
        },
      ])

      const response = await app.inject({
        method: 'PUT',
        url: '/api/admin/moderation/thresholds',
        headers: { authorization: 'Bearer test-token' },
        payload: {
          warnThreshold: 6,
        },
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{
        autoBlockReportCount: number
        warnThreshold: number
      }>()
      // The merged result should have the new warnThreshold but keep existing autoBlockReportCount
      expect(body.warnThreshold).toBe(6)
      expect(body.autoBlockReportCount).toBe(8)
    })

    it('uses full defaults when no existing settings row exists', async () => {
      // No existing settings
      selectChain.where.mockResolvedValueOnce([])

      const response = await app.inject({
        method: 'PUT',
        url: '/api/admin/moderation/thresholds',
        headers: { authorization: 'Bearer test-token' },
        payload: {
          burstPostCount: 10,
        },
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{
        autoBlockReportCount: number
        burstPostCount: number
      }>()
      expect(body.autoBlockReportCount).toBe(5) // default
      expect(body.burstPostCount).toBe(10) // updated
    })

    it('uses defaults when existing settings has null moderationThresholds', async () => {
      selectChain.where.mockResolvedValueOnce([{ moderationThresholds: null }])

      const response = await app.inject({
        method: 'PUT',
        url: '/api/admin/moderation/thresholds',
        headers: { authorization: 'Bearer test-token' },
        payload: {
          linkHoldEnabled: false,
        },
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{
        linkHoldEnabled: boolean
        autoBlockReportCount: number
      }>()
      expect(body.linkHoldEnabled).toBe(false)
      expect(body.autoBlockReportCount).toBe(5) // default
    })

    it('sends an empty partial update (all fields optional)', async () => {
      selectChain.where.mockResolvedValueOnce([
        {
          moderationThresholds: {
            autoBlockReportCount: 5,
            warnThreshold: 3,
            firstPostQueueCount: 3,
            newAccountDays: 7,
            newAccountWriteRatePerMin: 3,
            establishedWriteRatePerMin: 10,
            linkHoldEnabled: true,
            topicCreationDelayEnabled: true,
            burstPostCount: 5,
            burstWindowMinutes: 10,
            trustedPostThreshold: 10,
          },
        },
      ])

      const response = await app.inject({
        method: 'PUT',
        url: '/api/admin/moderation/thresholds',
        headers: { authorization: 'Bearer test-token' },
        payload: {},
      })

      expect(response.statusCode).toBe(200)
    })
  })

  // -------------------------------------------------------------------------
  // GET /api/moderation/my-reports
  // -------------------------------------------------------------------------

  describe('GET /api/moderation/my-reports', () => {
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

    it('returns reports for the authenticated user', async () => {
      const reportRows = [
        sampleReport({ id: 2, appealStatus: 'none' }),
        sampleReport({ id: 1, appealStatus: 'none' }),
      ]
      selectChain.limit.mockResolvedValueOnce(reportRows)

      const response = await app.inject({
        method: 'GET',
        url: '/api/moderation/my-reports',
        headers: { authorization: 'Bearer test-token' },
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{ reports: Array<{ id: number }>; cursor: string | null }>()
      expect(body.reports).toHaveLength(2)
      expect(body.cursor).toBeNull()
    })

    it('returns cursor when more results exist', async () => {
      const baseDate = new Date('2026-02-13T12:00:00.000Z')
      const reportRows = Array.from({ length: 26 }, (_, i) => {
        const d = new Date(baseDate.getTime() - i * 3600000)
        return sampleReport({ id: 26 - i, createdAt: d, appealStatus: 'none' })
      })
      selectChain.limit.mockResolvedValueOnce(reportRows)

      const response = await app.inject({
        method: 'GET',
        url: '/api/moderation/my-reports',
        headers: { authorization: 'Bearer test-token' },
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{ reports: unknown[]; cursor: string | null }>()
      expect(body.reports).toHaveLength(25)
      expect(body.cursor).toBeTruthy()
    })

    it('accepts a valid cursor parameter', async () => {
      const cursorData = { createdAt: '2026-02-13T10:00:00.000Z', id: 5 }
      const cursor = Buffer.from(JSON.stringify(cursorData)).toString('base64')
      selectChain.limit.mockResolvedValueOnce([])

      const response = await app.inject({
        method: 'GET',
        url: `/api/moderation/my-reports?cursor=${cursor}`,
        headers: { authorization: 'Bearer test-token' },
      })

      expect(response.statusCode).toBe(200)
    })

    it('ignores an invalid cursor', async () => {
      selectChain.limit.mockResolvedValueOnce([])

      const response = await app.inject({
        method: 'GET',
        url: '/api/moderation/my-reports?cursor=bad-cursor!!!',
        headers: { authorization: 'Bearer test-token' },
      })

      expect(response.statusCode).toBe(200)
    })

    it('returns empty list when user has no reports', async () => {
      selectChain.limit.mockResolvedValueOnce([])

      const response = await app.inject({
        method: 'GET',
        url: '/api/moderation/my-reports',
        headers: { authorization: 'Bearer test-token' },
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{ reports: unknown[]; cursor: string | null }>()
      expect(body.reports).toEqual([])
      expect(body.cursor).toBeNull()
    })

    it('respects a custom limit parameter', async () => {
      const reportRows = [
        sampleReport({ id: 3, appealStatus: 'none' }),
        sampleReport({ id: 2, appealStatus: 'none' }),
        sampleReport({ id: 1, appealStatus: 'none' }),
      ]
      selectChain.limit.mockResolvedValueOnce(reportRows)

      const response = await app.inject({
        method: 'GET',
        url: '/api/moderation/my-reports?limit=2',
        headers: { authorization: 'Bearer test-token' },
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{ reports: unknown[]; cursor: string | null }>()
      expect(body.reports).toHaveLength(2)
      expect(body.cursor).toBeTruthy()
    })
  })

  describe('GET /api/moderation/my-reports (unauthenticated)', () => {
    let app: FastifyInstance

    beforeAll(async () => {
      app = await buildTestApp(undefined)
    })

    afterAll(async () => {
      await app.close()
    })

    it('returns 401 without auth', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/moderation/my-reports',
      })

      expect(response.statusCode).toBe(401)
    })
  })

  // -------------------------------------------------------------------------
  // POST /api/moderation/reports/:id/appeal
  // -------------------------------------------------------------------------

  describe('POST /api/moderation/reports/:id/appeal', () => {
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

    it('appeals a dismissed report successfully', async () => {
      selectChain.where.mockResolvedValueOnce([
        sampleReport({
          status: 'resolved',
          resolutionType: 'dismissed',
          resolvedBy: ADMIN_DID,
          resolvedAt: new Date(TEST_NOW),
          appealStatus: 'none',
          reporterDid: TEST_DID,
        }),
      ])

      const appealedReport = sampleReport({
        status: 'pending',
        resolutionType: 'dismissed',
        appealReason: 'I disagree with the dismissal',
        appealedAt: new Date(TEST_NOW),
        appealStatus: 'pending',
        reporterDid: TEST_DID,
      })
      updateChain.returning.mockResolvedValueOnce([appealedReport])

      const response = await app.inject({
        method: 'POST',
        url: '/api/moderation/reports/1/appeal',
        headers: { authorization: 'Bearer test-token' },
        payload: { reason: 'I disagree with the dismissal' },
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{
        appealReason: string
        appealStatus: string
        status: string
      }>()
      expect(body.appealReason).toBe('I disagree with the dismissal')
      expect(body.appealStatus).toBe('pending')
      expect(body.status).toBe('pending')
    })

    it('returns 400 for non-numeric report ID', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/moderation/reports/not-a-number/appeal',
        headers: { authorization: 'Bearer test-token' },
        payload: { reason: 'Some reason' },
      })

      expect(response.statusCode).toBe(400)
    })

    it('returns 400 for invalid body (missing reason)', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/moderation/reports/1/appeal',
        headers: { authorization: 'Bearer test-token' },
        payload: {},
      })

      expect(response.statusCode).toBe(400)
    })

    it('returns 404 when report is not found', async () => {
      selectChain.where.mockResolvedValueOnce([])

      const response = await app.inject({
        method: 'POST',
        url: '/api/moderation/reports/999/appeal',
        headers: { authorization: 'Bearer test-token' },
        payload: { reason: 'Appeal reason' },
      })

      expect(response.statusCode).toBe(404)
    })

    it('returns 403 when appealing a report from another user', async () => {
      selectChain.where.mockResolvedValueOnce([
        sampleReport({
          reporterDid: OTHER_DID, // not the current user
          status: 'resolved',
          resolutionType: 'dismissed',
          appealStatus: 'none',
        }),
      ])

      const response = await app.inject({
        method: 'POST',
        url: '/api/moderation/reports/1/appeal',
        headers: { authorization: 'Bearer test-token' },
        payload: { reason: 'Appeal reason' },
      })

      expect(response.statusCode).toBe(403)
    })

    it('returns 400 when report is not resolved', async () => {
      selectChain.where.mockResolvedValueOnce([
        sampleReport({
          status: 'pending',
          reporterDid: TEST_DID,
          appealStatus: 'none',
        }),
      ])

      const response = await app.inject({
        method: 'POST',
        url: '/api/moderation/reports/1/appeal',
        headers: { authorization: 'Bearer test-token' },
        payload: { reason: 'Appeal reason' },
      })

      expect(response.statusCode).toBe(400)
    })

    it('returns 400 when report resolution is not dismissed', async () => {
      selectChain.where.mockResolvedValueOnce([
        sampleReport({
          status: 'resolved',
          resolutionType: 'warned', // not dismissed
          reporterDid: TEST_DID,
          appealStatus: 'none',
        }),
      ])

      const response = await app.inject({
        method: 'POST',
        url: '/api/moderation/reports/1/appeal',
        headers: { authorization: 'Bearer test-token' },
        payload: { reason: 'Appeal reason' },
      })

      expect(response.statusCode).toBe(400)
    })

    it('returns 409 when report has already been appealed', async () => {
      selectChain.where.mockResolvedValueOnce([
        sampleReport({
          status: 'resolved',
          resolutionType: 'dismissed',
          reporterDid: TEST_DID,
          appealStatus: 'pending', // already appealed
        }),
      ])

      const response = await app.inject({
        method: 'POST',
        url: '/api/moderation/reports/1/appeal',
        headers: { authorization: 'Bearer test-token' },
        payload: { reason: 'Appeal reason' },
      })

      expect(response.statusCode).toBe(409)
    })

    it('returns 404 when update returns empty result', async () => {
      selectChain.where.mockResolvedValueOnce([
        sampleReport({
          status: 'resolved',
          resolutionType: 'dismissed',
          reporterDid: TEST_DID,
          appealStatus: 'none',
        }),
      ])
      // Update returning empty
      updateChain.returning.mockResolvedValueOnce([])

      const response = await app.inject({
        method: 'POST',
        url: '/api/moderation/reports/1/appeal',
        headers: { authorization: 'Bearer test-token' },
        payload: { reason: 'Appeal reason' },
      })

      expect(response.statusCode).toBe(404)
    })
  })

  describe('POST /api/moderation/reports/:id/appeal (unauthenticated)', () => {
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
        url: '/api/moderation/reports/1/appeal',
        payload: { reason: 'Some reason' },
      })

      expect(response.statusCode).toBe(401)
    })
  })

  describe('POST /api/moderation/reports/:id/appeal (rejected appeal)', () => {
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

    it('returns 409 when appeal has been rejected', async () => {
      selectChain.where.mockResolvedValueOnce([
        sampleReport({
          status: 'resolved',
          resolutionType: 'dismissed',
          reporterDid: TEST_DID,
          appealStatus: 'rejected',
        }),
      ])

      const response = await app.inject({
        method: 'POST',
        url: '/api/moderation/reports/1/appeal',
        headers: { authorization: 'Bearer test-token' },
        payload: { reason: 'Appeal again' },
      })

      expect(response.statusCode).toBe(409)
    })
  })

  // -------------------------------------------------------------------------
  // serializeReport -- date/null branch coverage
  // -------------------------------------------------------------------------

  describe('GET /api/moderation/reports (serialization branches)', () => {
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

      mockRequireModerator.mockImplementation((request) => {
        request.user = testUser()
        return Promise.resolve()
      })
    })

    it('serializes report with resolvedAt, appealReason, and appealedAt present', async () => {
      const reportRows = [
        sampleReport({
          id: 1,
          status: 'resolved',
          resolutionType: 'dismissed',
          resolvedBy: TEST_DID,
          resolvedAt: new Date('2026-02-14T10:00:00.000Z'),
          appealReason: 'I disagree',
          appealedAt: new Date('2026-02-14T11:00:00.000Z'),
          appealStatus: 'pending',
        }),
      ]
      selectChain.limit.mockResolvedValueOnce(reportRows)

      const response = await app.inject({
        method: 'GET',
        url: '/api/moderation/reports',
        headers: { authorization: 'Bearer test-token' },
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{
        reports: Array<{
          resolvedAt: string | null
          appealReason: string | null
          appealedAt: string | null
          appealStatus: string
        }>
      }>()
      expect(body.reports[0]?.resolvedAt).toBe('2026-02-14T10:00:00.000Z')
      expect(body.reports[0]?.appealReason).toBe('I disagree')
      expect(body.reports[0]?.appealedAt).toBe('2026-02-14T11:00:00.000Z')
      expect(body.reports[0]?.appealStatus).toBe('pending')
    })

    it('serializes report with null resolvedAt, appealReason, and appealedAt', async () => {
      const reportRows = [
        sampleReport({
          id: 1,
          status: 'pending',
          resolvedAt: null,
          appealReason: null,
          appealedAt: null,
          appealStatus: 'none',
        }),
      ]
      selectChain.limit.mockResolvedValueOnce(reportRows)

      const response = await app.inject({
        method: 'GET',
        url: '/api/moderation/reports',
        headers: { authorization: 'Bearer test-token' },
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{
        reports: Array<{
          resolvedAt: string | null
          appealReason: string | null
          appealedAt: string | null
        }>
      }>()
      expect(body.reports[0]?.resolvedAt).toBeNull()
      expect(body.reports[0]?.appealReason).toBeNull()
      expect(body.reports[0]?.appealedAt).toBeNull()
    })

    it('serializes report with undefined appealReason (falls to null via ??)', async () => {
      const reportRows = [
        sampleReport({
          id: 1,
          appealStatus: 'none',
          // appealReason not set (undefined)
          // appealedAt not set (undefined)
        }),
      ]
      selectChain.limit.mockResolvedValueOnce(reportRows)

      const response = await app.inject({
        method: 'GET',
        url: '/api/moderation/reports',
        headers: { authorization: 'Bearer test-token' },
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{
        reports: Array<{
          appealReason: string | null
          appealedAt: string | null
        }>
      }>()
      expect(body.reports[0]?.appealReason).toBeNull()
      expect(body.reports[0]?.appealedAt).toBeNull()
    })
  })

  // -------------------------------------------------------------------------
  // Handler-level !user branches (passthrough auth reaches handler code)
  // -------------------------------------------------------------------------

  describe('handler-level !user checks (passthrough auth)', () => {
    let app: FastifyInstance

    beforeAll(async () => {
      app = await buildPassthroughAuthApp()
    })

    afterAll(async () => {
      await app.close()
    })

    beforeEach(() => {
      vi.clearAllMocks()
      resetAllDbMocks()

      // requireModerator also passes without setting user
      mockRequireModerator.mockImplementation(() => {
        return Promise.resolve()
      })
    })

    it('POST /api/moderation/report returns 401 when handler !user check fires', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/moderation/report',
        headers: { authorization: 'Bearer test-token' },
        payload: {
          targetUri: TEST_TOPIC_URI,
          reasonType: 'spam',
        },
      })

      expect(response.statusCode).toBe(401)
    })

    it('GET /api/moderation/my-reports returns 401 when handler !user check fires', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/moderation/my-reports',
        headers: { authorization: 'Bearer test-token' },
      })

      expect(response.statusCode).toBe(401)
    })

    it('POST /api/moderation/reports/:id/appeal returns 401 when handler !user check fires', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/moderation/reports/1/appeal',
        headers: { authorization: 'Bearer test-token' },
        payload: { reason: 'Some reason' },
      })

      expect(response.statusCode).toBe(401)
    })

    it('PUT /api/moderation/reports/:id returns 401 when handler !user check fires', async () => {
      const response = await app.inject({
        method: 'PUT',
        url: '/api/moderation/reports/1',
        headers: { authorization: 'Bearer test-token' },
        payload: { resolutionType: 'dismissed' },
      })

      expect(response.statusCode).toBe(401)
    })
  })

  // -------------------------------------------------------------------------
  // Query parse failure branches
  // -------------------------------------------------------------------------

  describe('GET /api/moderation/my-reports (invalid query)', () => {
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

    it('returns 400 when limit is out of range', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/moderation/my-reports?limit=0',
        headers: { authorization: 'Bearer test-token' },
      })

      expect(response.statusCode).toBe(400)
    })

    it('returns 400 when limit exceeds maximum', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/moderation/my-reports?limit=101',
        headers: { authorization: 'Bearer test-token' },
      })

      expect(response.statusCode).toBe(400)
    })
  })
})
