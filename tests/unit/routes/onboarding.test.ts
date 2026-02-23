import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest'
import Fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import type { Env } from '../../../src/config/env.js'
import type { AuthMiddleware, RequestUser } from '../../../src/auth/middleware.js'
import type { SessionService } from '../../../src/auth/session.js'
import type { SetupService } from '../../../src/setup/service.js'
import { createChainableProxy, createMockDb } from '../../helpers/mock-db.js'
import type { MockDb } from '../../helpers/mock-db.js'
import { onboardingRoutes } from '../../../src/routes/onboarding.js'

// ---------------------------------------------------------------------------
// Mock env
// ---------------------------------------------------------------------------

const COMMUNITY_DID = 'did:plc:community123'

const mockEnv = {
  COMMUNITY_DID,
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
const TEST_NOW = '2026-02-15T12:00:00.000Z'

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
// Mock DB
// ---------------------------------------------------------------------------

const mockDb = createMockDb()

/**
 * Queue select results. Each call to db.select() will consume the next result.
 * Supports chaining through .from().where().orderBy() etc.
 */
function queueSelectResults(...results: unknown[][]): void {
  for (const result of results) {
    mockDb.select.mockReturnValueOnce(createChainableProxy(result))
  }
}

function resetAllDbMocks(): void {
  mockDb.select.mockReset()
  mockDb.insert.mockReturnValue(createChainableProxy())
  mockDb.update.mockReturnValue(createChainableProxy([]))
  mockDb.delete.mockReturnValue(createChainableProxy())
  // eslint-disable-next-line @typescript-eslint/no-misused-promises -- Intentionally async for Drizzle transaction mock
  mockDb.transaction.mockImplementation(async (fn: (tx: MockDb) => Promise<unknown>) => {
    return await fn(mockDb)
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

function sampleField(overrides?: Record<string, unknown>) {
  return {
    id: 'field-001',
    communityDid: COMMUNITY_DID,
    fieldType: 'custom_text',
    label: 'What brings you here?',
    description: 'Tell us about yourself',
    isMandatory: true,
    sortOrder: 0,
    config: null,
    createdAt: new Date(TEST_NOW),
    updatedAt: new Date(TEST_NOW),
    ...overrides,
  }
}

function sampleResponse(overrides?: Record<string, unknown>) {
  return {
    did: TEST_DID,
    communityDid: COMMUNITY_DID,
    fieldId: 'field-001',
    response: 'I love forums',
    completedAt: new Date(TEST_NOW),
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Helper: build test app
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

  await app.register(onboardingRoutes())
  await app.ready()

  return app
}

// ===========================================================================
// Admin routes
// ===========================================================================

describe('onboarding admin routes', () => {
  // =========================================================================
  // GET /api/admin/onboarding-fields
  // =========================================================================

  describe('GET /api/admin/onboarding-fields', () => {
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

    it('returns empty array when no fields configured', async () => {
      queueSelectResults([])

      const response = await app.inject({
        method: 'GET',
        url: '/api/admin/onboarding-fields',
        headers: { authorization: 'Bearer admin-token' },
      })

      expect(response.statusCode).toBe(200)
      expect(response.json()).toEqual([])
    })

    it('returns fields sorted by sortOrder', async () => {
      const fields = [
        sampleField({ id: 'field-001', sortOrder: 0 }),
        sampleField({
          id: 'field-002',
          sortOrder: 1,
          label: 'Accept ToS',
          fieldType: 'tos_acceptance',
        }),
      ]
      queueSelectResults(fields)

      const response = await app.inject({
        method: 'GET',
        url: '/api/admin/onboarding-fields',
        headers: { authorization: 'Bearer admin-token' },
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{ id: string }[]>()
      expect(body).toHaveLength(2)
      expect(body[0]?.id).toBe('field-001')
      expect(body[1]?.id).toBe('field-002')
    })

    it('rejects unauthenticated request', async () => {
      const unauthApp = await buildTestApp()

      const response = await unauthApp.inject({
        method: 'GET',
        url: '/api/admin/onboarding-fields',
      })

      expect(response.statusCode).toBe(401)
      await unauthApp.close()
    })

    it('rejects non-admin user', async () => {
      const nonAdminApp = await buildTestApp(testUser())

      const response = await nonAdminApp.inject({
        method: 'GET',
        url: '/api/admin/onboarding-fields',
        headers: { authorization: 'Bearer user-token' },
      })

      expect(response.statusCode).toBe(403)
      await nonAdminApp.close()
    })
  })

  // =========================================================================
  // POST /api/admin/onboarding-fields
  // =========================================================================

  describe('POST /api/admin/onboarding-fields', () => {
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

    it('creates a new onboarding field', async () => {
      const created = sampleField()
      const insertChain = createChainableProxy([created])
      mockDb.insert.mockReturnValueOnce(insertChain)

      const response = await app.inject({
        method: 'POST',
        url: '/api/admin/onboarding-fields',
        headers: {
          authorization: 'Bearer admin-token',
          'content-type': 'application/json',
        },
        payload: {
          fieldType: 'custom_text',
          label: 'What brings you here?',
          description: 'Tell us about yourself',
        },
      })

      expect(response.statusCode).toBe(201)
      const body = response.json<{ id: string; fieldType: string }>()
      expect(body.id).toBe('field-001')
      expect(body.fieldType).toBe('custom_text')
    })

    it('creates a tos_acceptance field', async () => {
      const created = sampleField({
        fieldType: 'tos_acceptance',
        label: 'Accept our Terms',
        config: { tosUrl: 'https://example.com/tos' },
      })
      const insertChain = createChainableProxy([created])
      mockDb.insert.mockReturnValueOnce(insertChain)

      const response = await app.inject({
        method: 'POST',
        url: '/api/admin/onboarding-fields',
        headers: {
          authorization: 'Bearer admin-token',
          'content-type': 'application/json',
        },
        payload: {
          fieldType: 'tos_acceptance',
          label: 'Accept our Terms',
          config: { tosUrl: 'https://example.com/tos' },
        },
      })

      expect(response.statusCode).toBe(201)
    })

    it('rejects invalid field type', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/admin/onboarding-fields',
        headers: {
          authorization: 'Bearer admin-token',
          'content-type': 'application/json',
        },
        payload: {
          fieldType: 'invalid_type',
          label: 'Test',
        },
      })

      expect(response.statusCode).toBe(400)
    })

    it('rejects empty label', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/admin/onboarding-fields',
        headers: {
          authorization: 'Bearer admin-token',
          'content-type': 'application/json',
        },
        payload: {
          fieldType: 'custom_text',
          label: '',
        },
      })

      expect(response.statusCode).toBe(400)
    })
  })

  // =========================================================================
  // PUT /api/admin/onboarding-fields/:id
  // =========================================================================

  describe('PUT /api/admin/onboarding-fields/:id', () => {
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

    it('updates a field label', async () => {
      const updated = sampleField({ label: 'Updated label' })
      const updateChain = createChainableProxy([updated])
      mockDb.update.mockReturnValueOnce(updateChain)

      const response = await app.inject({
        method: 'PUT',
        url: '/api/admin/onboarding-fields/field-001',
        headers: {
          authorization: 'Bearer admin-token',
          'content-type': 'application/json',
        },
        payload: { label: 'Updated label' },
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{ label: string }>()
      expect(body.label).toBe('Updated label')
    })

    it('returns 404 when field not found', async () => {
      const updateChain = createChainableProxy([])
      mockDb.update.mockReturnValueOnce(updateChain)

      const response = await app.inject({
        method: 'PUT',
        url: '/api/admin/onboarding-fields/nonexistent',
        headers: {
          authorization: 'Bearer admin-token',
          'content-type': 'application/json',
        },
        payload: { label: 'Updated' },
      })

      expect(response.statusCode).toBe(404)
    })

    it('rejects empty update body', async () => {
      const response = await app.inject({
        method: 'PUT',
        url: '/api/admin/onboarding-fields/field-001',
        headers: {
          authorization: 'Bearer admin-token',
          'content-type': 'application/json',
        },
        payload: {},
      })

      expect(response.statusCode).toBe(400)
    })
  })

  // =========================================================================
  // DELETE /api/admin/onboarding-fields/:id
  // =========================================================================

  describe('DELETE /api/admin/onboarding-fields/:id', () => {
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

    it('deletes a field and cleans up responses', async () => {
      const deleteChain = createChainableProxy([sampleField()])
      mockDb.delete.mockReturnValueOnce(deleteChain)
      // Second delete call for user responses cleanup
      const deleteResponsesChain = createChainableProxy([])
      mockDb.delete.mockReturnValueOnce(deleteResponsesChain)

      const response = await app.inject({
        method: 'DELETE',
        url: '/api/admin/onboarding-fields/field-001',
        headers: { authorization: 'Bearer admin-token' },
      })

      expect(response.statusCode).toBe(200)
      expect(response.json()).toEqual({ success: true })
    })

    it('returns 404 when field not found', async () => {
      const deleteChain = createChainableProxy([])
      mockDb.delete.mockReturnValueOnce(deleteChain)

      const response = await app.inject({
        method: 'DELETE',
        url: '/api/admin/onboarding-fields/nonexistent',
        headers: { authorization: 'Bearer admin-token' },
      })

      expect(response.statusCode).toBe(404)
    })
  })

  // =========================================================================
  // PUT /api/admin/onboarding-fields/reorder
  // =========================================================================

  describe('PUT /api/admin/onboarding-fields/reorder', () => {
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

    it('reorders fields and returns updated list', async () => {
      // Update calls for each field
      mockDb.update.mockReturnValue(createChainableProxy([]))

      // Select after reorder returns new ordering
      const reorderedFields = [
        sampleField({ id: 'field-002', sortOrder: 0 }),
        sampleField({ id: 'field-001', sortOrder: 1 }),
      ]
      queueSelectResults(reorderedFields)

      const response = await app.inject({
        method: 'PUT',
        url: '/api/admin/onboarding-fields/reorder',
        headers: {
          authorization: 'Bearer admin-token',
          'content-type': 'application/json',
        },
        payload: [
          { id: 'field-002', sortOrder: 0 },
          { id: 'field-001', sortOrder: 1 },
        ],
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{ id: string }[]>()
      expect(body).toHaveLength(2)
    })

    it('rejects empty reorder array', async () => {
      const response = await app.inject({
        method: 'PUT',
        url: '/api/admin/onboarding-fields/reorder',
        headers: {
          authorization: 'Bearer admin-token',
          'content-type': 'application/json',
        },
        payload: [],
      })

      expect(response.statusCode).toBe(400)
    })
  })
})

// ===========================================================================
// User routes
// ===========================================================================

describe('onboarding user routes', () => {
  // =========================================================================
  // GET /api/onboarding/status
  // =========================================================================

  describe('GET /api/onboarding/status', () => {
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

    it('returns complete=true when no onboarding fields exist', async () => {
      queueSelectResults([], []) // fields, responses

      const response = await app.inject({
        method: 'GET',
        url: '/api/onboarding/status',
        headers: { authorization: 'Bearer user-token' },
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{ complete: boolean; fields: unknown[] }>()
      expect(body.complete).toBe(true)
      expect(body.fields).toEqual([])
    })

    it('returns complete=false when mandatory field not answered', async () => {
      const field = sampleField({ isMandatory: true })
      queueSelectResults([field], []) // fields, no responses

      const response = await app.inject({
        method: 'GET',
        url: '/api/onboarding/status',
        headers: { authorization: 'Bearer user-token' },
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{ complete: boolean; fields: { completed: boolean }[] }>()
      expect(body.complete).toBe(false)
      expect(body.fields[0]?.completed).toBe(false)
    })

    it('returns complete=true when all mandatory fields answered', async () => {
      const field = sampleField({ isMandatory: true })
      queueSelectResults([field], [sampleResponse()])

      const response = await app.inject({
        method: 'GET',
        url: '/api/onboarding/status',
        headers: { authorization: 'Bearer user-token' },
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{ complete: boolean; fields: { completed: boolean }[] }>()
      expect(body.complete).toBe(true)
      expect(body.fields[0]?.completed).toBe(true)
    })

    it('ignores optional fields for completeness check', async () => {
      const mandatoryField = sampleField({ id: 'field-001', isMandatory: true })
      const optionalField = sampleField({
        id: 'field-002',
        isMandatory: false,
        label: 'Newsletter',
        fieldType: 'newsletter_email',
      })

      // Only mandatory field answered
      queueSelectResults(
        [mandatoryField, optionalField],
        [sampleResponse({ fieldId: 'field-001' })]
      )

      const response = await app.inject({
        method: 'GET',
        url: '/api/onboarding/status',
        headers: { authorization: 'Bearer user-token' },
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{ complete: boolean }>()
      expect(body.complete).toBe(true)
    })

    it('rejects unauthenticated request', async () => {
      const unauthApp = await buildTestApp()

      const response = await unauthApp.inject({
        method: 'GET',
        url: '/api/onboarding/status',
      })

      expect(response.statusCode).toBe(401)
      await unauthApp.close()
    })
  })

  // =========================================================================
  // POST /api/onboarding/submit
  // =========================================================================

  describe('POST /api/onboarding/submit', () => {
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

    it('submits valid responses and returns complete=true', async () => {
      const field = sampleField({ fieldType: 'custom_text' })
      // 1. Fetch fields for validation
      queueSelectResults([field])
      // 2. Insert (upsert) chain
      mockDb.insert.mockReturnValueOnce(createChainableProxy([]))
      // 3. Fetch all responses for completeness check
      queueSelectResults([sampleResponse()])

      const response = await app.inject({
        method: 'POST',
        url: '/api/onboarding/submit',
        headers: {
          authorization: 'Bearer user-token',
          'content-type': 'application/json',
        },
        payload: [{ fieldId: 'field-001', response: 'I love forums' }],
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{ success: boolean; complete: boolean }>()
      expect(body.success).toBe(true)
      expect(body.complete).toBe(true)
    })

    it('rejects submission with unknown field', async () => {
      queueSelectResults([]) // no fields in community

      const response = await app.inject({
        method: 'POST',
        url: '/api/onboarding/submit',
        headers: {
          authorization: 'Bearer user-token',
          'content-type': 'application/json',
        },
        payload: [{ fieldId: 'unknown-field', response: 'test' }],
      })

      expect(response.statusCode).toBe(400)
    })

    it('rejects invalid tos_acceptance value (false)', async () => {
      const field = sampleField({ fieldType: 'tos_acceptance', label: 'Accept ToS' })
      queueSelectResults([field])

      const response = await app.inject({
        method: 'POST',
        url: '/api/onboarding/submit',
        headers: {
          authorization: 'Bearer user-token',
          'content-type': 'application/json',
        },
        payload: [{ fieldId: 'field-001', response: false }],
      })

      expect(response.statusCode).toBe(400)
    })

    it('rejects empty submission array', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/onboarding/submit',
        headers: {
          authorization: 'Bearer user-token',
          'content-type': 'application/json',
        },
        payload: [],
      })

      expect(response.statusCode).toBe(400)
    })

    it('rejects unauthenticated request', async () => {
      const unauthApp = await buildTestApp()

      const response = await unauthApp.inject({
        method: 'POST',
        url: '/api/onboarding/submit',
        headers: { 'content-type': 'application/json' },
        payload: [{ fieldId: 'field-001', response: 'test' }],
      })

      expect(response.statusCode).toBe(401)
      await unauthApp.close()
    })
  })
})
