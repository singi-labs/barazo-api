/**
 * Tests for admin design upload routes (logo + favicon).
 * TDD: these tests are written before the implementation.
 */

import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest'
import Fastify from 'fastify'
import multipart from '@fastify/multipart'
import type { FastifyInstance } from 'fastify'
import type { Env } from '../../../src/config/env.js'
import type { RequestUser } from '../../../src/auth/middleware.js'
import type { SessionService } from '../../../src/auth/session.js'
import type { SetupService } from '../../../src/setup/service.js'
import type { StorageService } from '../../../src/lib/storage.js'
import { type DbChain, createChainableProxy, createMockDb } from '../../helpers/mock-db.js'

// ---------------------------------------------------------------------------
// Mock sharp -- must be hoisted before route import
// ---------------------------------------------------------------------------

vi.mock('sharp', () => {
  const mockSharpInstance = {
    resize: vi.fn().mockReturnThis(),
    webp: vi.fn().mockReturnThis(),
    toBuffer: vi.fn().mockResolvedValue(Buffer.from('processed-image')),
  }
  return {
    default: vi.fn(() => mockSharpInstance),
    __mockInstance: mockSharpInstance,
  }
})

// Import routes after mocks
import { adminDesignRoutes } from '../../../src/routes/admin-design.js'

// Retrieve the mock instance exported from the vi.mock factory
const { __mockInstance: mockSharpInstance } = await vi.importMock<{ __mockInstance: { resize: ReturnType<typeof vi.fn>; webp: ReturnType<typeof vi.fn>; toBuffer: ReturnType<typeof vi.fn> } }>('sharp')

// ---------------------------------------------------------------------------
// Mock env
// ---------------------------------------------------------------------------

const mockEnv = {
  COMMUNITY_DID: 'did:plc:community123',
  UPLOAD_MAX_SIZE_BYTES: 5_242_880,
  RATE_LIMIT_WRITE: 10,
  RATE_LIMIT_READ_ANON: 100,
  RATE_LIMIT_READ_AUTH: 300,
} as Env

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const TEST_DID = 'did:plc:testadmin123'
const TEST_HANDLE = 'admin.bsky.team'
const TEST_SID = 'a'.repeat(64)

// ---------------------------------------------------------------------------
// Mock user builder
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
// Mock DB
// ---------------------------------------------------------------------------

const mockDb = createMockDb()

let updateChain: DbChain

function resetAllDbMocks(): void {
  const selectChain = createChainableProxy([])
  updateChain = createChainableProxy([])
  mockDb.insert.mockReturnValue(createChainableProxy())
  mockDb.select.mockReturnValue(selectChain)
  mockDb.update.mockReturnValue(updateChain)
  mockDb.delete.mockReturnValue(createChainableProxy())
}

// ---------------------------------------------------------------------------
// Mock storage
// ---------------------------------------------------------------------------

function createMockStorage(): StorageService {
  return {
    store: vi.fn().mockResolvedValue('http://localhost:3000/uploads/logos/test.webp'),
    delete: vi.fn().mockResolvedValue(undefined),
  }
}

// ---------------------------------------------------------------------------
// requireAdmin mock (simulates admin middleware)
// ---------------------------------------------------------------------------

function createMockRequireAdmin(user?: RequestUser) {
  return (request: { user?: RequestUser }, reply: { status: (code: number) => { send: (body: unknown) => void } }, done: () => void) => {
    if (!user) {
      reply.status(401).send({ error: 'Authentication required' })
      return
    }
    request.user = user
    done()
  }
}

// ---------------------------------------------------------------------------
// Helper: build app with mocked deps
// ---------------------------------------------------------------------------

async function buildTestApp(
  user?: RequestUser,
  storageOverride?: StorageService
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })

  // Register multipart before routes (required for request.file())
  await app.register(multipart, {
    limits: { fileSize: mockEnv.UPLOAD_MAX_SIZE_BYTES },
  })

  const storage = storageOverride ?? createMockStorage()

  app.decorate('db', mockDb as never)
  app.decorate('env', mockEnv)
  app.decorate('authMiddleware', {} as never)
  app.decorate('requireAdmin', createMockRequireAdmin(user))
  app.decorate('storage', storage)
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

  await app.register(adminDesignRoutes())
  await app.ready()

  return app
}

