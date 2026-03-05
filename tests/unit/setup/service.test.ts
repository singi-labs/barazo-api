import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createSetupService } from '../../../src/setup/service.js'
import type { SetupService } from '../../../src/setup/service.js'
import type { PlcDidService, GenerateDidResult } from '../../../src/services/plc-did.js'
import type { Logger } from '../../../src/lib/logger.js'
import { decrypt } from '../../../src/lib/encryption.js'

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function createMockDb() {
  // Select chain: db.select().from().where() -> Promise<rows[]>
  const whereSelectFn = vi.fn<() => Promise<unknown[]>>()
  const fromFn = vi.fn<() => { where: typeof whereSelectFn }>().mockReturnValue({
    where: whereSelectFn,
  })
  const selectFn = vi.fn<() => { from: typeof fromFn }>().mockReturnValue({
    from: fromFn,
  })

  // Upsert chain: db.insert().values().onConflictDoUpdate().returning() -> Promise<rows[]>
  // Also supports: db.insert().values().onConflictDoNothing() -> Promise<rows[]>
  const returningFn = vi.fn<() => Promise<unknown[]>>()
  const onConflictDoUpdateFn = vi.fn<() => { returning: typeof returningFn }>().mockReturnValue({
    returning: returningFn,
  })
  const onConflictDoNothingFn = vi.fn<() => Promise<unknown[]>>().mockResolvedValue([])
  const valuesFn = vi
    .fn<
      () => {
        onConflictDoUpdate: typeof onConflictDoUpdateFn
        onConflictDoNothing: typeof onConflictDoNothingFn
      }
    >()
    .mockReturnValue({
      onConflictDoUpdate: onConflictDoUpdateFn,
      onConflictDoNothing: onConflictDoNothingFn,
    })
  const insertFn = vi.fn<() => { values: typeof valuesFn }>().mockReturnValue({
    values: valuesFn,
  })

  // Update chain: db.update().set().where() -> Promise<unknown[]>
  const whereUpdateFn = vi.fn<() => Promise<unknown[]>>().mockResolvedValue([])
  const setFn = vi.fn<() => { where: typeof whereUpdateFn }>().mockReturnValue({
    where: whereUpdateFn,
  })
  const updateFn = vi.fn<() => { set: typeof setFn }>().mockReturnValue({
    set: setFn,
  })

  return {
    db: { select: selectFn, insert: insertFn, update: updateFn },
    mocks: {
      selectFn,
      fromFn,
      whereSelectFn,
      insertFn,
      valuesFn,
      onConflictDoUpdateFn,
      onConflictDoNothingFn,
      returningFn,
      updateFn,
      setFn,
      whereUpdateFn,
    },
  }
}

function createMockLogger(): Logger {
  return {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn(),
    silent: vi.fn(),
    level: 'silent',
  } as unknown as Logger
}

