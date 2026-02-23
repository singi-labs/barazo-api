import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { buildApp } from '../../../src/app.js'
import type { FastifyInstance } from 'fastify'

// Mock database to avoid real PostgreSQL connection
const mockExecute = vi.fn().mockResolvedValue([{ '?column?': 1 }])
const mockDb = {
  execute: mockExecute,
  select: vi.fn().mockReturnValue({ from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }) }),
  insert: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
  transaction: vi.fn(),
  query: {},
}
const mockClient = {
  end: vi.fn().mockResolvedValue(undefined),
}
vi.mock('../../../src/db/index.js', () => ({
  createDb: () => ({ db: mockDb, client: mockClient }),
}))

// Mock cache to avoid real Valkey connection
const mockCache = {
  get: vi.fn().mockResolvedValue(null),
  set: vi.fn().mockResolvedValue(undefined),
  del: vi.fn().mockResolvedValue(undefined),
  ping: vi.fn().mockResolvedValue('PONG'),
  quit: vi.fn().mockResolvedValue(undefined),
}
vi.mock('../../../src/cache/index.js', () => ({
  createCache: () => mockCache,
}))

// Mock @atproto/oauth-client-node to avoid crypto operations
vi.mock('@atproto/oauth-client-node', () => {
  return {
    NodeOAuthClient: class MockNodeOAuthClient {
      clientMetadata = {}
      jwks = { keys: [] }
      addEventListener = vi.fn()
    },
  }
})

// Mock @atproto/tap to avoid real network connections
vi.mock('@atproto/tap', () => {
  const mockChannel = {
    start: vi.fn().mockResolvedValue(undefined),
    destroy: vi.fn().mockResolvedValue(undefined),
  }

  class MockTap {
    addRepos = vi.fn().mockResolvedValue(undefined)
    removeRepos = vi.fn().mockResolvedValue(undefined)
    channel = vi.fn().mockReturnValue(mockChannel)
  }

  class MockSimpleIndexer {
    identity = vi.fn().mockReturnThis()
    record = vi.fn().mockReturnThis()
    error = vi.fn().mockReturnThis()
  }

  return {
    Tap: MockTap,
    SimpleIndexer: MockSimpleIndexer,
  }
})

interface HealthResponse {
  status: string
  version: string
  uptime: number
}

interface ReadyResponse {
  status: string
  checks: Record<string, { status: string; latency?: number }>
}

describe('health routes', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    app = await buildApp({
      DATABASE_URL: 'postgresql://barazo:barazo_dev@localhost:5432/barazo',
      VALKEY_URL: 'redis://localhost:6379',
      TAP_URL: 'http://localhost:2480',
      TAP_ADMIN_PASSWORD: 'tap_dev_secret',
      HOST: '0.0.0.0',
      PORT: 0,
      LOG_LEVEL: 'silent',
      CORS_ORIGINS: 'http://localhost:3001',
      COMMUNITY_MODE: 'single' as const,
      COMMUNITY_DID: 'did:plc:testcommunity',
      COMMUNITY_NAME: 'Test Community',
      RATE_LIMIT_AUTH: 10,
      RATE_LIMIT_WRITE: 10,
      RATE_LIMIT_READ_ANON: 100,
      RATE_LIMIT_READ_AUTH: 300,
      OAUTH_CLIENT_ID: 'http://localhost',
      OAUTH_REDIRECT_URI: 'http://127.0.0.1:3000/api/auth/callback',
      SESSION_SECRET: 'a'.repeat(32),
      OAUTH_SESSION_TTL: 604800,
      OAUTH_ACCESS_TOKEN_TTL: 900,
    })
    await app.ready()
  })

  afterAll(async () => {
    await app.close()
  })

  describe('GET /api/health', () => {
    it('returns 200 with status healthy', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/health',
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<HealthResponse>()
      expect(body.status).toBe('healthy')
      expect(body.version).toBe('0.1.0')
      expect(typeof body.uptime).toBe('number')
    })
  })

  describe('GET /api/health/ready', () => {
    it('returns dependency check results including firehose', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/health/ready',
      })

      const body = response.json<ReadyResponse>()
      expect(body).toHaveProperty('status')
      expect(body).toHaveProperty('checks')
      expect(body.checks).toHaveProperty('database')
      expect(body.checks).toHaveProperty('cache')
      expect(body.checks).toHaveProperty('firehose')
    })
  })
})
