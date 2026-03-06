import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest'
import Fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import type { Env } from '../../../src/config/env.js'
import type { RequestUser } from '../../../src/auth/middleware.js'
import { type DbChain, createChainableProxy, createMockDb } from '../../helpers/mock-db.js'

import { adminPluginRoutes } from '../../../src/routes/admin-plugins.js'

// ---------------------------------------------------------------------------
// Mock env
// ---------------------------------------------------------------------------

const mockEnv = {
  HOSTING_MODE: 'selfhosted',
} as Env

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const ADMIN_DID = 'did:plc:admin999'

const ADMIN_USER: RequestUser = {
  did: ADMIN_DID,
  handle: 'admin.bsky.social',
  sid: 'a'.repeat(64),
}

// ---------------------------------------------------------------------------
// Mock plugin fixture
// ---------------------------------------------------------------------------

const MOCK_PLUGIN_ROW = {
  id: '550e8400-e29b-41d4-a716-446655440000',
  name: '@barazo/plugin-test',
  displayName: 'Test Plugin',
  version: '1.0.0',
  description: 'A test plugin',
  source: 'core' as const,
  category: 'social',
  enabled: false,
  manifestJson: { name: '@barazo/plugin-test', settings: {}, dependencies: [] },
  installedAt: new Date('2026-01-01'),
  updatedAt: new Date('2026-01-01'),
}

// ---------------------------------------------------------------------------
// Mock DB
// ---------------------------------------------------------------------------

const mockDb = createMockDb()

let selectChain: DbChain
let updateChain: DbChain
let deleteChain: DbChain
let insertChain: DbChain

function resetAllDbMocks(): void {
  selectChain = createChainableProxy([])
  updateChain = createChainableProxy([])
  deleteChain = createChainableProxy()
  insertChain = createChainableProxy()
  mockDb.select.mockReturnValue(selectChain)
  mockDb.update.mockReturnValue(updateChain)
  mockDb.delete.mockReturnValue(deleteChain)
  mockDb.insert.mockReturnValue(insertChain)
  mockDb.execute.mockReset()
  // eslint-disable-next-line @typescript-eslint/no-misused-promises -- Intentionally async mock for Drizzle transaction
  mockDb.transaction.mockImplementation(async (fn: (tx: typeof mockDb) => Promise<void>) => {
    await fn(mockDb)
  })
}

// ---------------------------------------------------------------------------
// Mock requireAdmin
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
  }
}

// ---------------------------------------------------------------------------
// Build test app
// ---------------------------------------------------------------------------

async function buildTestApp(user?: RequestUser): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })

  const requireAdmin = createMockRequireAdmin(user)

  app.decorate('db', mockDb as never)
  app.decorate('env', mockEnv)
  app.decorate('requireAdmin', requireAdmin as never)
  app.decorate('cache', {} as never)
  app.decorateRequest('user', undefined as RequestUser | undefined)

  await app.register(adminPluginRoutes())
  await app.ready()

  return app
}

// ===========================================================================
// Test suite
// ===========================================================================