function createMockPlcDidService(): PlcDidService & {
  generateDid: ReturnType<typeof vi.fn>
} {
  return {
    generateDid: vi.fn<() => Promise<GenerateDidResult>>(),
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TEST_DID = 'did:plc:test123456789'
const DEFAULT_COMMUNITY_NAME = 'Barazo Community'
const TEST_HANDLE = 'community.barazo.forum'
const TEST_SERVICE_ENDPOINT = 'https://community.barazo.forum'
const TEST_COMMUNITY_DID = 'did:plc:communityabc123456'
const TEST_SIGNING_KEY = 'a'.repeat(64)
const TEST_ROTATION_KEY = 'b'.repeat(64)
const TEST_ENCRYPTION_KEY = 'c'.repeat(32)

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('SetupService', () => {
  let service: SetupService
  let mocks: ReturnType<typeof createMockDb>['mocks']
  let mockLogger: Logger
  let mockPlcDidService: ReturnType<typeof createMockPlcDidService>

  beforeEach(() => {
    const { db, mocks: m } = createMockDb()
    mocks = m
    mockLogger = createMockLogger()
    mockPlcDidService = createMockPlcDidService()
    service = createSetupService(db as never, mockLogger, TEST_ENCRYPTION_KEY, mockPlcDidService)
  })

  // =========================================================================
  // getStatus
  // =========================================================================

  describe('getStatus()', () => {
    it('returns { initialized: false } when no settings row exists', async () => {
      mocks.whereSelectFn.mockResolvedValueOnce([])

      const result = await service.getStatus()

      expect(result).toStrictEqual({ initialized: false })
    })

    it('returns { initialized: false } when settings exist but not initialized', async () => {
      mocks.whereSelectFn.mockResolvedValueOnce([
        {
          initialized: false,
          communityName: 'Test Community',
        },
      ])

      const result = await service.getStatus()

      expect(result).toStrictEqual({ initialized: false })
    })

    it('returns { initialized: true, communityName } when initialized', async () => {
      mocks.whereSelectFn.mockResolvedValueOnce([
        {
          initialized: true,
          communityName: 'My Forum',
        },
      ])

      const result = await service.getStatus()

      expect(result).toStrictEqual({
        initialized: true,
        communityName: 'My Forum',
      })
    })

    it('propagates database errors', async () => {
      mocks.whereSelectFn.mockRejectedValueOnce(new Error('Connection lost'))

      await expect(service.getStatus()).rejects.toThrow('Connection lost')
    })
  })

  // =========================================================================
  // initialize (basic, without PLC DID)
  // =========================================================================

  describe('initialize() without PLC DID', () => {
    it('returns success for first authenticated user when no row exists', async () => {
      mocks.returningFn.mockResolvedValueOnce([
        { communityName: DEFAULT_COMMUNITY_NAME, communityDid: null },
      ])

      const result = await service.initialize({ did: TEST_DID })

      expect(result).toStrictEqual({
        initialized: true,
        adminDid: TEST_DID,
        communityName: DEFAULT_COMMUNITY_NAME,
      })
      expect(mocks.insertFn).toHaveBeenCalled()
      expect(mockPlcDidService.generateDid).not.toHaveBeenCalled()
    })

    it('returns success when row exists but not initialized', async () => {
      mocks.returningFn.mockResolvedValueOnce([
        { communityName: 'Existing Name', communityDid: null },
      ])

      const result = await service.initialize({ did: TEST_DID })

      expect(result).toStrictEqual({
        initialized: true,
        adminDid: TEST_DID,
        communityName: 'Existing Name',
      })
      expect(mocks.insertFn).toHaveBeenCalled()
    })

    it('returns conflict error when already initialized', async () => {
      mocks.returningFn.mockResolvedValueOnce([])

      const result = await service.initialize({ did: TEST_DID })

      expect(result).toStrictEqual({ alreadyInitialized: true })
    })

    it('accepts optional communityName', async () => {
      mocks.returningFn.mockResolvedValueOnce([
        { communityName: 'Custom Name', communityDid: null },
      ])

      const result = await service.initialize({
        did: TEST_DID,
        communityName: 'Custom Name',
      })

      expect(result).toStrictEqual({
        initialized: true,
        adminDid: TEST_DID,
        communityName: 'Custom Name',
      })
      expect(mocks.insertFn).toHaveBeenCalled()
    })

    it('preserves existing communityName when no override provided', async () => {
      mocks.returningFn.mockResolvedValueOnce([
        { communityName: 'Keep This Name', communityDid: null },
      ])

      const result = await service.initialize({ did: TEST_DID })

      expect(result).toStrictEqual({
        initialized: true,
        adminDid: TEST_DID,
        communityName: 'Keep This Name',
      })
    })

    it('propagates database errors', async () => {
      mocks.returningFn.mockRejectedValueOnce(new Error('Connection lost'))

      await expect(service.initialize({ did: TEST_DID })).rejects.toThrow('Connection lost')
    })

    it('does not call PLC DID service when only handle is provided (no serviceEndpoint)', async () => {
      mocks.returningFn.mockResolvedValueOnce([
        { communityName: DEFAULT_COMMUNITY_NAME, communityDid: null },
      ])

      await service.initialize({
        did: TEST_DID,
        handle: TEST_HANDLE,
      })

      expect(mockPlcDidService.generateDid).not.toHaveBeenCalled()
    })

    it('does not call PLC DID service when only serviceEndpoint is provided (no handle)', async () => {
      mocks.returningFn.mockResolvedValueOnce([
        { communityName: DEFAULT_COMMUNITY_NAME, communityDid: null },
      ])

      await service.initialize({
        did: TEST_DID,
        serviceEndpoint: TEST_SERVICE_ENDPOINT,
      })

      expect(mockPlcDidService.generateDid).not.toHaveBeenCalled()
    })

    it('promotes initializing user to admin role in users table', async () => {
      mocks.returningFn.mockResolvedValueOnce([{ communityName: 'Test Forum', communityDid: null }])

      const result = await service.initialize({
        did: TEST_DID,
        communityName: 'Test Forum',
      })

      expect(result).toStrictEqual({
        initialized: true,
        adminDid: TEST_DID,
        communityName: 'Test Forum',
      })
      expect(mocks.updateFn).toHaveBeenCalledOnce()
    })

    it('does not promote user when community is already initialized', async () => {
      mocks.returningFn.mockResolvedValueOnce([])

      const result = await service.initialize({ did: TEST_DID })

      expect(result).toStrictEqual({ alreadyInitialized: true })
      expect(mocks.updateFn).not.toHaveBeenCalled()
    })

    it('seeds platform:age_confirmation onboarding field after initialization', async () => {
      mocks.returningFn.mockResolvedValueOnce([
        { communityName: DEFAULT_COMMUNITY_NAME, communityDid: TEST_COMMUNITY_DID },
      ])

      await service.initialize({ did: TEST_DID, communityDid: TEST_COMMUNITY_DID })

      // insert is called 6 times: settings, onboarding, pages, categories, topics, replies
      expect(mocks.insertFn).toHaveBeenCalledTimes(6)

      // The second insert's values call should contain the platform age field
      const secondValuesCall = mocks.valuesFn.mock.calls[1]?.[0] as Record<string, unknown>
      expect(secondValuesCall).toBeDefined()
      expect(secondValuesCall.id).toBe('platform:age_confirmation')
      expect(secondValuesCall.fieldType).toBe('age_confirmation')
      expect(secondValuesCall.source).toBe('platform')
      expect(secondValuesCall.isMandatory).toBe(true)
      expect(secondValuesCall.sortOrder).toBe(-1)
      expect(mocks.onConflictDoNothingFn).toHaveBeenCalled()
    })

    it('does not seed platform fields when community is already initialized', async () => {
      mocks.returningFn.mockResolvedValueOnce([])

      await service.initialize({ did: TEST_DID })

      // Only one insert call (the upsert attempt), no seeding
      expect(mocks.insertFn).toHaveBeenCalledTimes(1)
    })
  })

  // =========================================================================
  // initialize (with PLC DID generation)
  // =========================================================================

  describe('initialize() with PLC DID', () => {
    it('generates PLC DID when handle and serviceEndpoint are provided', async () => {
      mockPlcDidService.generateDid.mockResolvedValueOnce({
        did: TEST_COMMUNITY_DID,
        signingKey: TEST_SIGNING_KEY,
        rotationKey: TEST_ROTATION_KEY,
      })
      mocks.returningFn.mockResolvedValueOnce([
        { communityName: DEFAULT_COMMUNITY_NAME, communityDid: TEST_COMMUNITY_DID },
      ])

      const result = await service.initialize({
        did: TEST_DID,
        handle: TEST_HANDLE,
        serviceEndpoint: TEST_SERVICE_ENDPOINT,
      })

      expect(mockPlcDidService.generateDid).toHaveBeenCalledOnce()
      expect(mockPlcDidService.generateDid).toHaveBeenCalledWith({
        handle: TEST_HANDLE,
        serviceEndpoint: TEST_SERVICE_ENDPOINT,
      })

      expect(result).toStrictEqual({
        initialized: true,
        adminDid: TEST_DID,
        communityName: DEFAULT_COMMUNITY_NAME,
        communityDid: TEST_COMMUNITY_DID,
      })
    })

    it('includes communityDid in result when DID is generated', async () => {
      mockPlcDidService.generateDid.mockResolvedValueOnce({
        did: TEST_COMMUNITY_DID,
        signingKey: TEST_SIGNING_KEY,
        rotationKey: TEST_ROTATION_KEY,
      })
      mocks.returningFn.mockResolvedValueOnce([
        { communityName: 'My Forum', communityDid: TEST_COMMUNITY_DID },
      ])

      const result = await service.initialize({
        did: TEST_DID,
        communityName: 'My Forum',
        handle: TEST_HANDLE,
        serviceEndpoint: TEST_SERVICE_ENDPOINT,
      })

      expect(result).toHaveProperty('communityDid', TEST_COMMUNITY_DID)
    })

    it('does not include communityDid in result when DID is null', async () => {
      mocks.returningFn.mockResolvedValueOnce([
        { communityName: DEFAULT_COMMUNITY_NAME, communityDid: null },
      ])

      const result = await service.initialize({ did: TEST_DID })

      expect(result).not.toHaveProperty('communityDid')
    })

    it('encrypts signing and rotation keys before storing in DB', async () => {
      mockPlcDidService.generateDid.mockResolvedValueOnce({
        did: TEST_COMMUNITY_DID,
        signingKey: TEST_SIGNING_KEY,
        rotationKey: TEST_ROTATION_KEY,
      })
      mocks.returningFn.mockResolvedValueOnce([
        { communityName: DEFAULT_COMMUNITY_NAME, communityDid: TEST_COMMUNITY_DID },
      ])

      await service.initialize({
        did: TEST_DID,
        handle: TEST_HANDLE,
        serviceEndpoint: TEST_SERVICE_ENDPOINT,
      })

      // Extract the values passed to the DB insert
      const callArgs = mocks.valuesFn.mock.calls[0]
      expect(callArgs).toBeDefined()
      const insertValues = (callArgs as unknown[][])[0] as Record<string, unknown>

      // Keys should NOT be plaintext
      expect(insertValues.signingKey).not.toBe(TEST_SIGNING_KEY)
      expect(insertValues.rotationKey).not.toBe(TEST_ROTATION_KEY)

      // Keys should be decryptable back to the originals
      expect(decrypt(insertValues.signingKey as string, TEST_ENCRYPTION_KEY)).toBe(TEST_SIGNING_KEY)
      expect(decrypt(insertValues.rotationKey as string, TEST_ENCRYPTION_KEY)).toBe(
        TEST_ROTATION_KEY
      )
    })

    it('propagates PLC DID generation errors', async () => {
      mockPlcDidService.generateDid.mockRejectedValueOnce(
        new Error('PLC directory returned 500: Internal Server Error')
      )

      await expect(
        service.initialize({
          did: TEST_DID,
          handle: TEST_HANDLE,
          serviceEndpoint: TEST_SERVICE_ENDPOINT,
        })
      ).rejects.toThrow('PLC directory returned 500: Internal Server Error')
    })

    it('logs info when generating PLC DID', async () => {
      mockPlcDidService.generateDid.mockResolvedValueOnce({
        did: TEST_COMMUNITY_DID,
        signingKey: TEST_SIGNING_KEY,
        rotationKey: TEST_ROTATION_KEY,
      })
      mocks.returningFn.mockResolvedValueOnce([
        { communityName: DEFAULT_COMMUNITY_NAME, communityDid: TEST_COMMUNITY_DID },
      ])

      await service.initialize({
        did: TEST_DID,
        handle: TEST_HANDLE,
        serviceEndpoint: TEST_SERVICE_ENDPOINT,
      })

      const infoFn = mockLogger.info as ReturnType<typeof vi.fn>
      expect(infoFn).toHaveBeenCalledWith(
        expect.objectContaining({
          handle: TEST_HANDLE,
          serviceEndpoint: TEST_SERVICE_ENDPOINT,
        }) as Record<string, unknown>,
        'Generating PLC DID during community setup'
      )
    })
  })

  // =========================================================================
  // initialize (page seeding)
  // =========================================================================

  describe('initialize() page seeding', () => {
    it('seeds default pages after admin promotion', async () => {
      mocks.returningFn.mockResolvedValueOnce([
        { communityName: DEFAULT_COMMUNITY_NAME, communityDid: TEST_COMMUNITY_DID },
      ])

      await service.initialize({
        communityDid: TEST_COMMUNITY_DID,
        did: TEST_DID,
      })

      // insert is called 6 times: settings, onboarding, pages, categories, topics, replies
      expect(mocks.insertFn).toHaveBeenCalledTimes(6)
    })

    it('seeds exactly 4 default pages with correct slugs', async () => {
      mocks.returningFn.mockResolvedValueOnce([
        { communityName: DEFAULT_COMMUNITY_NAME, communityDid: TEST_COMMUNITY_DID },
      ])

      // Capture the values passed to the pages insert call (pages have 'status' field)
      let capturedPageValues: Array<{ slug: string; status: string; communityDid: string }> = []
      mocks.valuesFn.mockImplementation((vals: unknown) => {
        if (
          Array.isArray(vals) &&
          vals.length > 0 &&
          'status' in (vals[0] as Record<string, unknown>) &&
          'slug' in (vals[0] as Record<string, unknown>)
        ) {
          capturedPageValues = vals as typeof capturedPageValues
        }
        return {
          onConflictDoUpdate: mocks.onConflictDoUpdateFn,
          onConflictDoNothing: mocks.onConflictDoNothingFn,
        }
      })

      await service.initialize({
        communityDid: TEST_COMMUNITY_DID,
        did: TEST_DID,
      })

      expect(capturedPageValues).toHaveLength(4)
      const slugs = capturedPageValues.map((v) => v.slug)
      expect(slugs).toContain('terms-of-service')
      expect(slugs).toContain('privacy-policy')
      expect(slugs).toContain('cookie-policy')
      expect(slugs).toContain('accessibility')

      for (const page of capturedPageValues) {
        expect(page.status).toBe('published')
        expect(page.communityDid).toBe(TEST_COMMUNITY_DID)
      }
    })

    it('does not seed pages when community is already initialized', async () => {
      mocks.returningFn.mockResolvedValueOnce([])

      const result = await service.initialize({
        communityDid: TEST_COMMUNITY_DID,
        did: TEST_DID,
      })

      expect(result).toStrictEqual({ alreadyInitialized: true })
      // Only 1 insert call (the upsert), no pages insert
      expect(mocks.insertFn).toHaveBeenCalledTimes(1)
    })

    it('logs page seeding info', async () => {
      mocks.returningFn.mockResolvedValueOnce([
        { communityName: DEFAULT_COMMUNITY_NAME, communityDid: TEST_COMMUNITY_DID },
      ])

      await service.initialize({
        communityDid: TEST_COMMUNITY_DID,
        did: TEST_DID,
      })

      const infoFn = mockLogger.info as ReturnType<typeof vi.fn>
      const logCalls = infoFn.mock.calls as Array<[Record<string, unknown>, string]>
      const seedLog = logCalls.find(
        ([_ctx, msg]) => typeof msg === 'string' && msg.includes('Default pages seeded')
      )
      expect(seedLog).toBeDefined()
      if (seedLog) {
        expect(seedLog[0]).toHaveProperty('communityDid', TEST_COMMUNITY_DID)
        expect(seedLog[0]).toHaveProperty('pageCount', 4)
      }
    })
  })

  // =========================================================================
  // initialize (category and demo content seeding)
  // =========================================================================

  describe('initialize() category and demo content seeding', () => {
    it('seeds categories with subcategories', async () => {
      mocks.returningFn.mockResolvedValueOnce([
        { communityName: DEFAULT_COMMUNITY_NAME, communityDid: TEST_COMMUNITY_DID },
      ])

      let capturedCategoryValues: Array<{
        slug: string
        parentId: string | null
        communityDid: string
      }> = []
      mocks.valuesFn.mockImplementation((vals: unknown) => {
        if (
          Array.isArray(vals) &&
          vals.length > 0 &&
          'maturityRating' in (vals[0] as Record<string, unknown>) &&
          'slug' in (vals[0] as Record<string, unknown>)
        ) {
          capturedCategoryValues = vals as typeof capturedCategoryValues
        }
        return {
          onConflictDoUpdate: mocks.onConflictDoUpdateFn,
          onConflictDoNothing: mocks.onConflictDoNothingFn,
        }
      })

      await service.initialize({
        communityDid: TEST_COMMUNITY_DID,
        did: TEST_DID,
      })

      expect(capturedCategoryValues.length).toBeGreaterThan(4)

      // Root categories have null parentId
      const roots = capturedCategoryValues.filter((c) => c.parentId === null)
      expect(roots.length).toBeGreaterThanOrEqual(4)

      // Subcategories have non-null parentId
      const subs = capturedCategoryValues.filter((c) => c.parentId !== null)
      expect(subs.length).toBeGreaterThanOrEqual(3)

      // All categories belong to the correct community
      for (const cat of capturedCategoryValues) {
        expect(cat.communityDid).toBe(TEST_COMMUNITY_DID)
      }
    })

    it('seeds demo topics across categories including subcategories', async () => {
      mocks.returningFn.mockResolvedValueOnce([
        { communityName: DEFAULT_COMMUNITY_NAME, communityDid: TEST_COMMUNITY_DID },
      ])

      let capturedTopicValues: Array<{
        category: string
        title: string
        authorDid: string
      }> = []
      mocks.valuesFn.mockImplementation((vals: unknown) => {
        if (
          Array.isArray(vals) &&
          vals.length > 0 &&
          'title' in (vals[0] as Record<string, unknown>) &&
          'category' in (vals[0] as Record<string, unknown>)
        ) {
          capturedTopicValues = vals as typeof capturedTopicValues
        }
        return {
          onConflictDoUpdate: mocks.onConflictDoUpdateFn,
          onConflictDoNothing: mocks.onConflictDoNothingFn,
        }
      })

      await service.initialize({
        communityDid: TEST_COMMUNITY_DID,
        did: TEST_DID,
      })

      expect(capturedTopicValues.length).toBeGreaterThanOrEqual(5)

      // Topics should span both root and subcategories
      const topicCategories = new Set(capturedTopicValues.map((t) => t.category))
      expect(topicCategories.has('general')).toBe(true)
      expect(topicCategories.has('frontend')).toBe(true)
      expect(topicCategories.has('backend')).toBe(true)

      // All topics use the admin DID as author
      for (const topic of capturedTopicValues) {
        expect(topic.authorDid).toBe(TEST_DID)
      }
    })

    it('seeds demo replies for each topic', async () => {
      mocks.returningFn.mockResolvedValueOnce([
        { communityName: DEFAULT_COMMUNITY_NAME, communityDid: TEST_COMMUNITY_DID },
      ])

      let capturedReplyValues: Array<{
        rootUri: string
        authorDid: string
        depth: number
      }> = []
      mocks.valuesFn.mockImplementation((vals: unknown) => {
        if (
          Array.isArray(vals) &&
          vals.length > 0 &&
          'rootUri' in (vals[0] as Record<string, unknown>) &&
          'depth' in (vals[0] as Record<string, unknown>)
        ) {
          capturedReplyValues = vals as typeof capturedReplyValues
        }
        return {
          onConflictDoUpdate: mocks.onConflictDoUpdateFn,
          onConflictDoNothing: mocks.onConflictDoNothingFn,
        }
      })

      await service.initialize({
        communityDid: TEST_COMMUNITY_DID,
        did: TEST_DID,
      })

      // One reply per topic
      expect(capturedReplyValues.length).toBeGreaterThanOrEqual(5)

      for (const reply of capturedReplyValues) {
        expect(reply.authorDid).toBe(TEST_DID)
        expect(reply.depth).toBe(1)
      }
    })

    it('logs category and demo content seeding', async () => {
      mocks.returningFn.mockResolvedValueOnce([
        { communityName: DEFAULT_COMMUNITY_NAME, communityDid: TEST_COMMUNITY_DID },
      ])

      await service.initialize({
        communityDid: TEST_COMMUNITY_DID,
        did: TEST_DID,
      })

      const infoFn = mockLogger.info as ReturnType<typeof vi.fn>
      const logCalls = infoFn.mock.calls as Array<[Record<string, unknown>, string]>

      const catLog = logCalls.find(
        ([_ctx, msg]) => typeof msg === 'string' && msg.includes('Default categories seeded')
      )
      expect(catLog).toBeDefined()

      const contentLog = logCalls.find(
        ([_ctx, msg]) => typeof msg === 'string' && msg.includes('Demo content seeded')
      )
      expect(contentLog).toBeDefined()
    })
  })

  // =========================================================================
  // initialize (without PlcDidService injected)
  // =========================================================================

  describe('initialize() without PlcDidService', () => {
    it('logs warning when handle/serviceEndpoint provided but no PlcDidService', async () => {
      // Create service without PlcDidService
      const { db, mocks: m } = createMockDb()
      const logger = createMockLogger()
      const serviceWithoutPlc = createSetupService(db as never, logger, TEST_ENCRYPTION_KEY)

      m.returningFn.mockResolvedValueOnce([
        { communityName: DEFAULT_COMMUNITY_NAME, communityDid: null },
      ])

      await serviceWithoutPlc.initialize({
        did: TEST_DID,
        handle: TEST_HANDLE,
        serviceEndpoint: TEST_SERVICE_ENDPOINT,
      })

      const warnFn = logger.warn as ReturnType<typeof vi.fn>
      expect(warnFn).toHaveBeenCalledWith(
        expect.objectContaining({
          handle: TEST_HANDLE,
          serviceEndpoint: TEST_SERVICE_ENDPOINT,
        }) as Record<string, unknown>,
        'PLC DID generation requested but PlcDidService not available'
      )
    })
  })
})