// ---------------------------------------------------------------------------
// Helper: create multipart form body for Fastify inject
// ---------------------------------------------------------------------------

function createMultipartPayload(
  filename: string,
  mimetype: string,
  data: Buffer
): { body: string; contentType: string } {
  const boundary = `----TestBoundary${String(Date.now())}`
  const body = [
    `--${boundary}`,
    `Content-Disposition: form-data; name="file"; filename="${filename}"`,
    `Content-Type: ${mimetype}`,
    '',
    data.toString('binary'),
    `--${boundary}--`,
  ].join('\r\n')

  return {
    body,
    contentType: `multipart/form-data; boundary=${boundary}`,
  }
}

// ===========================================================================
// Test suite
// ===========================================================================

describe('admin design routes', () => {
  // =========================================================================
  // POST /api/admin/design/logo
  // =========================================================================

  describe('POST /api/admin/design/logo', () => {
    let app: FastifyInstance
    let mockStorage: StorageService

    beforeAll(async () => {
      mockStorage = createMockStorage()
      app = await buildTestApp(testUser(), mockStorage)
    })

    afterAll(async () => {
      await app.close()
    })

    beforeEach(() => {
      vi.clearAllMocks()
      resetAllDbMocks()
      ;(mockStorage.store as ReturnType<typeof vi.fn>).mockResolvedValue(
        'http://localhost:3000/uploads/logos/test.webp'
      )
    })

    it('uploads logo and returns URL', async () => {
      const imageData = Buffer.from('fake-png-data')
      const { body, contentType } = createMultipartPayload('logo.png', 'image/png', imageData)

      const response = await app.inject({
        method: 'POST',
        url: '/api/admin/design/logo',
        headers: {
          authorization: 'Bearer test-token',
          'content-type': contentType,
        },
        body,
      })

      expect(response.statusCode).toBe(200)
      const result = response.json<{ url: string }>()
      expect(result.url).toBe('http://localhost:3000/uploads/logos/test.webp')
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(mockStorage.store).toHaveBeenCalledOnce()
      expect(mockDb.update).toHaveBeenCalledOnce()
    })

    it('resizes logo to 512x512', async () => {
      const imageData = Buffer.from('fake-png-data')
      const { body, contentType } = createMultipartPayload('logo.png', 'image/png', imageData)

      await app.inject({
        method: 'POST',
        url: '/api/admin/design/logo',
        headers: {
          authorization: 'Bearer test-token',
          'content-type': contentType,
        },
        body,
      })

      expect(mockSharpInstance.resize).toHaveBeenCalledWith(512, 512, { fit: 'cover' })
      expect(mockSharpInstance.webp).toHaveBeenCalledWith({ quality: 85 })
    })

    it('stores with logos prefix', async () => {
      const imageData = Buffer.from('fake-png-data')
      const { body, contentType } = createMultipartPayload('logo.png', 'image/png', imageData)

      await app.inject({
        method: 'POST',
        url: '/api/admin/design/logo',
        headers: {
          authorization: 'Bearer test-token',
          'content-type': contentType,
        },
        body,
      })

      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(mockStorage.store).toHaveBeenCalledWith(
        expect.any(Buffer),
        'image/webp',
        'logos'
      )
    })

    it('returns 401 when not authenticated', async () => {
      const noAuthApp = await buildTestApp(undefined)
      const imageData = Buffer.from('fake-png-data')
      const { body, contentType } = createMultipartPayload('logo.png', 'image/png', imageData)

      const response = await noAuthApp.inject({
        method: 'POST',
        url: '/api/admin/design/logo',
        headers: { 'content-type': contentType },
        body,
      })

      expect(response.statusCode).toBe(401)
      await noAuthApp.close()
    })

    it('returns 400 when no file is uploaded', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/admin/design/logo',
        headers: {
          authorization: 'Bearer test-token',
          'content-type': 'multipart/form-data; boundary=----EmptyBoundary',
        },
        body: '------EmptyBoundary--\r\n',
      })

      expect(response.statusCode).toBe(400)
    })

    it('returns 400 for invalid MIME type', async () => {
      const { body, contentType } = createMultipartPayload(
        'doc.pdf',
        'application/pdf',
        Buffer.from('not-an-image')
      )

      const response = await app.inject({
        method: 'POST',
        url: '/api/admin/design/logo',
        headers: {
          authorization: 'Bearer test-token',
          'content-type': contentType,
        },
        body,
      })

      expect(response.statusCode).toBe(400)
    })

    it('accepts JPEG files', async () => {
      const { body, contentType } = createMultipartPayload(
        'logo.jpg',
        'image/jpeg',
        Buffer.from('jpeg-data')
      )

      const response = await app.inject({
        method: 'POST',
        url: '/api/admin/design/logo',
        headers: {
          authorization: 'Bearer test-token',
          'content-type': contentType,
        },
        body,
      })

      expect(response.statusCode).toBe(200)
    })
  })

  // =========================================================================
  // POST /api/admin/design/favicon
  // =========================================================================

  describe('POST /api/admin/design/favicon', () => {
    let app: FastifyInstance
    let mockStorage: StorageService

    beforeAll(async () => {
      mockStorage = createMockStorage()
      ;(mockStorage.store as ReturnType<typeof vi.fn>).mockResolvedValue(
        'http://localhost:3000/uploads/favicons/test.webp'
      )
      app = await buildTestApp(testUser(), mockStorage)
    })

    afterAll(async () => {
      await app.close()
    })

    beforeEach(() => {
      vi.clearAllMocks()
      resetAllDbMocks()
      ;(mockStorage.store as ReturnType<typeof vi.fn>).mockResolvedValue(
        'http://localhost:3000/uploads/favicons/test.webp'
      )
    })

    it('uploads favicon and returns URL', async () => {
      const imageData = Buffer.from('fake-png-data')
      const { body, contentType } = createMultipartPayload('favicon.png', 'image/png', imageData)

      const response = await app.inject({
        method: 'POST',
        url: '/api/admin/design/favicon',
        headers: {
          authorization: 'Bearer test-token',
          'content-type': contentType,
        },
        body,
      })

      expect(response.statusCode).toBe(200)
      const result = response.json<{ url: string }>()
      expect(result.url).toBe('http://localhost:3000/uploads/favicons/test.webp')
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(mockStorage.store).toHaveBeenCalledOnce()
      expect(mockDb.update).toHaveBeenCalledOnce()
    })

    it('resizes favicon to 256x256', async () => {
      const imageData = Buffer.from('fake-png-data')
      const { body, contentType } = createMultipartPayload('favicon.png', 'image/png', imageData)

      await app.inject({
        method: 'POST',
        url: '/api/admin/design/favicon',
        headers: {
          authorization: 'Bearer test-token',
          'content-type': contentType,
        },
        body,
      })

      expect(mockSharpInstance.resize).toHaveBeenCalledWith(256, 256, { fit: 'cover' })
      expect(mockSharpInstance.webp).toHaveBeenCalledWith({ quality: 90 })
    })

    it('stores with favicons prefix', async () => {
      const imageData = Buffer.from('fake-png-data')
      const { body, contentType } = createMultipartPayload('favicon.png', 'image/png', imageData)

      await app.inject({
        method: 'POST',
        url: '/api/admin/design/favicon',
        headers: {
          authorization: 'Bearer test-token',
          'content-type': contentType,
        },
        body,
      })

      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(mockStorage.store).toHaveBeenCalledWith(
        expect.any(Buffer),
        'image/webp',
        'favicons'
      )
    })

    it('returns 401 when not authenticated', async () => {
      const noAuthApp = await buildTestApp(undefined)
      const imageData = Buffer.from('fake-png-data')
      const { body, contentType } = createMultipartPayload('favicon.png', 'image/png', imageData)

      const response = await noAuthApp.inject({
        method: 'POST',
        url: '/api/admin/design/favicon',
        headers: { 'content-type': contentType },
        body,
      })

      expect(response.statusCode).toBe(401)
      await noAuthApp.close()
    })

    it('returns 400 for invalid MIME type', async () => {
      const { body, contentType } = createMultipartPayload(
        'doc.txt',
        'text/plain',
        Buffer.from('not-an-image')
      )

      const response = await app.inject({
        method: 'POST',
        url: '/api/admin/design/favicon',
        headers: {
          authorization: 'Bearer test-token',
          'content-type': contentType,
        },
        body,
      })

      expect(response.statusCode).toBe(400)
    })
  })
})
