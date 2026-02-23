import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest'
import Fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import type { Env } from '../../../src/config/env.js'
import type { AuthMiddleware, RequestUser } from '../../../src/auth/middleware.js'
import type { SessionService } from '../../../src/auth/session.js'
import type { SetupService } from '../../../src/setup/service.js'
import {
  type DbChain,
  createChainableProxy,
  createMockDb,
  type MockDb,
} from '../../helpers/mock-db.js'
import { createRequireOperator } from '../../../src/auth/require-operator.js'
import { globalFilterRoutes } from '../../../src/routes/global-filters.js'

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const OPERATOR_DID = 'did:plc:operator123'
const OPERATOR_HANDLE = 'operator.bsky.social'
const OPERATOR_SID = 'o'.repeat(64)

const NON_OPERATOR_DID = 'did:plc:regularuser456'
const NON_OPERATOR_HANDLE = 'regular.bsky.social'
const NON_OPERATOR_SID = 'r'.repeat(64)

const TEST_COMMUNITY_DID = 'did:plc:community789'
const TEST_ACCOUNT_DID = 'did:plc:account999'
const TEST_NOW = new Date('2026-02-13T12:00:00.000Z')

// ---------------------------------------------------------------------------
// Mock user builders
// ---------------------------------------------------------------------------

function operatorUser(overrides?: Partial<RequestUser>): RequestUser {
  return {
    did: OPERATOR_DID,
    handle: OPERATOR_HANDLE,
    sid: OPERATOR_SID,
    ...overrides,
  }
}

