import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createProfileSyncService } from '../../../src/services/profile-sync.js'
import type { ProfileSyncService } from '../../../src/services/profile-sync.js'
import type { Logger } from '../../../src/lib/logger.js'
import type { Database } from '../../../src/db/index.js'

// ---------------------------------------------------------------------------
// Mock logger
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function createMockDb(overrides?: { whereReturn?: ReturnType<typeof vi.fn> }) {
  const whereFn = overrides?.whereReturn ?? vi.fn().mockResolvedValue(undefined)
  const setFn = vi.fn().mockReturnValue({ where: whereFn })
  const updateFn = vi.fn().mockReturnValue({ set: setFn })

  return {
    update: updateFn,
    _mocks: { updateFn, setFn, whereFn },
  } as unknown as Database & {
    _mocks: {
      updateFn: ReturnType<typeof vi.fn>
      setFn: ReturnType<typeof vi.fn>
      whereFn: ReturnType<typeof vi.fn>
    }
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TEST_DID = 'did:plc:testuser123456789012'

const MOCK_PROFILE_RESPONSE = {
  success: true,
  data: {
    did: TEST_DID,
    handle: 'alice.bsky.social',
    displayName: 'Alice Wonderland',
    avatar: 'https://cdn.bsky.app/img/avatar/plain/did:plc:testuser123456789012/bafkreiabc@jpeg',
    banner: 'https://cdn.bsky.app/img/banner/plain/did:plc:testuser123456789012/bafkreixyz@jpeg',
    description: 'Exploring the decentralized web.',
    labels: [
      {
        src: TEST_DID,
        uri: `at://${TEST_DID}`,
        val: 'adult-content',
        neg: false,
        cts: '2026-01-15T10:00:00.000Z',
      },
      {
        src: 'did:plc:ozone-mod-service',
        uri: `at://${TEST_DID}`,
        val: '!warn',
        neg: false,
        cts: '2026-01-20T12:00:00.000Z',
      },
      {
        src: TEST_DID,
        uri: `at://${TEST_DID}`,
        val: 'old-label',
        neg: true,
        cts: '2026-01-25T08:00:00.000Z',
      },
    ],
  },
}

const MOCK_MINIMAL_PROFILE_RESPONSE = {
  success: true,
  data: {
    did: TEST_DID,
    handle: 'bob.bsky.social',
  },
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ProfileSyncService', () => {
  let service: ProfileSyncService
  let mockLogger: Logger
  let mockDb: ReturnType<typeof createMockDb>
  let mockGetProfile: ReturnType<typeof vi.fn>

  beforeEach(() => {
    mockLogger = createMockLogger()
    mockGetProfile = vi.fn().mockResolvedValue(MOCK_PROFILE_RESPONSE)
    mockDb = createMockDb()

    service = createProfileSyncService(mockDb, mockLogger, {
      createAgent: () => ({
        getProfile: mockGetProfile,
      }),
    })
  })

  // -------------------------------------------------------------------------
  // Successful sync
  // -------------------------------------------------------------------------

  it('returns profile data on successful fetch', async () => {
    const result = await service.syncProfile(TEST_DID)

    expect(result).toStrictEqual({
      displayName: 'Alice Wonderland',
      avatarUrl:
        'https://cdn.bsky.app/img/avatar/plain/did:plc:testuser123456789012/bafkreiabc@jpeg',
      bannerUrl:
        'https://cdn.bsky.app/img/banner/plain/did:plc:testuser123456789012/bafkreixyz@jpeg',
      bio: 'Exploring the decentralized web.',
      labels: [
        { val: 'adult-content', src: TEST_DID, neg: false, cts: '2026-01-15T10:00:00.000Z' },
        {
          val: '!warn',
          src: 'did:plc:ozone-mod-service',
          neg: false,
          cts: '2026-01-20T12:00:00.000Z',
        },
      ],
    })
  })

  it('calls getProfile with the user DID', async () => {
    await service.syncProfile(TEST_DID)

    expect(mockGetProfile).toHaveBeenCalledWith({ actor: TEST_DID })
  })

  it('updates the users table with profile data and lastActiveAt', async () => {
    await service.syncProfile(TEST_DID)

    expect(mockDb._mocks.updateFn).toHaveBeenCalled()
  })

  // -------------------------------------------------------------------------
  // Label capture
  // -------------------------------------------------------------------------

  it('returns labels from profile, filtering out negated labels', async () => {
    const result = await service.syncProfile(TEST_DID)

    expect(result.labels).toStrictEqual([
      { val: 'adult-content', src: TEST_DID, neg: false, cts: '2026-01-15T10:00:00.000Z' },
      {
        val: '!warn',
        src: 'did:plc:ozone-mod-service',
        neg: false,
        cts: '2026-01-20T12:00:00.000Z',
      },
    ])
  })

  it('returns empty labels array when profile has no labels', async () => {
    mockGetProfile.mockResolvedValue(MOCK_MINIMAL_PROFILE_RESPONSE)

    const result = await service.syncProfile(TEST_DID)

    expect(result.labels).toStrictEqual([])
  })

  // -------------------------------------------------------------------------
  // No profile fields (minimal profile)
  // -------------------------------------------------------------------------

  it('returns null values when profile has no optional fields', async () => {
    mockGetProfile.mockResolvedValue(MOCK_MINIMAL_PROFILE_RESPONSE)

    const result = await service.syncProfile(TEST_DID)

    expect(result).toStrictEqual({
      displayName: null,
      avatarUrl: null,
      bannerUrl: null,
      bio: null,
      labels: [],
    })
  })

  // -------------------------------------------------------------------------
  // getProfile failure
  // -------------------------------------------------------------------------

  it('returns null values when getProfile throws', async () => {
    mockGetProfile.mockRejectedValue(new Error('Network timeout'))

    const result = await service.syncProfile(TEST_DID)

    expect(result).toStrictEqual({
      displayName: null,
      avatarUrl: null,
      bannerUrl: null,
      bio: null,
      labels: [],
    })
  })

  it('logs at debug level when getProfile fails', async () => {
    mockGetProfile.mockRejectedValue(new Error('Network timeout'))

    await service.syncProfile(TEST_DID)

    const debugFn = mockLogger.debug as ReturnType<typeof vi.fn>
    expect(debugFn).toHaveBeenCalledWith(
      expect.objectContaining({ did: TEST_DID }) as Record<string, unknown>,
      expect.stringContaining('profile sync failed') as string
    )
  })

  // -------------------------------------------------------------------------
  // DB update failure
  // -------------------------------------------------------------------------

  it('still returns profile data when DB update fails', async () => {
    mockDb = createMockDb({
      whereReturn: vi.fn().mockRejectedValue(new Error('DB connection lost')),
    })

    service = createProfileSyncService(mockDb, mockLogger, {
      createAgent: () => ({
        getProfile: mockGetProfile,
      }),
    })

    const result = await service.syncProfile(TEST_DID)

    expect(result).toStrictEqual({
      displayName: 'Alice Wonderland',
      avatarUrl:
        'https://cdn.bsky.app/img/avatar/plain/did:plc:testuser123456789012/bafkreiabc@jpeg',
      bannerUrl:
        'https://cdn.bsky.app/img/banner/plain/did:plc:testuser123456789012/bafkreixyz@jpeg',
      bio: 'Exploring the decentralized web.',
      labels: [
        { val: 'adult-content', src: TEST_DID, neg: false, cts: '2026-01-15T10:00:00.000Z' },
        {
          val: '!warn',
          src: 'did:plc:ozone-mod-service',
          neg: false,
          cts: '2026-01-20T12:00:00.000Z',
        },
      ],
    })
  })

  it('logs a warning when DB update fails', async () => {
    mockDb = createMockDb({
      whereReturn: vi.fn().mockRejectedValue(new Error('DB connection lost')),
    })

    service = createProfileSyncService(mockDb, mockLogger, {
      createAgent: () => ({
        getProfile: mockGetProfile,
      }),
    })

    await service.syncProfile(TEST_DID)

    const warnFn = mockLogger.warn as ReturnType<typeof vi.fn>
    expect(warnFn).toHaveBeenCalledWith(
      expect.objectContaining({ did: TEST_DID }) as Record<string, unknown>,
      expect.stringContaining('profile DB update failed') as string
    )
  })
})
