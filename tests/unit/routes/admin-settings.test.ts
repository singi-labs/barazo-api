import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest'
import Fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import type { Env } from '../../../src/config/env.js'
import type { AuthMiddleware, RequestUser } from '../../../src/auth/middleware.js'
import type { SessionService } from '../../../src/auth/session.js'
import type { SetupService } from '../../../src/setup/service.js'
import { type DbChain, createChainableProxy, createMockDb } from '../../helpers/mock-db.js'

// Import routes
import { adminSettingsRoutes } from '../../../src/routes/admin-settings.js'

// ---------------------------------------------------------------------------
// Mock env (minimal subset for admin-settings routes)
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
const ADMIN_DID = 'did:plc:admin999'
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

let selectChain: DbChain
let updateChain: DbChain

function resetAllDbMocks(): void {
  selectChain = createChainableProxy([])
  updateChain = createChainableProxy([])
  mockDb.insert.mockReturnValue(createChainableProxy())
  mockDb.select.mockReturnValue(selectChain)
  mockDb.update.mockReturnValue(updateChain)
  mockDb.delete.mockReturnValue(createChainableProxy())
  // eslint-disable-next-line @typescript-eslint/no-misused-promises -- Intentionally async mock for Drizzle transaction
  mockDb.transaction.mockImplementation(async (fn: (tx: typeof mockDb) => Promise<void>) => {
    await fn(mockDb)
  })
  mockDb.execute.mockReset()
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

function sampleCommunitySettings(overrides?: Record<string, unknown>) {
  return {
    initialized: true,
    communityDid: 'did:plc:community123',
    adminDid: ADMIN_DID,
    communityName: 'Test Community',
    maturityRating: 'safe',
    reactionSet: ['like'],
    moderationThresholds: { autoBlockReportCount: 5, warnThreshold: 3 },
    wordFilter: [],
    communityDescription: null,
    communityLogoUrl: null,
    primaryColor: null,
    accentColor: null,
    jurisdictionCountry: null,
    ageThreshold: 16,
    requireLoginForMature: true,
    createdAt: new Date(TEST_NOW),
    updatedAt: new Date(TEST_NOW),
    ...overrides,
  }
}

function sampleCategoryRow(overrides?: Record<string, unknown>) {
  return {
    id: 'cat-001',
    slug: 'general',
    name: 'General Discussion',
    description: 'Talk about anything',
    parentId: null,
    sortOrder: 0,
    communityDid: 'did:plc:community123',
    maturityRating: 'safe',
    createdAt: new Date(TEST_NOW),
    updatedAt: new Date(TEST_NOW),
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Helper: build app with mocked deps
// ---------------------------------------------------------------------------

async function buildTestApp(user?: RequestUser): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })

  const authMiddleware = createMockAuthMiddleware(user)
  const requireAdmin = createMockRequireAdmin(user)

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
  app.addHook('onRequest', async (request) => {
    request.communityDid = 'did:plc:test'
  })

  await app.register(adminSettingsRoutes())
  await app.ready()

  return app
}

// ===========================================================================
// Test suite
// ===========================================================================

