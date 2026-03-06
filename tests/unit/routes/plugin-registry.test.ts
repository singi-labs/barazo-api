/**
 * Tests for the public plugin registry routes.
 * These routes do NOT require authentication.
 */

import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest'
import Fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import type { Env } from '../../../src/config/env.js'
import type { RequestUser } from '../../../src/auth/middleware.js'
import type { SessionService } from '../../../src/auth/session.js'
import type { SetupService } from '../../../src/setup/service.js'
import type { RegistryPlugin } from '../../../src/lib/plugins/registry.js'
import { createMockDb, createChainableProxy } from '../../helpers/mock-db.js'

// ---------------------------------------------------------------------------
// Mock the registry module so we control what getRegistryIndex returns
// ---------------------------------------------------------------------------

const { mockGetRegistryIndex } = vi.hoisted(() => ({
  mockGetRegistryIndex: vi.fn(),
}))

vi.mock('../../../src/lib/plugins/registry.js', () => ({
  getRegistryIndex: mockGetRegistryIndex,
  searchRegistryPlugins: vi.fn(
    (plugins: unknown[], params: { q?: string; category?: string; source?: string }) => {
      // Re-implement minimal search for tests
      let results = plugins as Array<{
        name: string
        displayName: string
        description: string
        category: string
        source: string
        featured: boolean
      }>
      if (params.q) {
        const q = params.q.toLowerCase()
        results = results.filter(
          (p) =>
            p.name.includes(q) ||
            p.displayName.toLowerCase().includes(q) ||
            p.description.toLowerCase().includes(q)
        )
      }
      if (params.category) results = results.filter((p) => p.category === params.category)
      if (params.source) results = results.filter((p) => p.source === params.source)
      return results
    }
  ),
  getFeaturedPlugins: vi.fn((plugins: Array<{ featured: boolean }>) =>
    plugins.filter((p) => p.featured)
  ),
}))

// Import routes after mocks
import { adminPluginRoutes } from '../../../src/routes/admin-plugins.js'

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function makeRegistryPlugin(overrides: Partial<RegistryPlugin> = {}): RegistryPlugin {
  return {
    name: '@barazo/plugin-test',
    displayName: 'Test Plugin',
    description: 'A test plugin',
    version: '1.0.0',
    source: 'official',
    category: 'moderation',
    barazoVersion: '^0.1.0',
    author: { name: 'Barazo Team' },
    license: 'MIT',
    npmUrl: 'https://www.npmjs.com/package/@barazo/plugin-test',
    approved: true,
    featured: false,
    downloads: 100,
    ...overrides,
  }
}

const registryPlugins: RegistryPlugin[] = [
  makeRegistryPlugin({
    name: '@barazo/plugin-polls',
    displayName: 'Polls',
    description: 'Add polls to forum topics',
    category: 'social',
    featured: true,
    downloads: 500,
  }),
  makeRegistryPlugin({
    name: '@barazo/plugin-spam',
    displayName: 'Spam Filter',
    description: 'AI-powered spam detection',
    category: 'moderation',
    featured: false,
    downloads: 1200,
  }),
  makeRegistryPlugin({
    name: 'community-badges',
    displayName: 'Community Badges',
    description: 'Custom badge system',
    category: 'social',
    source: 'community',
    featured: true,
    downloads: 80,
  }),
]

// ---------------------------------------------------------------------------
// Mock env + DB
// ---------------------------------------------------------------------------

const mockEnv = {
  COMMUNITY_DID: 'did:plc:community123',
  UPLOAD_MAX_SIZE_BYTES: 5_242_880,
  RATE_LIMIT_WRITE: 10,
  RATE_LIMIT_READ_ANON: 100,
  RATE_LIMIT_READ_AUTH: 300,
} as Env

const mockDb = createMockDb()

function resetAllDbMocks(): void {
  const selectChain = createChainableProxy([])
  mockDb.insert.mockReturnValue(createChainableProxy())
  mockDb.select.mockReturnValue(selectChain)
  mockDb.update.mockReturnValue(createChainableProxy([]))
  mockDb.delete.mockReturnValue(createChainableProxy())
}

// ---------------------------------------------------------------------------
// requireAdmin mock (for the admin routes we don't test here)
// ---------------------------------------------------------------------------

function createMockRequireAdmin() {
  return (
    _request: { user?: RequestUser },
    reply: { status: (code: number) => { send: (body: unknown) => void } },
    _done: () => void
  ) => {
    reply.status(401).send({ error: 'Authentication required' })
  }
}