describe('admin plugin routes', () => {
  // =========================================================================
  // GET /api/plugins
  // =========================================================================

  describe('GET /api/plugins', () => {
    let app: FastifyInstance

    beforeAll(async () => {
      app = await buildTestApp(ADMIN_USER)
    })

    afterAll(async () => {
      await app.close()
    })

    beforeEach(() => {
      vi.clearAllMocks()
      resetAllDbMocks()
    })

    it('returns list of plugins (200)', async () => {
      // Routes call `await db.select().from(plugins)` (no .where()),
      // so from() must return a thenable that resolves to the mock data.
      const pluginSelectChain = createChainableProxy([MOCK_PLUGIN_ROW])
      // eslint-disable-next-line @typescript-eslint/no-misused-promises -- Intentionally thenable mock for Drizzle chain
      pluginSelectChain.from.mockImplementation(() => ({
        ...pluginSelectChain,
        then: (resolve: (v: unknown) => void, reject?: (e: unknown) => void) =>
          Promise.resolve([MOCK_PLUGIN_ROW]).then(resolve, reject),
      }))

      const settingsSelectChain = createChainableProxy([])
      // eslint-disable-next-line @typescript-eslint/no-misused-promises -- Intentionally thenable mock for Drizzle chain
      settingsSelectChain.from.mockImplementation(() => ({
        ...settingsSelectChain,
        then: (resolve: (v: unknown) => void, reject?: (e: unknown) => void) =>
          Promise.resolve([]).then(resolve, reject),
      }))

      mockDb.select.mockReturnValueOnce(pluginSelectChain).mockReturnValueOnce(settingsSelectChain)

      const response = await app.inject({
        method: 'GET',
        url: '/api/plugins',
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{ plugins: unknown[] }>()
      expect(body.plugins).toHaveLength(1)
      expect(body.plugins[0]).toMatchObject({
        id: MOCK_PLUGIN_ROW.id,
        name: MOCK_PLUGIN_ROW.name,
        displayName: MOCK_PLUGIN_ROW.displayName,
      })
    })
  })

  // =========================================================================
  // GET /api/plugins/:id
  // =========================================================================

  describe('GET /api/plugins/:id', () => {
    let app: FastifyInstance

    beforeAll(async () => {
      app = await buildTestApp(ADMIN_USER)
    })

    afterAll(async () => {
      await app.close()
    })

    beforeEach(() => {
      vi.clearAllMocks()
      resetAllDbMocks()
    })

    it('returns 404 when plugin not found', async () => {
      const pluginSelectChain = createChainableProxy([])
      mockDb.select.mockReturnValueOnce(pluginSelectChain)

      const response = await app.inject({
        method: 'GET',
        url: '/api/plugins/nonexistent-id',
      })

      expect(response.statusCode).toBe(404)
    })

    it('returns plugin details when found (200)', async () => {
      const pluginSelectChain = createChainableProxy([MOCK_PLUGIN_ROW])
      const settingsSelectChain = createChainableProxy([])

      mockDb.select.mockReturnValueOnce(pluginSelectChain).mockReturnValueOnce(settingsSelectChain)

      const response = await app.inject({
        method: 'GET',
        url: `/api/plugins/${MOCK_PLUGIN_ROW.id}`,
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{ id: string; name: string }>()
      expect(body.id).toBe(MOCK_PLUGIN_ROW.id)
      expect(body.name).toBe(MOCK_PLUGIN_ROW.name)
    })
  })

  // =========================================================================
  // PATCH /api/plugins/:id/enable
  // =========================================================================

  describe('PATCH /api/plugins/:id/enable', () => {
    let app: FastifyInstance

    beforeAll(async () => {
      app = await buildTestApp(ADMIN_USER)
    })

    afterAll(async () => {
      await app.close()
    })

    beforeEach(() => {
      vi.clearAllMocks()
      resetAllDbMocks()
    })

    it('enables a disabled plugin (200)', async () => {
      const pluginSelectChain = createChainableProxy([MOCK_PLUGIN_ROW])
      mockDb.select.mockReturnValueOnce(pluginSelectChain)

      const updatedRow = { ...MOCK_PLUGIN_ROW, enabled: true, updatedAt: new Date() }
      // eslint-disable-next-line @typescript-eslint/no-misused-promises -- Intentionally thenable mock for Drizzle chain
      updateChain.returning.mockImplementation(() => ({
        ...updateChain,
        then: (resolve: (val: unknown) => void, reject?: (err: unknown) => void) =>
          Promise.resolve([updatedRow]).then(resolve, reject),
      }))

      const response = await app.inject({
        method: 'PATCH',
        url: `/api/plugins/${MOCK_PLUGIN_ROW.id}/enable`,
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{ enabled: boolean }>()
      expect(body.enabled).toBe(true)
    })
  })

  // =========================================================================
  // PATCH /api/plugins/:id/disable
  // =========================================================================

  describe('PATCH /api/plugins/:id/disable', () => {
    let app: FastifyInstance

    beforeAll(async () => {
      app = await buildTestApp(ADMIN_USER)
    })

    afterAll(async () => {
      await app.close()
    })

    beforeEach(() => {
      vi.clearAllMocks()
      resetAllDbMocks()
    })

    it('disables an enabled plugin (200)', async () => {
      const enabledPlugin = { ...MOCK_PLUGIN_ROW, enabled: true }
      // First select: db.select().from(plugins).where(...) -- has .where(), default chain works
      const pluginSelectChain = createChainableProxy([enabledPlugin])
      // Second select: db.select().from(plugins) -- no .where(), from() must be thenable
      const allPluginsChain = createChainableProxy([enabledPlugin])
      // eslint-disable-next-line @typescript-eslint/no-misused-promises -- Intentionally thenable mock for Drizzle chain
      allPluginsChain.from.mockImplementation(() => ({
        ...allPluginsChain,
        then: (resolve: (v: unknown) => void, reject?: (e: unknown) => void) =>
          Promise.resolve([enabledPlugin]).then(resolve, reject),
      }))

      mockDb.select.mockReturnValueOnce(pluginSelectChain).mockReturnValueOnce(allPluginsChain)

      const updatedRow = { ...MOCK_PLUGIN_ROW, enabled: false, updatedAt: new Date() }
      // eslint-disable-next-line @typescript-eslint/no-misused-promises -- Intentionally thenable mock for Drizzle chain
      updateChain.returning.mockImplementation(() => ({
        ...updateChain,
        then: (resolve: (val: unknown) => void, reject?: (err: unknown) => void) =>
          Promise.resolve([updatedRow]).then(resolve, reject),
      }))

      const response = await app.inject({
        method: 'PATCH',
        url: `/api/plugins/${MOCK_PLUGIN_ROW.id}/disable`,
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{ enabled: boolean }>()
      expect(body.enabled).toBe(false)
    })
  })

  // =========================================================================
  // PATCH /api/plugins/:id/settings
  // =========================================================================

  describe('PATCH /api/plugins/:id/settings', () => {
    let app: FastifyInstance

    beforeAll(async () => {
      app = await buildTestApp(ADMIN_USER)
    })

    afterAll(async () => {
      await app.close()
    })

    beforeEach(() => {
      vi.clearAllMocks()
      resetAllDbMocks()
    })

    it('updates settings (200)', async () => {
      const pluginSelectChain = createChainableProxy([MOCK_PLUGIN_ROW])
      mockDb.select.mockReturnValueOnce(pluginSelectChain)

      const response = await app.inject({
        method: 'PATCH',
        url: `/api/plugins/${MOCK_PLUGIN_ROW.id}/settings`,
        payload: { enabled: true, threshold: 5 },
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{ success: boolean }>()
      expect(body.success).toBe(true)
    })
  })

  // =========================================================================
  // DELETE /api/plugins/:id
  // =========================================================================

  describe('DELETE /api/plugins/:id', () => {
    let app: FastifyInstance

    beforeAll(async () => {
      app = await buildTestApp(ADMIN_USER)
    })

    afterAll(async () => {
      await app.close()
    })

    beforeEach(() => {
      vi.clearAllMocks()
      resetAllDbMocks()
    })

    it('returns 404 when plugin not found', async () => {
      const pluginSelectChain = createChainableProxy([])
      mockDb.select.mockReturnValueOnce(pluginSelectChain)

      const response = await app.inject({
        method: 'DELETE',
        url: '/api/plugins/nonexistent-id',
      })

      expect(response.statusCode).toBe(404)
    })
  })
})