function nonOperatorUser(overrides?: Partial<RequestUser>): RequestUser {
  return {
    did: NON_OPERATOR_DID,
    handle: NON_OPERATOR_HANDLE,
    sid: NON_OPERATOR_SID,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Mock env
// ---------------------------------------------------------------------------

const globalMockEnv = {
  COMMUNITY_MODE: 'multi',
  OPERATOR_DIDS: [OPERATOR_DID],
  RATE_LIMIT_WRITE: 10,
  RATE_LIMIT_READ_ANON: 100,
  RATE_LIMIT_READ_AUTH: 300,
} as unknown as Env

const singleMockEnv = {
  COMMUNITY_MODE: 'single',
  COMMUNITY_DID: 'did:plc:community123',
  OPERATOR_DIDS: [OPERATOR_DID],
  RATE_LIMIT_WRITE: 10,
  RATE_LIMIT_READ_ANON: 100,
  RATE_LIMIT_READ_AUTH: 300,
} as unknown as Env

// ---------------------------------------------------------------------------
// Chainable mock DB
// ---------------------------------------------------------------------------

const mockDb = createMockDb()

let insertChain: DbChain
let selectChain: DbChain

function resetAllDbMocks(): void {
  insertChain = createChainableProxy()
  selectChain = createChainableProxy([])
  mockDb.insert.mockReturnValue(insertChain)
  mockDb.select.mockReturnValue(selectChain)
  mockDb.update.mockReturnValue(createChainableProxy([]))
  mockDb.delete.mockReturnValue(createChainableProxy())
  // eslint-disable-next-line @typescript-eslint/no-misused-promises -- Intentionally async mock for Drizzle transaction
  mockDb.transaction.mockImplementation(async (fn: (tx: MockDb) => Promise<void>) => {
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
// Sample data builders
// ---------------------------------------------------------------------------

function sampleCommunityFilterRow(overrides?: Record<string, unknown>) {
  return {
    communityDid: TEST_COMMUNITY_DID,
    status: 'active',
    adminDid: null,
    reason: null,
    reportCount: 0,
    lastReviewedAt: null,
    filteredBy: null,
    createdAt: TEST_NOW,
    updatedAt: TEST_NOW,
    ...overrides,
  }
}

function sampleAccountFilterRow(overrides?: Record<string, unknown>) {
  return {
    id: 1,
    did: TEST_ACCOUNT_DID,
    communityDid: '__global__',
    status: 'active',
    reason: null,
    reportCount: 0,
    banCount: 0,
    lastReviewedAt: null,
    filteredBy: null,
    createdAt: TEST_NOW,
    updatedAt: TEST_NOW,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Helper: build app with mocked deps
// ---------------------------------------------------------------------------

async function buildTestApp(
  user?: RequestUser,
  env: Env = globalMockEnv
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })

  const authMiddleware = createMockAuthMiddleware(user)
  const requireOperator = createRequireOperator(env, authMiddleware)

  app.decorate('db', mockDb as never)
  app.decorate('env', env)
  app.decorate('authMiddleware', authMiddleware)
  app.decorate('oauthClient', {} as never)
  app.decorate('sessionService', {} as SessionService)
  app.decorate('setupService', {} as SetupService)
  app.decorate('cache', {} as never)
  app.decorate('requireOperator', requireOperator)
  app.decorateRequest('user', undefined as RequestUser | undefined)

  await app.register(globalFilterRoutes())
  await app.ready()

  return app
}

// ===========================================================================
// Test suite
// ===========================================================================

describe('global filter routes', () => {
  // =========================================================================
  // Access control: single mode returns 404
  // =========================================================================

  describe('single community mode (all routes return 404)', () => {
    let app: FastifyInstance

    beforeAll(async () => {
      app = await buildTestApp(operatorUser(), singleMockEnv)
    })

    afterAll(async () => {
      await app.close()
    })

    it('GET /api/global/filters/communities returns 404', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/global/filters/communities',
        headers: { authorization: 'Bearer test-token' },
      })
      expect(response.statusCode).toBe(404)
    })

    it('PUT /api/global/filters/communities/:did returns 404', async () => {
      const response = await app.inject({
        method: 'PUT',
        url: `/api/global/filters/communities/${TEST_COMMUNITY_DID}`,
        headers: { authorization: 'Bearer test-token' },
        payload: { status: 'filtered' },
      })
      expect(response.statusCode).toBe(404)
    })

    it('GET /api/global/filters/accounts returns 404', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/global/filters/accounts',
        headers: { authorization: 'Bearer test-token' },
      })
      expect(response.statusCode).toBe(404)
    })

    it('PUT /api/global/filters/accounts/:did returns 404', async () => {
      const response = await app.inject({
        method: 'PUT',
        url: `/api/global/filters/accounts/${TEST_ACCOUNT_DID}`,
        headers: { authorization: 'Bearer test-token' },
        payload: { status: 'filtered' },
      })
      expect(response.statusCode).toBe(404)
    })

    it('GET /api/global/reports/communities returns 404', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/global/reports/communities',
        headers: { authorization: 'Bearer test-token' },
      })
      expect(response.statusCode).toBe(404)
    })
  })

  // =========================================================================
  // Access control: non-operator returns 403
  // =========================================================================

  describe('non-operator user (all routes return 403)', () => {
    let app: FastifyInstance

    beforeAll(async () => {
      app = await buildTestApp(nonOperatorUser())
    })

    afterAll(async () => {
      await app.close()
    })

    it('GET /api/global/filters/communities returns 403', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/global/filters/communities',
        headers: { authorization: 'Bearer test-token' },
      })
      expect(response.statusCode).toBe(403)
    })

    it('PUT /api/global/filters/communities/:did returns 403', async () => {
      const response = await app.inject({
        method: 'PUT',
        url: `/api/global/filters/communities/${TEST_COMMUNITY_DID}`,
        headers: { authorization: 'Bearer test-token' },
        payload: { status: 'filtered' },
      })
      expect(response.statusCode).toBe(403)
    })

    it('GET /api/global/filters/accounts returns 403', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/global/filters/accounts',
        headers: { authorization: 'Bearer test-token' },
      })
      expect(response.statusCode).toBe(403)
    })

    it('PUT /api/global/filters/accounts/:did returns 403', async () => {
      const response = await app.inject({
        method: 'PUT',
        url: `/api/global/filters/accounts/${TEST_ACCOUNT_DID}`,
        headers: { authorization: 'Bearer test-token' },
        payload: { status: 'filtered' },
      })
      expect(response.statusCode).toBe(403)
    })

    it('GET /api/global/reports/communities returns 403', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/global/reports/communities',
        headers: { authorization: 'Bearer test-token' },
      })
      expect(response.statusCode).toBe(403)
    })
  })

  // =========================================================================
  // Access control: unauthenticated returns 401
  // =========================================================================

  describe('unauthenticated user (all routes return 401)', () => {
    let app: FastifyInstance

    beforeAll(async () => {
      app = await buildTestApp(undefined)
    })

    afterAll(async () => {
      await app.close()
    })

    it('GET /api/global/filters/communities returns 401', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/global/filters/communities',
      })
      expect(response.statusCode).toBe(401)
    })

    it('PUT /api/global/filters/communities/:did returns 401', async () => {
      const response = await app.inject({
        method: 'PUT',
        url: `/api/global/filters/communities/${TEST_COMMUNITY_DID}`,
        payload: { status: 'filtered' },
      })
      expect(response.statusCode).toBe(401)
    })

    it('GET /api/global/filters/accounts returns 401', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/global/filters/accounts',
      })
      expect(response.statusCode).toBe(401)
    })

    it('PUT /api/global/filters/accounts/:did returns 401', async () => {
      const response = await app.inject({
        method: 'PUT',
        url: `/api/global/filters/accounts/${TEST_ACCOUNT_DID}`,
        payload: { status: 'filtered' },
      })
      expect(response.statusCode).toBe(401)
    })

    it('GET /api/global/reports/communities returns 401', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/global/reports/communities',
      })
      expect(response.statusCode).toBe(401)
    })
  })

  // =========================================================================
  // GET /api/global/filters/communities
  // =========================================================================

  describe('GET /api/global/filters/communities', () => {
    let app: FastifyInstance

    beforeAll(async () => {
      app = await buildTestApp(operatorUser())
    })

    afterAll(async () => {
      await app.close()
    })

    beforeEach(() => {
      vi.clearAllMocks()
      resetAllDbMocks()
    })

    it('returns empty list when no filters exist', async () => {
      selectChain.limit.mockResolvedValueOnce([])

      const response = await app.inject({
        method: 'GET',
        url: '/api/global/filters/communities',
        headers: { authorization: 'Bearer test-token' },
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{ filters: unknown[]; cursor: string | null }>()
      expect(body.filters).toEqual([])
      expect(body.cursor).toBeNull()
    })

    it('returns community filters with serialized dates', async () => {
      const row = sampleCommunityFilterRow({
        status: 'warned',
        reason: 'Spam reports',
        filteredBy: OPERATOR_DID,
        lastReviewedAt: TEST_NOW,
      })
      selectChain.limit.mockResolvedValueOnce([row])

      const response = await app.inject({
        method: 'GET',
        url: '/api/global/filters/communities',
        headers: { authorization: 'Bearer test-token' },
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{
        filters: Array<Record<string, unknown>>
        cursor: string | null
      }>()
      expect(body.filters).toHaveLength(1)
      expect(body.filters[0]?.communityDid).toBe(TEST_COMMUNITY_DID)
      expect(body.filters[0]?.status).toBe('warned')
      expect(body.filters[0]?.reason).toBe('Spam reports')
      expect(body.filters[0]?.filteredBy).toBe(OPERATOR_DID)
      expect(body.filters[0]?.createdAt).toBe(TEST_NOW.toISOString())
      expect(body.filters[0]?.updatedAt).toBe(TEST_NOW.toISOString())
      expect(body.filters[0]?.lastReviewedAt).toBe(TEST_NOW.toISOString())
      expect(body.cursor).toBeNull()
    })

    it('returns null for lastReviewedAt when not set', async () => {
      const row = sampleCommunityFilterRow({ lastReviewedAt: null })
      selectChain.limit.mockResolvedValueOnce([row])

      const response = await app.inject({
        method: 'GET',
        url: '/api/global/filters/communities',
        headers: { authorization: 'Bearer test-token' },
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{ filters: Array<Record<string, unknown>> }>()
      expect(body.filters[0]?.lastReviewedAt).toBeNull()
    })

    it('returns pagination cursor when more results exist', async () => {
      // Default limit=25, so return 26 rows to trigger hasMore
      const rows = Array.from({ length: 26 }, (_, i) =>
        sampleCommunityFilterRow({
          communityDid: `did:plc:community${String(i)}`,
          updatedAt: new Date(
            `2026-02-${String(13 - Math.floor(i / 2)).padStart(2, '0')}T12:00:00.000Z`
          ),
        })
      )
      selectChain.limit.mockResolvedValueOnce(rows)

      const response = await app.inject({
        method: 'GET',
        url: '/api/global/filters/communities',
        headers: { authorization: 'Bearer test-token' },
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{ filters: unknown[]; cursor: string | null }>()
      expect(body.filters).toHaveLength(25)
      expect(body.cursor).toBeTruthy()
    })

    it('returns null cursor when fewer results than limit', async () => {
      const rows = [sampleCommunityFilterRow()]
      selectChain.limit.mockResolvedValueOnce(rows)

      const response = await app.inject({
        method: 'GET',
        url: '/api/global/filters/communities?limit=10',
        headers: { authorization: 'Bearer test-token' },
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{ filters: unknown[]; cursor: string | null }>()
      expect(body.filters).toHaveLength(1)
      expect(body.cursor).toBeNull()
    })

    it('filters by status query parameter', async () => {
      selectChain.limit.mockResolvedValueOnce([])

      const response = await app.inject({
        method: 'GET',
        url: '/api/global/filters/communities?status=filtered',
        headers: { authorization: 'Bearer test-token' },
      })

      expect(response.statusCode).toBe(200)
      expect(selectChain.where).toHaveBeenCalled()
    })

    it('accepts cursor parameter for pagination', async () => {
      const cursor = Buffer.from(
        JSON.stringify({ updatedAt: TEST_NOW.toISOString(), id: TEST_COMMUNITY_DID })
      ).toString('base64')
      selectChain.limit.mockResolvedValueOnce([])

      const response = await app.inject({
        method: 'GET',
        url: `/api/global/filters/communities?cursor=${encodeURIComponent(cursor)}`,
        headers: { authorization: 'Bearer test-token' },
      })

      expect(response.statusCode).toBe(200)
    })

    it('respects custom limit', async () => {
      selectChain.limit.mockResolvedValueOnce([])

      const response = await app.inject({
        method: 'GET',
        url: '/api/global/filters/communities?limit=5',
        headers: { authorization: 'Bearer test-token' },
      })

      expect(response.statusCode).toBe(200)
      expect(selectChain.limit).toHaveBeenCalled()
    })

    it('returns 400 for invalid limit (over max)', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/global/filters/communities?limit=999',
        headers: { authorization: 'Bearer test-token' },
      })

      expect(response.statusCode).toBe(400)
    })

    it('returns 400 for invalid limit (zero)', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/global/filters/communities?limit=0',
        headers: { authorization: 'Bearer test-token' },
      })

      expect(response.statusCode).toBe(400)
    })

    it('returns 400 for non-numeric limit', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/global/filters/communities?limit=abc',
        headers: { authorization: 'Bearer test-token' },
      })

      expect(response.statusCode).toBe(400)
    })
  })

  // =========================================================================
  // PUT /api/global/filters/communities/:did
  // =========================================================================

  describe('PUT /api/global/filters/communities/:did', () => {
    let app: FastifyInstance

    beforeAll(async () => {
      app = await buildTestApp(operatorUser())
    })

    afterAll(async () => {
      await app.close()
    })

    beforeEach(() => {
      vi.clearAllMocks()
      resetAllDbMocks()
    })

    it('upserts a community filter and returns the result', async () => {
      const upsertedRow = sampleCommunityFilterRow({
        status: 'filtered',
        reason: 'Repeated violations',
        filteredBy: OPERATOR_DID,
        lastReviewedAt: TEST_NOW,
      })
      insertChain.returning.mockResolvedValueOnce([upsertedRow])

      const response = await app.inject({
        method: 'PUT',
        url: `/api/global/filters/communities/${TEST_COMMUNITY_DID}`,
        headers: { authorization: 'Bearer test-token' },
        payload: {
          status: 'filtered',
          reason: 'Repeated violations',
        },
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<Record<string, unknown>>()
      expect(body.communityDid).toBe(TEST_COMMUNITY_DID)
      expect(body.status).toBe('filtered')
      expect(body.reason).toBe('Repeated violations')
      expect(body.filteredBy).toBe(OPERATOR_DID)
      expect(mockDb.insert).toHaveBeenCalledOnce()
    })

    it('upserts with adminDid', async () => {
      const adminDid = 'did:plc:communityadmin'
      const upsertedRow = sampleCommunityFilterRow({
        status: 'warned',
        adminDid,
        filteredBy: OPERATOR_DID,
        lastReviewedAt: TEST_NOW,
      })
      insertChain.returning.mockResolvedValueOnce([upsertedRow])

      const response = await app.inject({
        method: 'PUT',
        url: `/api/global/filters/communities/${TEST_COMMUNITY_DID}`,
        headers: { authorization: 'Bearer test-token' },
        payload: {
          status: 'warned',
          adminDid,
        },
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<Record<string, unknown>>()
      expect(body.adminDid).toBe(adminDid)
    })

    it('upserts with status only (reason and adminDid optional)', async () => {
      const upsertedRow = sampleCommunityFilterRow({
        status: 'active',
        filteredBy: OPERATOR_DID,
        lastReviewedAt: TEST_NOW,
      })
      insertChain.returning.mockResolvedValueOnce([upsertedRow])

      const response = await app.inject({
        method: 'PUT',
        url: `/api/global/filters/communities/${TEST_COMMUNITY_DID}`,
        headers: { authorization: 'Bearer test-token' },
        payload: {
          status: 'active',
        },
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<Record<string, unknown>>()
      expect(body.status).toBe('active')
    })

    it('returns 400 for missing status', async () => {
      const response = await app.inject({
        method: 'PUT',
        url: `/api/global/filters/communities/${TEST_COMMUNITY_DID}`,
        headers: { authorization: 'Bearer test-token' },
        payload: {
          reason: 'No status provided',
        },
      })

      expect(response.statusCode).toBe(400)
    })

    it('returns 400 for invalid status value', async () => {
      const response = await app.inject({
        method: 'PUT',
        url: `/api/global/filters/communities/${TEST_COMMUNITY_DID}`,
        headers: { authorization: 'Bearer test-token' },
        payload: {
          status: 'invalid_status',
        },
      })

      expect(response.statusCode).toBe(400)
    })

    it('returns 400 for reason exceeding max length', async () => {
      const response = await app.inject({
        method: 'PUT',
        url: `/api/global/filters/communities/${TEST_COMMUNITY_DID}`,
        headers: { authorization: 'Bearer test-token' },
        payload: {
          status: 'filtered',
          reason: 'A'.repeat(1001),
        },
      })

      expect(response.statusCode).toBe(400)
    })

    it('returns 400 when upsert fails (no row returned)', async () => {
      insertChain.returning.mockResolvedValueOnce([])

      const response = await app.inject({
        method: 'PUT',
        url: `/api/global/filters/communities/${TEST_COMMUNITY_DID}`,
        headers: { authorization: 'Bearer test-token' },
        payload: {
          status: 'filtered',
        },
      })

      expect(response.statusCode).toBe(400)
    })
  })

  // =========================================================================
  // GET /api/global/filters/accounts
  // =========================================================================

  describe('GET /api/global/filters/accounts', () => {
    let app: FastifyInstance

    beforeAll(async () => {
      app = await buildTestApp(operatorUser())
    })

    afterAll(async () => {
      await app.close()
    })

    beforeEach(() => {
      vi.clearAllMocks()
      resetAllDbMocks()
    })

    it('returns empty list when no account filters exist', async () => {
      selectChain.limit.mockResolvedValueOnce([])

      const response = await app.inject({
        method: 'GET',
        url: '/api/global/filters/accounts',
        headers: { authorization: 'Bearer test-token' },
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{ filters: unknown[]; cursor: string | null }>()
      expect(body.filters).toEqual([])
      expect(body.cursor).toBeNull()
    })

    it('returns account filters with serialized dates', async () => {
      const row = sampleAccountFilterRow({
        status: 'warned',
        reason: 'Spam behavior',
        filteredBy: OPERATOR_DID,
        lastReviewedAt: TEST_NOW,
      })
      selectChain.limit.mockResolvedValueOnce([row])

      const response = await app.inject({
        method: 'GET',
        url: '/api/global/filters/accounts',
        headers: { authorization: 'Bearer test-token' },
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{
        filters: Array<Record<string, unknown>>
        cursor: string | null
      }>()
      expect(body.filters).toHaveLength(1)
      expect(body.filters[0]?.did).toBe(TEST_ACCOUNT_DID)
      expect(body.filters[0]?.communityDid).toBe('__global__')
      expect(body.filters[0]?.status).toBe('warned')
      expect(body.filters[0]?.reason).toBe('Spam behavior')
      expect(body.filters[0]?.reportCount).toBe(0)
      expect(body.filters[0]?.banCount).toBe(0)
      expect(body.filters[0]?.createdAt).toBe(TEST_NOW.toISOString())
      expect(body.filters[0]?.updatedAt).toBe(TEST_NOW.toISOString())
      expect(body.filters[0]?.lastReviewedAt).toBe(TEST_NOW.toISOString())
      expect(body.cursor).toBeNull()
    })

    it('returns null for lastReviewedAt when not set', async () => {
      const row = sampleAccountFilterRow({ lastReviewedAt: null })
      selectChain.limit.mockResolvedValueOnce([row])

      const response = await app.inject({
        method: 'GET',
        url: '/api/global/filters/accounts',
        headers: { authorization: 'Bearer test-token' },
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{ filters: Array<Record<string, unknown>> }>()
      expect(body.filters[0]?.lastReviewedAt).toBeNull()
    })

    it('returns pagination cursor when more results exist', async () => {
      // Default limit=25, so return 26 rows to trigger hasMore
      const rows = Array.from({ length: 26 }, (_, i) =>
        sampleAccountFilterRow({
          id: i + 1,
          did: `did:plc:account${String(i)}`,
          updatedAt: new Date(
            `2026-02-${String(13 - Math.floor(i / 2)).padStart(2, '0')}T12:00:00.000Z`
          ),
        })
      )
      selectChain.limit.mockResolvedValueOnce(rows)

      const response = await app.inject({
        method: 'GET',
        url: '/api/global/filters/accounts',
        headers: { authorization: 'Bearer test-token' },
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{ filters: unknown[]; cursor: string | null }>()
      expect(body.filters).toHaveLength(25)
      expect(body.cursor).toBeTruthy()
    })

    it('returns null cursor when fewer results than limit', async () => {
      const rows = [sampleAccountFilterRow()]
      selectChain.limit.mockResolvedValueOnce(rows)

      const response = await app.inject({
        method: 'GET',
        url: '/api/global/filters/accounts?limit=10',
        headers: { authorization: 'Bearer test-token' },
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{ filters: unknown[]; cursor: string | null }>()
      expect(body.filters).toHaveLength(1)
      expect(body.cursor).toBeNull()
    })

    it('filters by status query parameter', async () => {
      selectChain.limit.mockResolvedValueOnce([])

      const response = await app.inject({
        method: 'GET',
        url: '/api/global/filters/accounts?status=filtered',
        headers: { authorization: 'Bearer test-token' },
      })

      expect(response.statusCode).toBe(200)
      expect(selectChain.where).toHaveBeenCalled()
    })

    it('filters by communityDid query parameter', async () => {
      selectChain.limit.mockResolvedValueOnce([])

      const response = await app.inject({
        method: 'GET',
        url: `/api/global/filters/accounts?communityDid=${TEST_COMMUNITY_DID}`,
        headers: { authorization: 'Bearer test-token' },
      })

      expect(response.statusCode).toBe(200)
      expect(selectChain.where).toHaveBeenCalled()
    })

    it('accepts cursor parameter for pagination', async () => {
      const cursor = Buffer.from(
        JSON.stringify({ updatedAt: TEST_NOW.toISOString(), id: 42 })
      ).toString('base64')
      selectChain.limit.mockResolvedValueOnce([])

      const response = await app.inject({
        method: 'GET',
        url: `/api/global/filters/accounts?cursor=${encodeURIComponent(cursor)}`,
        headers: { authorization: 'Bearer test-token' },
      })

      expect(response.statusCode).toBe(200)
    })

    it('respects custom limit', async () => {
      selectChain.limit.mockResolvedValueOnce([])

      const response = await app.inject({
        method: 'GET',
        url: '/api/global/filters/accounts?limit=5',
        headers: { authorization: 'Bearer test-token' },
      })

      expect(response.statusCode).toBe(200)
      expect(selectChain.limit).toHaveBeenCalled()
    })

    it('returns 400 for invalid limit (over max)', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/global/filters/accounts?limit=999',
        headers: { authorization: 'Bearer test-token' },
      })

      expect(response.statusCode).toBe(400)
    })

    it('returns 400 for invalid limit (zero)', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/global/filters/accounts?limit=0',
        headers: { authorization: 'Bearer test-token' },
      })

      expect(response.statusCode).toBe(400)
    })

    it('returns 400 for non-numeric limit', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/global/filters/accounts?limit=abc',
        headers: { authorization: 'Bearer test-token' },
      })

      expect(response.statusCode).toBe(400)
    })
  })

  // =========================================================================
  // PUT /api/global/filters/accounts/:did
  // =========================================================================

  describe('PUT /api/global/filters/accounts/:did', () => {
    let app: FastifyInstance

    beforeAll(async () => {
      app = await buildTestApp(operatorUser())
    })

    afterAll(async () => {
      await app.close()
    })

    beforeEach(() => {
      vi.clearAllMocks()
      resetAllDbMocks()
    })

    it('upserts an account filter and returns the result', async () => {
      const upsertedRow = sampleAccountFilterRow({
        status: 'filtered',
        reason: 'Abusive behavior',
        filteredBy: OPERATOR_DID,
        lastReviewedAt: TEST_NOW,
      })
      insertChain.returning.mockResolvedValueOnce([upsertedRow])

      const response = await app.inject({
        method: 'PUT',
        url: `/api/global/filters/accounts/${TEST_ACCOUNT_DID}`,
        headers: { authorization: 'Bearer test-token' },
        payload: {
          status: 'filtered',
          reason: 'Abusive behavior',
        },
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<Record<string, unknown>>()
      expect(body.did).toBe(TEST_ACCOUNT_DID)
      expect(body.communityDid).toBe('__global__')
      expect(body.status).toBe('filtered')
      expect(body.reason).toBe('Abusive behavior')
      expect(body.filteredBy).toBe(OPERATOR_DID)
      expect(mockDb.insert).toHaveBeenCalledOnce()
    })

    it('upserts with status only (reason optional)', async () => {
      const upsertedRow = sampleAccountFilterRow({
        status: 'warned',
        filteredBy: OPERATOR_DID,
        lastReviewedAt: TEST_NOW,
      })
      insertChain.returning.mockResolvedValueOnce([upsertedRow])

      const response = await app.inject({
        method: 'PUT',
        url: `/api/global/filters/accounts/${TEST_ACCOUNT_DID}`,
        headers: { authorization: 'Bearer test-token' },
        payload: {
          status: 'warned',
        },
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<Record<string, unknown>>()
      expect(body.status).toBe('warned')
    })

    it('sets communityDid to __global__ sentinel', async () => {
      const upsertedRow = sampleAccountFilterRow({
        status: 'active',
        communityDid: '__global__',
        filteredBy: OPERATOR_DID,
        lastReviewedAt: TEST_NOW,
      })
      insertChain.returning.mockResolvedValueOnce([upsertedRow])

      const response = await app.inject({
        method: 'PUT',
        url: `/api/global/filters/accounts/${TEST_ACCOUNT_DID}`,
        headers: { authorization: 'Bearer test-token' },
        payload: {
          status: 'active',
        },
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<Record<string, unknown>>()
      expect(body.communityDid).toBe('__global__')
    })

    it('returns 400 for missing status', async () => {
      const response = await app.inject({
        method: 'PUT',
        url: `/api/global/filters/accounts/${TEST_ACCOUNT_DID}`,
        headers: { authorization: 'Bearer test-token' },
        payload: {
          reason: 'No status provided',
        },
      })

      expect(response.statusCode).toBe(400)
    })

    it('returns 400 for invalid status value', async () => {
      const response = await app.inject({
        method: 'PUT',
        url: `/api/global/filters/accounts/${TEST_ACCOUNT_DID}`,
        headers: { authorization: 'Bearer test-token' },
        payload: {
          status: 'banned',
        },
      })

      expect(response.statusCode).toBe(400)
    })

    it('returns 400 for reason exceeding max length', async () => {
      const response = await app.inject({
        method: 'PUT',
        url: `/api/global/filters/accounts/${TEST_ACCOUNT_DID}`,
        headers: { authorization: 'Bearer test-token' },
        payload: {
          status: 'filtered',
          reason: 'A'.repeat(1001),
        },
      })

      expect(response.statusCode).toBe(400)
    })

    it('returns 400 when upsert fails (no row returned)', async () => {
      insertChain.returning.mockResolvedValueOnce([])

      const response = await app.inject({
        method: 'PUT',
        url: `/api/global/filters/accounts/${TEST_ACCOUNT_DID}`,
        headers: { authorization: 'Bearer test-token' },
        payload: {
          status: 'filtered',
        },
      })

      expect(response.statusCode).toBe(400)
    })
  })

  // =========================================================================
  // GET /api/global/reports/communities
  // =========================================================================

  describe('GET /api/global/reports/communities', () => {
    let app: FastifyInstance

    beforeAll(async () => {
      app = await buildTestApp(operatorUser())
    })

    afterAll(async () => {
      await app.close()
    })

    beforeEach(() => {
      vi.clearAllMocks()
      resetAllDbMocks()
    })

    it('returns aggregated report counts', async () => {
      const rows = [
        { community_did: 'did:plc:community1', report_count: 15, topic_count: 42 },
        { community_did: 'did:plc:community2', report_count: 7, topic_count: 20 },
      ]
      mockDb.execute.mockResolvedValueOnce(rows)

      const response = await app.inject({
        method: 'GET',
        url: '/api/global/reports/communities',
        headers: { authorization: 'Bearer test-token' },
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{
        communities: Array<{ communityDid: string; reportCount: number; topicCount: number }>
      }>()
      expect(body.communities).toHaveLength(2)
      expect(body.communities[0]?.communityDid).toBe('did:plc:community1')
      expect(body.communities[0]?.reportCount).toBe(15)
      expect(body.communities[0]?.topicCount).toBe(42)
      expect(body.communities[1]?.communityDid).toBe('did:plc:community2')
      expect(body.communities[1]?.reportCount).toBe(7)
      expect(body.communities[1]?.topicCount).toBe(20)
    })

    it('returns empty list when no reports exist', async () => {
      mockDb.execute.mockResolvedValueOnce([])

      const response = await app.inject({
        method: 'GET',
        url: '/api/global/reports/communities',
        headers: { authorization: 'Bearer test-token' },
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{ communities: unknown[] }>()
      expect(body.communities).toEqual([])
    })

    it('respects custom limit', async () => {
      mockDb.execute.mockResolvedValueOnce([])

      const response = await app.inject({
        method: 'GET',
        url: '/api/global/reports/communities?limit=5',
        headers: { authorization: 'Bearer test-token' },
      })

      expect(response.statusCode).toBe(200)
      expect(mockDb.execute).toHaveBeenCalledOnce()
    })

    it('uses default limit of 25 when not specified', async () => {
      mockDb.execute.mockResolvedValueOnce([])

      const response = await app.inject({
        method: 'GET',
        url: '/api/global/reports/communities',
        headers: { authorization: 'Bearer test-token' },
      })

      expect(response.statusCode).toBe(200)
      expect(mockDb.execute).toHaveBeenCalledOnce()
    })

    it('handles communities with zero topic counts', async () => {
      const rows = [{ community_did: 'did:plc:community1', report_count: 3, topic_count: 0 }]
      mockDb.execute.mockResolvedValueOnce(rows)

      const response = await app.inject({
        method: 'GET',
        url: '/api/global/reports/communities',
        headers: { authorization: 'Bearer test-token' },
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{
        communities: Array<{ communityDid: string; reportCount: number; topicCount: number }>
      }>()
      expect(body.communities).toHaveLength(1)
      expect(body.communities[0]?.topicCount).toBe(0)
    })
  })
})
