import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import Fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import { setupRoutes } from '../../../src/routes/setup.js'
import type { SetupService, SetupStatus, InitializeResult } from '../../../src/setup/service.js'
import type { AuthMiddleware, RequestUser } from '../../../src/auth/middleware.js'
import type { SessionService, Session } from '../../../src/auth/session.js'

// ---------------------------------------------------------------------------
// Standalone mock functions
// ---------------------------------------------------------------------------

const getStatusFn = vi.fn<() => Promise<SetupStatus>>()
const initializeFn = vi.fn<(...args: unknown[]) => Promise<InitializeResult>>()

const mockSetupService: SetupService = {
  getStatus: getStatusFn,
  initialize: initializeFn as SetupService['initialize'],
}

// Session validation mock (used by auth middleware)
const validateAccessTokenFn = vi.fn<(...args: unknown[]) => Promise<Session | undefined>>()

const mockSessionService: SessionService = {
  createSession: vi.fn(),
  validateAccessToken: validateAccessTokenFn,
  refreshSession: vi.fn(),
  deleteSession: vi.fn(),
  deleteAllSessionsForDid: vi.fn(),
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TEST_DID = 'did:plc:test123456789'
const TEST_HANDLE = 'alice.bsky.social'
const TEST_SID = 's'.repeat(64)
const TEST_ACCESS_TOKEN = 'a'.repeat(64)

function makeMockSession(): Session {
  return {
    sid: TEST_SID,
    did: TEST_DID,
    handle: TEST_HANDLE,
    accessTokenHash: 'h'.repeat(64),
    accessTokenExpiresAt: Date.now() + 900_000,
    createdAt: Date.now(),
  }
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('setup routes', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    app = Fastify({ logger: false })

    // Create real auth middleware using mock session service
    // (matches the codebase pattern from middleware.ts)
    const { createAuthMiddleware } = await import('../../../src/auth/middleware.js')
    const mockLogger = {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
      fatal: vi.fn(),
      trace: vi.fn(),
      child: vi.fn(),
      silent: vi.fn(),
      level: 'silent',
    }
    const mockDidVerifier = { verify: vi.fn().mockResolvedValue({ active: true }) }
    const authMiddleware: AuthMiddleware = createAuthMiddleware(
      mockSessionService,
      mockDidVerifier,
      mockLogger as never
    )

    // Decorate with mocks
    app.decorate('setupService', mockSetupService)
    app.decorate('authMiddleware', authMiddleware)

    // Fastify requires decoration before hooks can set properties
    app.decorateRequest('user', undefined as RequestUser | undefined)
    app.decorateRequest('communityDid', undefined as string | undefined)
    app.addHook('onRequest', async (request) => {
      request.communityDid = 'did:plc:test'
    })

    // Register setup routes
    await app.register(setupRoutes())
    await app.ready()
  })

  afterAll(async () => {
    await app.close()
  })

  beforeEach(() => {
    vi.clearAllMocks()
  })

  // =========================================================================
  // GET /api/setup/status
  // =========================================================================

  describe('GET /api/setup/status', () => {
    it('returns { initialized: false } when no settings row exists', async () => {
      getStatusFn.mockResolvedValueOnce({ initialized: false })

      const response = await app.inject({
        method: 'GET',
        url: '/api/setup/status',
      })

      expect(response.statusCode).toBe(200)
      expect(response.json()).toStrictEqual({ initialized: false })
    })

    it('returns { initialized: false } when settings exist but not initialized', async () => {
      getStatusFn.mockResolvedValueOnce({ initialized: false })

      const response = await app.inject({
        method: 'GET',
        url: '/api/setup/status',
      })

      expect(response.statusCode).toBe(200)
      expect(response.json()).toStrictEqual({ initialized: false })
    })

    it('returns { initialized: true, communityName } when initialized', async () => {
      getStatusFn.mockResolvedValueOnce({
        initialized: true,
        communityName: 'My Forum',
      })

      const response = await app.inject({
        method: 'GET',
        url: '/api/setup/status',
      })

      expect(response.statusCode).toBe(200)
      expect(response.json()).toStrictEqual({
        initialized: true,
        communityName: 'My Forum',
      })
    })

    it('returns 500 when service throws', async () => {
      getStatusFn.mockRejectedValueOnce(new Error('DB down'))

      const response = await app.inject({
        method: 'GET',
        url: '/api/setup/status',
      })

      expect(response.statusCode).toBe(500)
      const body = response.json<{ error: string; message: string; statusCode: number }>()
      expect(body.error).toBe('Internal Server Error')
      expect(body.message).toBe('Service temporarily unavailable')
      expect(body.statusCode).toBe(500)
    })
  })

  // =========================================================================
  // POST /api/setup/initialize
  // =========================================================================

  describe('POST /api/setup/initialize', () => {
    it('returns 401 without authentication', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/setup/initialize',
        payload: {},
      })

      expect(response.statusCode).toBe(401)
      expect(response.json<{ error: string }>().error).toBe('Authentication required')
      expect(initializeFn).not.toHaveBeenCalled()
    })

    it('returns 200 and sets admin DID for first authenticated user', async () => {
      validateAccessTokenFn.mockResolvedValueOnce(makeMockSession())
      initializeFn.mockResolvedValueOnce({
        initialized: true,
        adminDid: TEST_DID,
        communityName: 'Barazo Community',
      })

      const response = await app.inject({
        method: 'POST',
        url: '/api/setup/initialize',
        headers: {
          authorization: `Bearer ${TEST_ACCESS_TOKEN}`,
        },
        payload: {},
      })

      expect(response.statusCode).toBe(200)
      expect(response.json()).toStrictEqual({
        initialized: true,
        adminDid: TEST_DID,
        communityName: 'Barazo Community',
      })
      expect(initializeFn).toHaveBeenCalledWith({
        communityDid: 'did:plc:test',
        did: TEST_DID,
        communityName: undefined,
        handle: undefined,
        serviceEndpoint: undefined,
      })
    })

    it('returns 409 when already initialized', async () => {
      validateAccessTokenFn.mockResolvedValueOnce(makeMockSession())
      initializeFn.mockResolvedValueOnce({ alreadyInitialized: true })

      const response = await app.inject({
        method: 'POST',
        url: '/api/setup/initialize',
        headers: {
          authorization: `Bearer ${TEST_ACCESS_TOKEN}`,
        },
        payload: {},
      })

      expect(response.statusCode).toBe(409)
      expect(response.json<{ error: string }>().error).toBe('Community already initialized')
    })

    it('accepts optional communityName in request body', async () => {
      validateAccessTokenFn.mockResolvedValueOnce(makeMockSession())
      initializeFn.mockResolvedValueOnce({
        initialized: true,
        adminDid: TEST_DID,
        communityName: 'Custom Forum Name',
      })

      const response = await app.inject({
        method: 'POST',
        url: '/api/setup/initialize',
        headers: {
          authorization: `Bearer ${TEST_ACCESS_TOKEN}`,
          'content-type': 'application/json',
        },
        payload: { communityName: 'Custom Forum Name' },
      })

      expect(response.statusCode).toBe(200)
      expect(response.json()).toStrictEqual({
        initialized: true,
        adminDid: TEST_DID,
        communityName: 'Custom Forum Name',
      })
      expect(initializeFn).toHaveBeenCalledWith({
        communityDid: 'did:plc:test',
        did: TEST_DID,
        communityName: 'Custom Forum Name',
        handle: undefined,
        serviceEndpoint: undefined,
      })
    })

    it('returns 400 for invalid communityName (empty string)', async () => {
      validateAccessTokenFn.mockResolvedValueOnce(makeMockSession())

      const response = await app.inject({
        method: 'POST',
        url: '/api/setup/initialize',
        headers: {
          authorization: `Bearer ${TEST_ACCESS_TOKEN}`,
          'content-type': 'application/json',
        },
        payload: { communityName: '' },
      })

      expect(response.statusCode).toBe(400)
      expect(response.json<{ error: string }>().error).toBe('Invalid request body')
    })

    it('returns 400 for communityName exceeding max length', async () => {
      validateAccessTokenFn.mockResolvedValueOnce(makeMockSession())

      const response = await app.inject({
        method: 'POST',
        url: '/api/setup/initialize',
        headers: {
          authorization: `Bearer ${TEST_ACCESS_TOKEN}`,
          'content-type': 'application/json',
        },
        payload: { communityName: 'x'.repeat(256) },
      })

      expect(response.statusCode).toBe(400)
      expect(response.json<{ error: string }>().error).toBe('Invalid request body')
    })

    it('returns 400 for invalid communityName (whitespace only)', async () => {
      validateAccessTokenFn.mockResolvedValueOnce(makeMockSession())

      const response = await app.inject({
        method: 'POST',
        url: '/api/setup/initialize',
        headers: {
          authorization: `Bearer ${TEST_ACCESS_TOKEN}`,
          'content-type': 'application/json',
        },
        payload: { communityName: '   ' },
      })

      expect(response.statusCode).toBe(400)
      expect(response.json<{ error: string }>().error).toBe('Invalid request body')
    })

    it('passes handle and serviceEndpoint to service when provided', async () => {
      validateAccessTokenFn.mockResolvedValueOnce(makeMockSession())
      initializeFn.mockResolvedValueOnce({
        initialized: true,
        adminDid: TEST_DID,
        communityName: 'Barazo Community',
        communityDid: 'did:plc:generated123',
      })

      const response = await app.inject({
        method: 'POST',
        url: '/api/setup/initialize',
        headers: {
          authorization: `Bearer ${TEST_ACCESS_TOKEN}`,
          'content-type': 'application/json',
        },
        payload: {
          communityName: 'My Forum',
          handle: 'forum.example.com',
          serviceEndpoint: 'https://forum.example.com',
        },
      })

      expect(response.statusCode).toBe(200)
      expect(initializeFn).toHaveBeenCalledWith({
        communityDid: 'did:plc:test',
        did: TEST_DID,
        communityName: 'My Forum',
        handle: 'forum.example.com',
        serviceEndpoint: 'https://forum.example.com',
      })
    })

    it('returns 400 for invalid serviceEndpoint (not a URL)', async () => {
      validateAccessTokenFn.mockResolvedValueOnce(makeMockSession())

      const response = await app.inject({
        method: 'POST',
        url: '/api/setup/initialize',
        headers: {
          authorization: `Bearer ${TEST_ACCESS_TOKEN}`,
          'content-type': 'application/json',
        },
        payload: {
          serviceEndpoint: 'not-a-url',
        },
      })

      expect(response.statusCode).toBe(400)
      expect(response.json<{ error: string }>().error).toBe('Invalid request body')
    })

    it('returns 400 for empty handle', async () => {
      validateAccessTokenFn.mockResolvedValueOnce(makeMockSession())

      const response = await app.inject({
        method: 'POST',
        url: '/api/setup/initialize',
        headers: {
          authorization: `Bearer ${TEST_ACCESS_TOKEN}`,
          'content-type': 'application/json',
        },
        payload: {
          handle: '',
        },
      })

      expect(response.statusCode).toBe(400)
      expect(response.json<{ error: string }>().error).toBe('Invalid request body')
    })

    it('returns 500 when service throws', async () => {
      validateAccessTokenFn.mockResolvedValueOnce(makeMockSession())
      initializeFn.mockRejectedValueOnce(new Error('DB down'))

      const response = await app.inject({
        method: 'POST',
        url: '/api/setup/initialize',
        headers: {
          authorization: `Bearer ${TEST_ACCESS_TOKEN}`,
        },
        payload: {},
      })

      expect(response.statusCode).toBe(500)
      const body = response.json<{ error: string; message: string; statusCode: number }>()
      expect(body.error).toBe('Internal Server Error')
      expect(body.message).toBe('Service temporarily unavailable')
      expect(body.statusCode).toBe(500)
    })
  })
})
