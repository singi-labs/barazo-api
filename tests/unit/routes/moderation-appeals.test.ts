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
const TEST_HANDLE = 'alice.bsky.social'
const TEST_SID = 'a'.repeat(64)
const ADMIN_DID = 'did:plc:admin999'
const OTHER_DID = 'did:plc:otheruser456'
const COMMUNITY_DID = 'did:plc:community123'

const TEST_TOPIC_URI = `at://${OTHER_DID}/forum.barazo.topic.post/topic123`
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
    appealReason: null,
    appealedAt: null,
    appealStatus: 'none',
    createdAt: new Date(TEST_NOW),
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Helper: build app with mocked deps
// ---------------------------------------------------------------------------

async function buildTestApp(user?: RequestUser): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })

  const authMiddleware = createMockAuthMiddleware(user)
  const requireAdmin = createMockRequireAdmin(undefined)

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

  await app.register(moderationRoutes())
  await app.ready()

  return app
}

// ===========================================================================
// Test suite
// ===========================================================================

describe('moderation appeal routes', () => {
  // =========================================================================
  // GET /api/moderation/my-reports
  // =========================================================================

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

    it("returns the caller's reports (paginated)", async () => {
      const reportRows = [sampleReport({ id: 2 }), sampleReport({ id: 1 })]
      selectChain.limit.mockResolvedValueOnce(reportRows)

      const response = await app.inject({
        method: 'GET',
        url: '/api/moderation/my-reports',
        headers: { authorization: 'Bearer test-token' },
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{
        reports: Array<{
          id: number
          reporterDid: string
          appealStatus: string
          appealReason: string | null
          appealedAt: string | null
          createdAt: string
        }>
        cursor: string | null
      }>()
      expect(body.reports).toHaveLength(2)
      expect(body.reports[0]?.id).toBe(2)
      expect(body.reports[0]?.reporterDid).toBe(TEST_DID)
      expect(body.reports[0]?.appealStatus).toBe('none')
      expect(body.reports[0]?.appealReason).toBeNull()
      expect(body.reports[0]?.appealedAt).toBeNull()
      expect(body.cursor).toBeNull()
    })

    it('returns empty list when no reports', async () => {
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

    it('returns cursor when more results exist', async () => {
      const baseDate = new Date('2026-02-13T12:00:00.000Z')
      const reportRows = Array.from({ length: 26 }, (_, i) => {
        const d = new Date(baseDate.getTime() - i * 3600000)
        return sampleReport({ id: 26 - i, createdAt: d })
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

  // =========================================================================
  // POST /api/moderation/reports/:id/appeal
  // =========================================================================

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

    it('successfully appeals a dismissed, resolved report', async () => {
      // Report found: resolved + dismissed + appealStatus none + reporter is current user
      selectChain.where.mockResolvedValueOnce([
        sampleReport({
          status: 'resolved',
          resolutionType: 'dismissed',
          resolvedBy: 'did:plc:mod1',
          resolvedAt: new Date(TEST_NOW),
          appealStatus: 'none',
        }),
      ])

      // Update returning
      const appealedReport = sampleReport({
        status: 'pending',
        resolutionType: 'dismissed',
        resolvedBy: 'did:plc:mod1',
        resolvedAt: new Date(TEST_NOW),
        appealReason: 'I disagree with the dismissal',
        appealedAt: new Date(),
        appealStatus: 'pending',
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
        id: number
        status: string
        appealReason: string
        appealStatus: string
      }>()
      expect(body.id).toBe(1)
      expect(body.status).toBe('pending')
      expect(body.appealReason).toBe('I disagree with the dismissal')
      expect(body.appealStatus).toBe('pending')

      expect(mockDb.update).toHaveBeenCalled()
    })

    it('returns 404 if report not found', async () => {
      selectChain.where.mockResolvedValueOnce([])

      const response = await app.inject({
        method: 'POST',
        url: '/api/moderation/reports/999/appeal',
        headers: { authorization: 'Bearer test-token' },
        payload: { reason: 'Please reconsider' },
      })

      expect(response.statusCode).toBe(404)
    })

    it('returns 403 if user is not the original reporter', async () => {
      selectChain.where.mockResolvedValueOnce([
        sampleReport({
          reporterDid: OTHER_DID, // different from TEST_DID
          status: 'resolved',
          resolutionType: 'dismissed',
          appealStatus: 'none',
        }),
      ])

      const response = await app.inject({
        method: 'POST',
        url: '/api/moderation/reports/1/appeal',
        headers: { authorization: 'Bearer test-token' },
        payload: { reason: 'I want to appeal' },
      })

      expect(response.statusCode).toBe(403)
    })

    it('returns 400 if report is not resolved', async () => {
      selectChain.where.mockResolvedValueOnce([
        sampleReport({
          status: 'pending',
          resolutionType: null,
          appealStatus: 'none',
        }),
      ])

      const response = await app.inject({
        method: 'POST',
        url: '/api/moderation/reports/1/appeal',
        headers: { authorization: 'Bearer test-token' },
        payload: { reason: 'Please reconsider' },
      })

      expect(response.statusCode).toBe(400)
    })

    it('returns 400 if report is not dismissed', async () => {
      selectChain.where.mockResolvedValueOnce([
        sampleReport({
          status: 'resolved',
          resolutionType: 'warned',
          resolvedBy: 'did:plc:mod1',
          resolvedAt: new Date(TEST_NOW),
          appealStatus: 'none',
        }),
      ])

      const response = await app.inject({
        method: 'POST',
        url: '/api/moderation/reports/1/appeal',
        headers: { authorization: 'Bearer test-token' },
        payload: { reason: 'I disagree' },
      })

      expect(response.statusCode).toBe(400)
    })

    it('returns 409 if already appealed', async () => {
      selectChain.where.mockResolvedValueOnce([
        sampleReport({
          status: 'resolved',
          resolutionType: 'dismissed',
          resolvedBy: 'did:plc:mod1',
          resolvedAt: new Date(TEST_NOW),
          appealStatus: 'pending',
          appealReason: 'First appeal',
          appealedAt: new Date(TEST_NOW),
        }),
      ])

      const response = await app.inject({
        method: 'POST',
        url: '/api/moderation/reports/1/appeal',
        headers: { authorization: 'Bearer test-token' },
        payload: { reason: 'Second appeal attempt' },
      })

      expect(response.statusCode).toBe(409)
    })

    it('returns 400 for invalid/empty reason', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/moderation/reports/1/appeal',
        headers: { authorization: 'Bearer test-token' },
        payload: { reason: '' },
      })

      expect(response.statusCode).toBe(400)
    })

    it('returns 400 for missing reason', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/moderation/reports/1/appeal',
        headers: { authorization: 'Bearer test-token' },
        payload: {},
      })

      expect(response.statusCode).toBe(400)
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
        payload: { reason: 'Please reconsider' },
      })

      expect(response.statusCode).toBe(401)
    })
  })
})
