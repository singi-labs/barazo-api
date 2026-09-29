import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest'
import Fastify from 'fastify'
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import type { Env } from '../../../src/config/env.js'
import type { AuthMiddleware, RequestUser } from '../../../src/auth/middleware.js'
import type { SessionService } from '../../../src/auth/session.js'
import type { SetupService } from '../../../src/setup/service.js'
import { type DbChain, createChainableProxy, createMockDb } from '../../helpers/mock-db.js'

// ---------------------------------------------------------------------------
// Mock requireAdmin module (must be before importing routes)
// ---------------------------------------------------------------------------

const mockRequireAdmin = vi.fn<(request: FastifyRequest, reply: FastifyReply) => Promise<void>>()

vi.mock('../../../src/auth/require-admin.js', () => ({
  createRequireAdmin: () => mockRequireAdmin,
}))

// Import routes AFTER mocking
import { communityRulesRoutes } from '../../../src/routes/community-rules.js'

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

const ADMIN_DID = 'did:plc:admin1'
const ADMIN_HANDLE = 'admin.bsky.team'
const ADMIN_SID = 'a'.repeat(64)
const COMMUNITY_DID = 'did:plc:community123'
const TEST_NOW = '2026-03-10T12:00:00.000Z'

// ---------------------------------------------------------------------------
// Mock user builders
// ---------------------------------------------------------------------------