// ---------------------------------------------------------------------------
// Build test app
// ---------------------------------------------------------------------------

async function buildTestApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })

  app.decorate('db', mockDb as never)
  app.decorate('env', mockEnv)
  app.decorate('authMiddleware', {} as never)
  app.decorate('requireAdmin', createMockRequireAdmin())
  app.decorate('storage', {} as never)
  app.decorate('firehose', {} as never)
  app.decorate('oauthClient', {} as never)
  app.decorate('sessionService', {} as SessionService)
  app.decorate('setupService', {} as SetupService)
  app.decorate('cache', {} as never)
  app.decorateRequest('user', undefined as RequestUser | undefined)
  app.decorateRequest('communityDid', undefined as string | undefined)
  app.addHook('onRequest', (request, _reply, done) => {
    request.communityDid = mockEnv.COMMUNITY_DID
    done()
  })

  await app.register(adminPluginRoutes())
  await app.ready()

  return app
}

// ===========================================================================
// Test suite
// ===========================================================================

describe('plugin registry routes', () => {
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
    mockGetRegistryIndex.mockResolvedValue(registryPlugins)
  })

  // =========================================================================
  // GET /api/plugins/registry/search
  // =========================================================================

  describe('GET /api/plugins/registry/search', () => {
    it('returns all plugins when no query params are provided', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/plugins/registry/search',
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{ plugins: RegistryPlugin[] }>()
      expect(body.plugins).toHaveLength(3)
    })

    it('does not require authentication', async () => {
      // No Authorization header -- should still succeed
      const response = await app.inject({
        method: 'GET',
        url: '/api/plugins/registry/search',
      })

      expect(response.statusCode).toBe(200)
    })

    it('filters by text query', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/plugins/registry/search?q=polls',
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{ plugins: RegistryPlugin[] }>()
      expect(body.plugins).toHaveLength(1)
      expect(body.plugins[0]?.name).toBe('@barazo/plugin-polls')
    })

    it('filters by category', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/plugins/registry/search?category=social',
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{ plugins: RegistryPlugin[] }>()
      expect(body.plugins).toHaveLength(2)
    })

    it('filters by source', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/plugins/registry/search?source=community',
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{ plugins: RegistryPlugin[] }>()
      expect(body.plugins).toHaveLength(1)
      expect(body.plugins[0]?.name).toBe('community-badges')
    })

    it('combines multiple filters', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/plugins/registry/search?q=badge&category=social&source=community',
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{ plugins: RegistryPlugin[] }>()
      expect(body.plugins).toHaveLength(1)
      expect(body.plugins[0]?.name).toBe('community-badges')
    })

    it('returns empty array when no matches', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/plugins/registry/search?q=nonexistent',
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{ plugins: RegistryPlugin[] }>()
      expect(body.plugins).toHaveLength(0)
    })

    it('returns empty array when registry fetch fails', async () => {
      mockGetRegistryIndex.mockResolvedValue([])

      const response = await app.inject({
        method: 'GET',
        url: '/api/plugins/registry/search',
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{ plugins: RegistryPlugin[] }>()
      expect(body.plugins).toHaveLength(0)
    })
  })

  // =========================================================================
  // GET /api/plugins/registry/featured
  // =========================================================================

  describe('GET /api/plugins/registry/featured', () => {
    it('returns only featured plugins', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/plugins/registry/featured',
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{ plugins: RegistryPlugin[] }>()
      expect(body.plugins).toHaveLength(2)
      expect(body.plugins.every((p) => p.featured)).toBe(true)
    })

    it('does not require authentication', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/plugins/registry/featured',
      })

      expect(response.statusCode).toBe(200)
    })

    it('returns empty array when no featured plugins exist', async () => {
      mockGetRegistryIndex.mockResolvedValue(
        registryPlugins.map((p) => ({ ...p, featured: false }))
      )

      const response = await app.inject({
        method: 'GET',
        url: '/api/plugins/registry/featured',
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{ plugins: RegistryPlugin[] }>()
      expect(body.plugins).toHaveLength(0)
    })

    it('returns empty array when registry fetch fails', async () => {
      mockGetRegistryIndex.mockResolvedValue([])

      const response = await app.inject({
        method: 'GET',
        url: '/api/plugins/registry/featured',
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{ plugins: RegistryPlugin[] }>()
      expect(body.plugins).toHaveLength(0)
    })
  })
})
