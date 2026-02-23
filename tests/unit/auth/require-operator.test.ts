import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import Fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import { createRequireOperator } from '../../../src/auth/require-operator.js'
import type { AuthMiddleware, RequestUser } from '../../../src/auth/middleware.js'
import type { Env } from '../../../src/config/env.js'
import type { Logger } from '../../../src/lib/logger.js'

// ---------------------------------------------------------------------------
// Mock auth middleware
// ---------------------------------------------------------------------------

function createMockAuthMiddleware(): AuthMiddleware {
  return {
    requireAuth: vi.fn(async (_request, _reply) => {
      // Simulate setting user - tests will set request.user before calling
    }),
    optionalAuth: vi.fn(),
  }
}

// ---------------------------------------------------------------------------
// Mock logger
// ---------------------------------------------------------------------------

const logInfoFn = vi.fn()
const logWarnFn = vi.fn()

function createMockLogger(): Logger {
  return {
    info: logInfoFn,
    error: vi.fn(),
    warn: logWarnFn,
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn(),
    silent: vi.fn(),
    level: 'silent',
  } as unknown as Logger
}

// ---------------------------------------------------------------------------
// Mock env
// ---------------------------------------------------------------------------

function createMockEnv(
  overrides: Partial<Pick<Env, 'COMMUNITY_MODE' | 'OPERATOR_DIDS'>> = {}
): Pick<Env, 'COMMUNITY_MODE' | 'OPERATOR_DIDS'> {
  return {
    COMMUNITY_MODE: overrides.COMMUNITY_MODE ?? 'multi',
    OPERATOR_DIDS: overrides.OPERATOR_DIDS ?? ['did:plc:operator123'],
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const OPERATOR_USER: RequestUser = {
  did: 'did:plc:operator123',
  handle: 'operator.bsky.social',
  sid: 's'.repeat(64),
}

const NON_OPERATOR_USER: RequestUser = {
  did: 'did:plc:user456',
  handle: 'user.bsky.social',
  sid: 's'.repeat(64),
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('requireOperator middleware', () => {
  let app: FastifyInstance
  let mockAuthMiddleware: AuthMiddleware

  afterEach(async () => {
    await app.close()
  })

  beforeEach(() => {
    vi.clearAllMocks()
  })

  // Helper to build a Fastify app with the operator middleware
  async function buildApp(
    envOverrides: Partial<Pick<Env, 'COMMUNITY_MODE' | 'OPERATOR_DIDS'>> = {},
    withLogger = true
  ): Promise<FastifyInstance> {
    mockAuthMiddleware = createMockAuthMiddleware()
    const mockEnv = createMockEnv(envOverrides)
    const mockLogger = withLogger ? createMockLogger() : undefined

    const requireOperator = createRequireOperator(mockEnv as Env, mockAuthMiddleware, mockLogger)

    app = Fastify({ logger: false })
    app.decorateRequest('user', undefined as RequestUser | undefined)

    app.get('/operator-test', { preHandler: [requireOperator] }, (request) => {
      return { user: request.user }
    })

    await app.ready()
    return app
  }

  // -------------------------------------------------------------------------
  // Community mode check
  // -------------------------------------------------------------------------

  it("returns 404 if COMMUNITY_MODE is 'single'", async () => {
    await buildApp({ COMMUNITY_MODE: 'single' })

    const response = await app.inject({
      method: 'GET',
      url: '/operator-test',
    })

    expect(response.statusCode).toBe(404)
    expect(response.json<{ error: string }>()).toStrictEqual({
      error: 'Not found',
    })
    // requireAuth should NOT have been called
    expect(mockAuthMiddleware.requireAuth).not.toHaveBeenCalled()
  })

  // -------------------------------------------------------------------------
  // Authentication check (delegated to requireAuth)
  // -------------------------------------------------------------------------

  it('returns 401 when requireAuth rejects (no token)', async () => {
    await buildApp({ COMMUNITY_MODE: 'multi' })

    vi.mocked(mockAuthMiddleware.requireAuth).mockImplementation(async (_request, reply) => {
      await reply.status(401).send({ error: 'Authentication required' })
    })

    const response = await app.inject({
      method: 'GET',
      url: '/operator-test',
    })

    expect(response.statusCode).toBe(401)
    expect(response.json<{ error: string }>()).toStrictEqual({
      error: 'Authentication required',
    })
  })

  // -------------------------------------------------------------------------
  // Operator DID check
  // -------------------------------------------------------------------------

  it('returns 403 if user DID is not in OPERATOR_DIDS', async () => {
    await buildApp({
      COMMUNITY_MODE: 'multi',
      OPERATOR_DIDS: ['did:plc:operator123'],
    })

    vi.mocked(mockAuthMiddleware.requireAuth).mockImplementation(async (request, _reply) => {
      request.user = NON_OPERATOR_USER
    })

    const response = await app.inject({
      method: 'GET',
      url: '/operator-test',
    })

    expect(response.statusCode).toBe(403)
    expect(response.json<{ error: string }>()).toStrictEqual({
      error: 'Operator access required',
    })
  })

  it('returns 403 when requireAuth passes but request.user is not set', async () => {
    await buildApp({ COMMUNITY_MODE: 'multi' })

    // requireAuth passes without setting request.user
    vi.mocked(mockAuthMiddleware.requireAuth).mockImplementation(async (_request, _reply) => {
      // intentionally do not set request.user
    })

    const response = await app.inject({
      method: 'GET',
      url: '/operator-test',
    })

    expect(response.statusCode).toBe(403)
    expect(response.json<{ error: string }>()).toStrictEqual({
      error: 'Operator access required',
    })
  })

  // -------------------------------------------------------------------------
  // Success path
  // -------------------------------------------------------------------------

  it("grants access if user DID is in OPERATOR_DIDS and mode is 'multi'", async () => {
    await buildApp({
      COMMUNITY_MODE: 'multi',
      OPERATOR_DIDS: ['did:plc:operator123'],
    })

    vi.mocked(mockAuthMiddleware.requireAuth).mockImplementation(async (request, _reply) => {
      request.user = OPERATOR_USER
    })

    const response = await app.inject({
      method: 'GET',
      url: '/operator-test',
    })

    expect(response.statusCode).toBe(200)
    const body = response.json<{ user: RequestUser }>()
    expect(body.user).toStrictEqual(OPERATOR_USER)
  })

  it('grants access when OPERATOR_DIDS contains multiple DIDs', async () => {
    await buildApp({
      COMMUNITY_MODE: 'multi',
      OPERATOR_DIDS: ['did:plc:other999', 'did:plc:operator123', 'did:plc:another888'],
    })

    vi.mocked(mockAuthMiddleware.requireAuth).mockImplementation(async (request, _reply) => {
      request.user = OPERATOR_USER
    })

    const response = await app.inject({
      method: 'GET',
      url: '/operator-test',
    })

    expect(response.statusCode).toBe(200)
    const body = response.json<{ user: RequestUser }>()
    expect(body.user).toStrictEqual(OPERATOR_USER)
  })

  // -------------------------------------------------------------------------
  // Audit logging
  // -------------------------------------------------------------------------

  it('logs audit trail when operator access is denied (DID not in list)', async () => {
    await buildApp({
      COMMUNITY_MODE: 'multi',
      OPERATOR_DIDS: ['did:plc:operator123'],
    })

    vi.mocked(mockAuthMiddleware.requireAuth).mockImplementation(async (request, _reply) => {
      request.user = NON_OPERATOR_USER
    })

    await app.inject({
      method: 'GET',
      url: '/operator-test',
    })

    expect(logWarnFn).toHaveBeenCalledWith(
      { did: NON_OPERATOR_USER.did, url: '/operator-test', method: 'GET' },
      'Operator access denied: DID not in OPERATOR_DIDS'
    )
  })

  it('logs audit trail when operator access is denied (no user after auth)', async () => {
    await buildApp({ COMMUNITY_MODE: 'multi' })

    vi.mocked(mockAuthMiddleware.requireAuth).mockImplementation(async (_request, _reply) => {
      // intentionally do not set request.user
    })

    await app.inject({
      method: 'GET',
      url: '/operator-test',
    })

    expect(logWarnFn).toHaveBeenCalledWith(
      { url: '/operator-test', method: 'GET' },
      'Operator access denied: no user after auth'
    )
  })

  it('logs audit trail when operator access is granted', async () => {
    await buildApp({
      COMMUNITY_MODE: 'multi',
      OPERATOR_DIDS: ['did:plc:operator123'],
    })

    vi.mocked(mockAuthMiddleware.requireAuth).mockImplementation(async (request, _reply) => {
      request.user = OPERATOR_USER
    })

    await app.inject({
      method: 'GET',
      url: '/operator-test',
    })

    expect(logInfoFn).toHaveBeenCalledWith(
      { did: OPERATOR_USER.did, url: '/operator-test', method: 'GET' },
      'Operator access granted'
    )
  })
})