function adminUser(overrides?: Partial<RequestUser>): RequestUser {
  return {
    did: ADMIN_DID,
    handle: ADMIN_HANDLE,
    sid: ADMIN_SID,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Chainable mock DB
// ---------------------------------------------------------------------------

const mockDb = createMockDb()

let insertChain: DbChain
let selectChain: DbChain
let updateChain: DbChain

function resetAllDbMocks(): void {
  insertChain = createChainableProxy()
  selectChain = createChainableProxy([])
  updateChain = createChainableProxy([])
  mockDb.insert.mockReturnValue(insertChain)
  mockDb.select.mockReturnValue(selectChain)
  mockDb.update.mockReturnValue(updateChain)
  mockDb.delete.mockReturnValue(createChainableProxy())
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

function sampleRule(overrides?: Record<string, unknown>) {
  return {
    id: 1,
    communityDid: COMMUNITY_DID,
    title: 'Be respectful',
    description: 'Treat all members with respect and courtesy.',
    displayOrder: 0,
    createdAt: new Date(TEST_NOW),
    updatedAt: new Date(TEST_NOW),
    archivedAt: null,
    ...overrides,
  }
}

function sampleRuleVersion(overrides?: Record<string, unknown>) {
  return {
    id: 1,
    ruleId: 1,
    title: 'Be respectful',
    description: 'Treat all members with respect and courtesy.',
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

  app.decorate('db', mockDb as never)
  app.decorate('env', mockEnv)
  app.decorate('authMiddleware', authMiddleware)
  app.decorate('firehose', {} as never)
  app.decorate('oauthClient', {} as never)
  app.decorate('sessionService', {} as SessionService)
  app.decorate('setupService', {} as SetupService)
  app.decorate('cache', {} as never)
  app.decorateRequest('user', undefined as RequestUser | undefined)
  app.decorateRequest('communityDid', undefined as string | undefined)
  app.addHook('onRequest', (request, _reply, done) => {
    request.communityDid = COMMUNITY_DID
    done()
  })

  await app.register(communityRulesRoutes())
  await app.ready()

  return app
}

// ===========================================================================
// Test suite
// ===========================================================================

describe('community rules routes', () => {
  // =========================================================================
  // GET /api/communities/:did/rules
  // =========================================================================

  describe('GET /api/communities/:did/rules', () => {
    let app: FastifyInstance

    beforeAll(async () => {
      app = await buildTestApp()
    })

    afterAll(async () => {
      await app.close()
    })

    beforeEach(() => {
      vi.clearAllMocks()
      resetAllDbMocks()
    })

    it('should return active rules in display order', async () => {
      const rules = [
        sampleRule({ id: 1, displayOrder: 0 }),
        sampleRule({ id: 2, title: 'No spam', displayOrder: 1 }),
      ]
      selectChain = createChainableProxy(rules)
      mockDb.select.mockReturnValue(selectChain)

      const res = await app.inject({
        method: 'GET',
        url: `/api/communities/${COMMUNITY_DID}/rules`,
      })

      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body) as { data: unknown[] }
      expect(body.data).toHaveLength(2)
    })

    it('should return empty array when no rules exist', async () => {
      selectChain = createChainableProxy([])
      mockDb.select.mockReturnValue(selectChain)

      const res = await app.inject({
        method: 'GET',
        url: `/api/communities/${COMMUNITY_DID}/rules`,
      })

      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body) as { data: unknown[] }
      expect(body.data).toHaveLength(0)
    })

    it('should be accessible without authentication', async () => {
      selectChain = createChainableProxy([])
      mockDb.select.mockReturnValue(selectChain)

      const res = await app.inject({
        method: 'GET',
        url: `/api/communities/${COMMUNITY_DID}/rules`,
      })

      expect(res.statusCode).toBe(200)
    })
  })

  // =========================================================================
  // POST /api/communities/:did/rules
  // =========================================================================

  describe('POST /api/communities/:did/rules', () => {
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

      mockRequireAdmin.mockImplementation((request) => {
        request.user = adminUser()
        return Promise.resolve()
      })
    })

    it('should create a rule with initial version', async () => {
      const created = sampleRule()
      // First select: max display order
      selectChain = createChainableProxy([{ maxOrder: 0 }])
      mockDb.select.mockReturnValue(selectChain)
      // Transaction inserts
      insertChain = createChainableProxy()
      insertChain.returning.mockResolvedValueOnce([created])
      mockDb.insert.mockReturnValue(insertChain)

      const res = await app.inject({
        method: 'POST',
        url: `/api/communities/${COMMUNITY_DID}/rules`,
        payload: { title: 'Be respectful', description: 'Treat all members with respect.' },
      })

      expect(res.statusCode).toBe(201)
      const body = JSON.parse(res.body) as { id: number; title: string }
      expect(body.title).toBe('Be respectful')
    })

    it('should reject missing title', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/communities/${COMMUNITY_DID}/rules`,
        payload: { description: 'Some description' },
      })

      expect(res.statusCode).toBe(400)
    })

    it('should reject missing description', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/communities/${COMMUNITY_DID}/rules`,
        payload: { title: 'A rule' },
      })

      expect(res.statusCode).toBe(400)
    })

    it('should reject title exceeding 200 chars', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/communities/${COMMUNITY_DID}/rules`,
        payload: { title: 'x'.repeat(201), description: 'desc' },
      })

      expect(res.statusCode).toBe(400)
    })

    it('should require admin access', async () => {
      mockRequireAdmin.mockImplementation(async (_request, reply) => {
        await reply.status(403).send({ error: 'Admin access required' })
      })

      const res = await app.inject({
        method: 'POST',
        url: `/api/communities/${COMMUNITY_DID}/rules`,
        payload: { title: 'A rule', description: 'desc' },
      })

      expect(res.statusCode).toBe(403)
    })
  })

  // =========================================================================
  // PUT /api/communities/:did/rules/:id
  // =========================================================================

  describe('PUT /api/communities/:did/rules/:id', () => {
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

      mockRequireAdmin.mockImplementation((request) => {
        request.user = adminUser()
        return Promise.resolve()
      })
    })

    it('should update a rule and create a new version', async () => {
      const existing = sampleRule()
      const updated = sampleRule({ title: 'Updated title', updatedAt: new Date() })

      // First select: find existing rule
      selectChain = createChainableProxy([existing])
      mockDb.select.mockReturnValue(selectChain)
      // Transaction: update + insert version
      updateChain = createChainableProxy()
      updateChain.returning.mockResolvedValueOnce([updated])
      mockDb.update.mockReturnValue(updateChain)
      insertChain = createChainableProxy()
      mockDb.insert.mockReturnValue(insertChain)

      const res = await app.inject({
        method: 'PUT',
        url: `/api/communities/${COMMUNITY_DID}/rules/1`,
        payload: { title: 'Updated title', description: 'Updated description' },
      })

      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body) as { title: string }
      expect(body.title).toBe('Updated title')
    })

    it('should return 404 for non-existent rule', async () => {
      selectChain = createChainableProxy([])
      mockDb.select.mockReturnValue(selectChain)

      const res = await app.inject({
        method: 'PUT',
        url: `/api/communities/${COMMUNITY_DID}/rules/999`,
        payload: { title: 'Updated', description: 'Updated' },
      })

      expect(res.statusCode).toBe(404)
    })

    it('should reject invalid rule ID', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: `/api/communities/${COMMUNITY_DID}/rules/abc`,
        payload: { title: 'Updated', description: 'Updated' },
      })

      expect(res.statusCode).toBe(400)
    })
  })

  // =========================================================================
  // DELETE /api/communities/:did/rules/:id
  // =========================================================================

  describe('DELETE /api/communities/:did/rules/:id', () => {
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

      mockRequireAdmin.mockImplementation((request) => {
        request.user = adminUser()
        return Promise.resolve()
      })
    })

    it('should archive (soft-delete) a rule', async () => {
      selectChain = createChainableProxy([sampleRule()])
      mockDb.select.mockReturnValue(selectChain)

      const res = await app.inject({
        method: 'DELETE',
        url: `/api/communities/${COMMUNITY_DID}/rules/1`,
      })

      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body) as { success: boolean }
      expect(body.success).toBe(true)
    })

    it('should return 404 for non-existent rule', async () => {
      selectChain = createChainableProxy([])
      mockDb.select.mockReturnValue(selectChain)

      const res = await app.inject({
        method: 'DELETE',
        url: `/api/communities/${COMMUNITY_DID}/rules/999`,
      })

      expect(res.statusCode).toBe(404)
    })

    it('should require admin access', async () => {
      mockRequireAdmin.mockImplementation(async (_request, reply) => {
        await reply.status(403).send({ error: 'Admin access required' })
      })

      const res = await app.inject({
        method: 'DELETE',
        url: `/api/communities/${COMMUNITY_DID}/rules/1`,
      })

      expect(res.statusCode).toBe(403)
    })
  })

  // =========================================================================
  // PUT /api/communities/:did/rules/reorder
  // =========================================================================

  describe('PUT /api/communities/:did/rules/reorder', () => {
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

      mockRequireAdmin.mockImplementation((request) => {
        request.user = adminUser()
        return Promise.resolve()
      })
    })

    it('should reorder rules', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: `/api/communities/${COMMUNITY_DID}/rules/reorder`,
        payload: {
          order: [
            { id: 1, displayOrder: 1 },
            { id: 2, displayOrder: 0 },
          ],
        },
      })

      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body) as { success: boolean }
      expect(body.success).toBe(true)
    })

    it('should reject empty order array', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: `/api/communities/${COMMUNITY_DID}/rules/reorder`,
        payload: { order: [] },
      })

      expect(res.statusCode).toBe(400)
    })
  })

  // =========================================================================
  // GET /api/communities/:did/rules/:id/versions
  // =========================================================================

  describe('GET /api/communities/:did/rules/:id/versions', () => {
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

      mockRequireAdmin.mockImplementation((request) => {
        request.user = adminUser()
        return Promise.resolve()
      })
    })

    it('should return version history for a rule', async () => {
      const rule = sampleRule()
      const versions = [
        sampleRuleVersion({ id: 2, title: 'Updated title' }),
        sampleRuleVersion({ id: 1 }),
      ]

      // First select: verify rule exists
      const ruleSelectChain = createChainableProxy([rule])
      // Second select: get versions
      const versionSelectChain = createChainableProxy(versions)

      mockDb.select.mockReturnValueOnce(ruleSelectChain).mockReturnValueOnce(versionSelectChain)

      const res = await app.inject({
        method: 'GET',
        url: `/api/communities/${COMMUNITY_DID}/rules/1/versions`,
      })

      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body) as { data: unknown[]; cursor: string | null }
      expect(body.data).toHaveLength(2)
      expect(body.cursor).toBeNull()
    })

    it('should return 404 for non-existent rule', async () => {
      selectChain = createChainableProxy([])
      mockDb.select.mockReturnValue(selectChain)

      const res = await app.inject({
        method: 'GET',
        url: `/api/communities/${COMMUNITY_DID}/rules/999/versions`,
      })

      expect(res.statusCode).toBe(404)
    })

    it('should require admin access', async () => {
      mockRequireAdmin.mockImplementation(async (_request, reply) => {
        await reply.status(403).send({ error: 'Admin access required' })
      })

      const res = await app.inject({
        method: 'GET',
        url: `/api/communities/${COMMUNITY_DID}/rules/1/versions`,
      })

      expect(res.statusCode).toBe(403)
    })
  })
})