describe('admin settings routes', () => {
  // =========================================================================
  // GET /api/admin/settings
  // =========================================================================

  describe('GET /api/admin/settings', () => {
    let app: FastifyInstance

    beforeAll(async () => {
      app = await buildTestApp(adminUser())
    })

    afterAll(async () => {
      await app.close()
    })

    beforeEach(() => {
      vi.clearAllMocks()
      resetAllDbMocks()
    })

    it('returns community settings', async () => {
      const settings = sampleCommunitySettings()
      selectChain.where.mockResolvedValueOnce([settings])

      const response = await app.inject({
        method: 'GET',
        url: '/api/admin/settings',
        headers: { authorization: 'Bearer admin-token' },
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{
        communityName: string
        maturityRating: string
        initialized: boolean
      }>()
      expect(body.communityName).toBe('Test Community')
      expect(body.maturityRating).toBe('safe')
      expect(body.initialized).toBe(true)
      expect(body).toHaveProperty('createdAt')
      expect(body).toHaveProperty('updatedAt')
    })

    it('returns 404 if no settings row exists', async () => {
      selectChain.where.mockResolvedValueOnce([])

      const response = await app.inject({
        method: 'GET',
        url: '/api/admin/settings',
        headers: { authorization: 'Bearer admin-token' },
      })

      expect(response.statusCode).toBe(404)
      const body = response.json<{ message: string }>()
      expect(body.message).toContain('settings')
    })

    it('returns 401 when unauthenticated', async () => {
      const noAuthApp = await buildTestApp(undefined)

      const response = await noAuthApp.inject({
        method: 'GET',
        url: '/api/admin/settings',
      })

      expect(response.statusCode).toBe(401)
      await noAuthApp.close()
    })

    it('returns 403 when non-admin user', async () => {
      const regularApp = await buildTestApp(testUser())

      const response = await regularApp.inject({
        method: 'GET',
        url: '/api/admin/settings',
        headers: { authorization: 'Bearer user-token' },
      })

      expect(response.statusCode).toBe(403)
      await regularApp.close()
    })
  })

  // =========================================================================
  // PUT /api/admin/settings
  // =========================================================================

  describe('PUT /api/admin/settings', () => {
    let app: FastifyInstance

    beforeAll(async () => {
      app = await buildTestApp(adminUser())
    })

    afterAll(async () => {
      await app.close()
    })

    beforeEach(() => {
      vi.clearAllMocks()
      resetAllDbMocks()
    })

    it('updates communityName', async () => {
      const settings = sampleCommunitySettings()
      // Fetch current settings
      selectChain.where.mockResolvedValueOnce([settings])
      // Update returns updated row
      updateChain.returning.mockResolvedValueOnce([
        { ...settings, communityName: 'New Name', updatedAt: new Date() },
      ])

      const response = await app.inject({
        method: 'PUT',
        url: '/api/admin/settings',
        headers: { authorization: 'Bearer admin-token' },
        payload: {
          communityName: 'New Name',
        },
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{ communityName: string }>()
      expect(body.communityName).toBe('New Name')
    })

    it('updates maturityRating when lowering (no validation needed)', async () => {
      const settings = sampleCommunitySettings({ maturityRating: 'mature' })
      // Fetch current settings
      selectChain.where.mockResolvedValueOnce([settings])
      // No category check needed when lowering
      // Update returns updated row
      updateChain.returning.mockResolvedValueOnce([
        { ...settings, maturityRating: 'safe', updatedAt: new Date() },
      ])

      const response = await app.inject({
        method: 'PUT',
        url: '/api/admin/settings',
        headers: { authorization: 'Bearer admin-token' },
        payload: {
          maturityRating: 'safe',
        },
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{ maturityRating: string }>()
      expect(body.maturityRating).toBe('safe')
    })

    it('updates maturityRating when raising with compatible categories', async () => {
      const settings = sampleCommunitySettings({ maturityRating: 'safe' })
      // Fetch current settings
      selectChain.where.mockResolvedValueOnce([settings])
      // Category check: all categories are >= "mature" (the new target)
      selectChain.where.mockResolvedValueOnce([]) // no incompatible categories
      // Update returns updated row
      updateChain.returning.mockResolvedValueOnce([
        { ...settings, maturityRating: 'mature', updatedAt: new Date() },
      ])

      const response = await app.inject({
        method: 'PUT',
        url: '/api/admin/settings',
        headers: { authorization: 'Bearer admin-token' },
        payload: {
          maturityRating: 'mature',
        },
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{ maturityRating: string }>()
      expect(body.maturityRating).toBe('mature')
    })

    it('returns 409 when raising maturity with incompatible categories', async () => {
      const settings = sampleCommunitySettings({ maturityRating: 'safe' })
      // Fetch current settings
      selectChain.where.mockResolvedValueOnce([settings])
      // Category check: some categories have rating lower than new target
      const incompatibleCategories = [
        sampleCategoryRow({
          id: 'cat-001',
          slug: 'general',
          name: 'General Discussion',
          maturityRating: 'safe',
        }),
        sampleCategoryRow({ id: 'cat-002', slug: 'help', name: 'Help', maturityRating: 'safe' }),
      ]
      selectChain.where.mockResolvedValueOnce(incompatibleCategories)

      const response = await app.inject({
        method: 'PUT',
        url: '/api/admin/settings',
        headers: { authorization: 'Bearer admin-token' },
        payload: {
          maturityRating: 'mature',
        },
      })

      expect(response.statusCode).toBe(409)
      const body = response.json<{
        message: string
        details: {
          categories: Array<{ id: string; slug: string; name: string; maturityRating: string }>
        }
      }>()
      expect(body.message).toContain('categories')
      expect(body.details.categories).toHaveLength(2)
      expect(body.details.categories[0]?.slug).toBe('general')
      expect(body.details.categories[1]?.slug).toBe('help')
    })

    it('returns 409 with affected category details when raising to adult', async () => {
      const settings = sampleCommunitySettings({ maturityRating: 'safe' })
      selectChain.where.mockResolvedValueOnce([settings])
      // One category at "safe", one at "mature" -- both below "adult"
      const incompatibleCategories = [
        sampleCategoryRow({
          id: 'cat-001',
          slug: 'general',
          name: 'General',
          maturityRating: 'safe',
        }),
        sampleCategoryRow({
          id: 'cat-003',
          slug: 'mature-stuff',
          name: 'Mature Stuff',
          maturityRating: 'mature',
        }),
      ]
      selectChain.where.mockResolvedValueOnce(incompatibleCategories)

      const response = await app.inject({
        method: 'PUT',
        url: '/api/admin/settings',
        headers: { authorization: 'Bearer admin-token' },
        payload: {
          maturityRating: 'adult',
        },
      })

      expect(response.statusCode).toBe(409)
      const body = response.json<{
        details: { categories: Array<{ id: string; maturityRating: string }> }
      }>()
      expect(body.details.categories).toHaveLength(2)
    })

    it('updates both communityName and maturityRating', async () => {
      const settings = sampleCommunitySettings({ maturityRating: 'safe' })
      // Fetch current settings
      selectChain.where.mockResolvedValueOnce([settings])
      // Category check for maturity raise: no incompatible categories
      selectChain.where.mockResolvedValueOnce([])
      // Update returns updated row
      updateChain.returning.mockResolvedValueOnce([
        {
          ...settings,
          communityName: 'Mature Community',
          maturityRating: 'mature',
          updatedAt: new Date(),
        },
      ])

      const response = await app.inject({
        method: 'PUT',
        url: '/api/admin/settings',
        headers: { authorization: 'Bearer admin-token' },
        payload: {
          communityName: 'Mature Community',
          maturityRating: 'mature',
        },
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{ communityName: string; maturityRating: string }>()
      expect(body.communityName).toBe('Mature Community')
      expect(body.maturityRating).toBe('mature')
    })

    it('returns 404 if no settings row exists', async () => {
      selectChain.where.mockResolvedValueOnce([])

      const response = await app.inject({
        method: 'PUT',
        url: '/api/admin/settings',
        headers: { authorization: 'Bearer admin-token' },
        payload: {
          communityName: 'New Name',
        },
      })

      expect(response.statusCode).toBe(404)
    })

    it('returns 404 if settings row deleted during update', async () => {
      const settings = sampleCommunitySettings()
      selectChain.where.mockResolvedValueOnce([settings])
      updateChain.returning.mockResolvedValueOnce([])

      const response = await app.inject({
        method: 'PUT',
        url: '/api/admin/settings',
        headers: { authorization: 'Bearer admin-token' },
        payload: {
          communityName: 'New Name',
        },
      })

      expect(response.statusCode).toBe(404)
      const body = response.json<{ message: string }>()
      expect(body.message).toContain('after update')
    })

    it('sets updatedAt on update', async () => {
      const settings = sampleCommunitySettings()
      selectChain.where.mockResolvedValueOnce([settings])
      const updatedRow = { ...settings, communityName: 'Updated', updatedAt: new Date() }
      updateChain.returning.mockResolvedValueOnce([updatedRow])

      const response = await app.inject({
        method: 'PUT',
        url: '/api/admin/settings',
        headers: { authorization: 'Bearer admin-token' },
        payload: {
          communityName: 'Updated',
        },
      })

      expect(response.statusCode).toBe(200)
      expect(mockDb.update).toHaveBeenCalled()
    })

    it('returns 400 for communityName too long', async () => {
      const response = await app.inject({
        method: 'PUT',
        url: '/api/admin/settings',
        headers: { authorization: 'Bearer admin-token' },
        payload: {
          communityName: 'A'.repeat(101),
        },
      })

      expect(response.statusCode).toBe(400)
    })

    it('returns 400 for empty communityName', async () => {
      const response = await app.inject({
        method: 'PUT',
        url: '/api/admin/settings',
        headers: { authorization: 'Bearer admin-token' },
        payload: {
          communityName: '',
        },
      })

      expect(response.statusCode).toBe(400)
    })

    it('returns 400 for invalid maturityRating', async () => {
      const response = await app.inject({
        method: 'PUT',
        url: '/api/admin/settings',
        headers: { authorization: 'Bearer admin-token' },
        payload: {
          maturityRating: 'invalid',
        },
      })

      expect(response.statusCode).toBe(400)
    })

    it('returns 400 for empty body', async () => {
      const response = await app.inject({
        method: 'PUT',
        url: '/api/admin/settings',
        headers: { authorization: 'Bearer admin-token' },
        payload: {},
      })

      expect(response.statusCode).toBe(400)
    })

    it('returns 401 when unauthenticated', async () => {
      const noAuthApp = await buildTestApp(undefined)

      const response = await noAuthApp.inject({
        method: 'PUT',
        url: '/api/admin/settings',
        payload: { communityName: 'Unauth' },
      })

      expect(response.statusCode).toBe(401)
      await noAuthApp.close()
    })

    it('returns 403 when non-admin user', async () => {
      const regularApp = await buildTestApp(testUser())

      const response = await regularApp.inject({
        method: 'PUT',
        url: '/api/admin/settings',
        headers: { authorization: 'Bearer user-token' },
        payload: { communityName: 'Forbidden' },
      })

      expect(response.statusCode).toBe(403)
      await regularApp.close()
    })

    it('updates jurisdictionCountry', async () => {
      const settings = sampleCommunitySettings()
      selectChain.where.mockResolvedValueOnce([settings])
      const updatedRow = {
        ...settings,
        jurisdictionCountry: 'NL',
        updatedAt: new Date(),
      }
      updateChain.returning.mockResolvedValueOnce([updatedRow])

      const response = await app.inject({
        method: 'PUT',
        url: '/api/admin/settings',
        headers: { authorization: 'Bearer admin-token' },
        payload: {
          jurisdictionCountry: 'NL',
        },
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{ jurisdictionCountry: string }>()
      expect(body.jurisdictionCountry).toBe('NL')
    })

    it('updates ageThreshold', async () => {
      const settings = sampleCommunitySettings()
      selectChain.where.mockResolvedValueOnce([settings])
      const updatedRow = {
        ...settings,
        ageThreshold: 13,
        updatedAt: new Date(),
      }
      updateChain.returning.mockResolvedValueOnce([updatedRow])

      const response = await app.inject({
        method: 'PUT',
        url: '/api/admin/settings',
        headers: { authorization: 'Bearer admin-token' },
        payload: {
          ageThreshold: 13,
        },
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{ ageThreshold: number }>()
      expect(body.ageThreshold).toBe(13)
    })

    it('updates requireLoginForMature', async () => {
      const settings = sampleCommunitySettings()
      selectChain.where.mockResolvedValueOnce([settings])
      const updatedRow = {
        ...settings,
        requireLoginForMature: false,
        updatedAt: new Date(),
      }
      updateChain.returning.mockResolvedValueOnce([updatedRow])

      const response = await app.inject({
        method: 'PUT',
        url: '/api/admin/settings',
        headers: { authorization: 'Bearer admin-token' },
        payload: {
          requireLoginForMature: false,
        },
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{ requireLoginForMature: boolean }>()
      expect(body.requireLoginForMature).toBe(false)
    })

    it('clears jurisdictionCountry with null', async () => {
      const settings = sampleCommunitySettings({ jurisdictionCountry: 'NL' })
      selectChain.where.mockResolvedValueOnce([settings])
      const updatedRow = {
        ...settings,
        jurisdictionCountry: null,
        updatedAt: new Date(),
      }
      updateChain.returning.mockResolvedValueOnce([updatedRow])

      const response = await app.inject({
        method: 'PUT',
        url: '/api/admin/settings',
        headers: { authorization: 'Bearer admin-token' },
        payload: {
          jurisdictionCountry: null,
        },
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{ jurisdictionCountry: string | null }>()
      expect(body.jurisdictionCountry).toBeNull()
    })

    it('returns 400 for ageThreshold below 13', async () => {
      const response = await app.inject({
        method: 'PUT',
        url: '/api/admin/settings',
        headers: { authorization: 'Bearer admin-token' },
        payload: {
          ageThreshold: 12,
        },
      })

      expect(response.statusCode).toBe(400)
    })

    it('returns 400 for ageThreshold above 18', async () => {
      const response = await app.inject({
        method: 'PUT',
        url: '/api/admin/settings',
        headers: { authorization: 'Bearer admin-token' },
        payload: {
          ageThreshold: 19,
        },
      })

      expect(response.statusCode).toBe(400)
    })

    it('does not check categories when maturityRating stays the same', async () => {
      const settings = sampleCommunitySettings({ maturityRating: 'mature' })
      selectChain.where.mockResolvedValueOnce([settings])
      // Should NOT query categories since maturity isn't changing
      updateChain.returning.mockResolvedValueOnce([
        { ...settings, communityName: 'Renamed', updatedAt: new Date() },
      ])

      const response = await app.inject({
        method: 'PUT',
        url: '/api/admin/settings',
        headers: { authorization: 'Bearer admin-token' },
        payload: {
          communityName: 'Renamed',
          maturityRating: 'mature', // same as current
        },
      })

      expect(response.statusCode).toBe(200)
      // Only one select call: fetch current settings. No category check.
      expect(mockDb.select).toHaveBeenCalledTimes(1)
    })

    it('updates branding fields', async () => {
      const settings = sampleCommunitySettings()
      selectChain.where.mockResolvedValueOnce([settings])
      const updatedRow = {
        ...settings,
        communityDescription: 'A great community',
        communityLogoUrl: 'https://example.com/logo.png',
        primaryColor: '#ff0000',
        accentColor: '#00ff00',
        updatedAt: new Date(),
      }
      updateChain.returning.mockResolvedValueOnce([updatedRow])

      const response = await app.inject({
        method: 'PUT',
        url: '/api/admin/settings',
        headers: { authorization: 'Bearer admin-token' },
        payload: {
          communityDescription: 'A great community',
          communityLogoUrl: 'https://example.com/logo.png',
          primaryColor: '#ff0000',
          accentColor: '#00ff00',
        },
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{
        communityDescription: string
        communityLogoUrl: string
        primaryColor: string
        accentColor: string
      }>()
      expect(body.communityDescription).toBe('A great community')
      expect(body.communityLogoUrl).toBe('https://example.com/logo.png')
      expect(body.primaryColor).toBe('#ff0000')
      expect(body.accentColor).toBe('#00ff00')
    })

    it('returns 400 for communityDescription too long', async () => {
      const response = await app.inject({
        method: 'PUT',
        url: '/api/admin/settings',
        headers: { authorization: 'Bearer admin-token' },
        payload: {
          communityDescription: 'A'.repeat(501),
        },
      })

      expect(response.statusCode).toBe(400)
    })

    it('returns 400 for invalid communityLogoUrl', async () => {
      const response = await app.inject({
        method: 'PUT',
        url: '/api/admin/settings',
        headers: { authorization: 'Bearer admin-token' },
        payload: {
          communityLogoUrl: 'not-a-url',
        },
      })

      expect(response.statusCode).toBe(400)
    })

    it('returns 400 for invalid primaryColor', async () => {
      const response = await app.inject({
        method: 'PUT',
        url: '/api/admin/settings',
        headers: { authorization: 'Bearer admin-token' },
        payload: {
          primaryColor: 'red',
        },
      })

      expect(response.statusCode).toBe(400)
    })

    it('returns 400 for invalid accentColor', async () => {
      const response = await app.inject({
        method: 'PUT',
        url: '/api/admin/settings',
        headers: { authorization: 'Bearer admin-token' },
        payload: {
          accentColor: '#xyz',
        },
      })

      expect(response.statusCode).toBe(400)
    })
  })

  // =========================================================================
  // GET /api/admin/stats
  // =========================================================================

  describe('GET /api/admin/stats', () => {
    let app: FastifyInstance

    beforeAll(async () => {
      app = await buildTestApp(adminUser())
    })

    afterAll(async () => {
      await app.close()
    })

    beforeEach(() => {
      vi.clearAllMocks()
      resetAllDbMocks()
    })

    it('returns community statistics', async () => {
      mockDb.execute.mockResolvedValueOnce([
        {
          topic_count: '42',
          reply_count: '100',
          user_count: '15',
          category_count: '5',
          report_count: '3',
          recent_topics: '10',
          recent_replies: '25',
          recent_users: '5',
        },
      ])

      const response = await app.inject({
        method: 'GET',
        url: '/api/admin/stats',
        headers: { authorization: 'Bearer admin-token' },
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{
        topicCount: number
        replyCount: number
        userCount: number
        categoryCount: number
        reportCount: number
        recentTopics: number
        recentReplies: number
        recentUsers: number
      }>()
      expect(body.topicCount).toBe(42)
      expect(body.replyCount).toBe(100)
      expect(body.userCount).toBe(15)
      expect(body.categoryCount).toBe(5)
      expect(body.reportCount).toBe(3)
      expect(body.recentTopics).toBe(10)
      expect(body.recentReplies).toBe(25)
      expect(body.recentUsers).toBe(5)
    })

    it('returns zeros when no data exists', async () => {
      mockDb.execute.mockResolvedValueOnce([
        {
          topic_count: '0',
          reply_count: '0',
          user_count: '0',
          category_count: '0',
          report_count: '0',
          recent_topics: '0',
          recent_replies: '0',
          recent_users: '0',
        },
      ])

      const response = await app.inject({
        method: 'GET',
        url: '/api/admin/stats',
        headers: { authorization: 'Bearer admin-token' },
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{
        topicCount: number
        replyCount: number
      }>()
      expect(body.topicCount).toBe(0)
      expect(body.replyCount).toBe(0)
    })

    it('returns 401 when unauthenticated', async () => {
      const noAuthApp = await buildTestApp(undefined)

      const response = await noAuthApp.inject({
        method: 'GET',
        url: '/api/admin/stats',
      })

      expect(response.statusCode).toBe(401)
      await noAuthApp.close()
    })

    it('returns 403 when non-admin user', async () => {
      const regularApp = await buildTestApp(testUser())

      const response = await regularApp.inject({
        method: 'GET',
        url: '/api/admin/stats',
        headers: { authorization: 'Bearer user-token' },
      })

      expect(response.statusCode).toBe(403)
      await regularApp.close()
    })
  })
})
