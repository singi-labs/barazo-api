import { describe, it, expect, vi, beforeEach } from 'vitest'
import { backfillAccountCreatedAt } from '../../../scripts/backfill-account-created-at.js'
import type { BackfillDeps, BackfillResult } from '../../../scripts/backfill-account-created-at.js'

// ---------------------------------------------------------------------------
// Standalone mock functions (avoids @typescript-eslint/unbound-method)
// ---------------------------------------------------------------------------

const resolveCreationDateFn = vi.fn<(did: string) => Promise<Date | null>>()
const determineTrustStatusFn = vi.fn()

const dbSelectFn = vi.fn()
const dbUpdateFn = vi.fn()

const logInfoFn = vi.fn()
const logWarnFn = vi.fn()
const logErrorFn = vi.fn()

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockLogger() {
  return {
    info: logInfoFn,
    warn: logWarnFn,
    error: logErrorFn,
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn().mockReturnThis(),
    level: 'info',
    silent: vi.fn(),
  }
}

function createMockDeps(overrides?: Partial<BackfillDeps>): BackfillDeps {
  return {
    db: {
      select: dbSelectFn,
      update: dbUpdateFn,
    } as unknown as BackfillDeps['db'],
    accountAgeService: {
      resolveCreationDate: resolveCreationDateFn,
      determineTrustStatus: determineTrustStatusFn,
    },
    logger: createMockLogger() as unknown as BackfillDeps['logger'],
    batchSize: 50,
    delayMs: 0, // No delay in tests
    ...overrides,
  }
}

/** Build a mock user row with only the fields the backfill reads. */
function mockUser(did: string) {
  return { did }
}

/** Select chain mock refs for assertions. */
const selectFromFn = vi.fn()
const selectWhereFn = vi.fn()

/**
 * Wire up the mock DB so `db.select().from().where()` resolves to `rows`.
 */
function stubSelectUsers(rows: Array<{ did: string }>) {
  selectFromFn.mockReturnThis()
  selectWhereFn.mockResolvedValue(rows)
  dbSelectFn.mockReturnValue({ from: selectFromFn, where: selectWhereFn })
}

/** Update chain mock refs for assertions. */
const updateSetFn = vi.fn()
const updateWhereFn = vi.fn()

/**
 * Wire up the mock DB so `db.update().set().where()` resolves.
 */
function stubUpdateUser() {
  updateSetFn.mockReturnThis()
  updateWhereFn.mockResolvedValue(undefined)
  dbUpdateFn.mockReturnValue({ set: updateSetFn, where: updateWhereFn })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('backfillAccountCreatedAt', () => {
  let deps: BackfillDeps

  beforeEach(() => {
    vi.resetAllMocks()
    deps = createMockDeps()
  })

  it('fetches users where accountCreatedAt IS NULL and DID starts with did:plc:', async () => {
    stubSelectUsers([])

    await backfillAccountCreatedAt(deps)

    expect(dbSelectFn).toHaveBeenCalled()
  })

  it('calls resolveCreationDate for each user', async () => {
    const users = [mockUser('did:plc:abc'), mockUser('did:plc:def'), mockUser('did:plc:ghi')]
    stubSelectUsers(users)
    stubUpdateUser()

    const createdAt = new Date('2025-06-01T00:00:00Z')
    resolveCreationDateFn.mockResolvedValue(createdAt)

    await backfillAccountCreatedAt(deps)

    expect(resolveCreationDateFn).toHaveBeenCalledTimes(3)
    expect(resolveCreationDateFn).toHaveBeenCalledWith('did:plc:abc')
    expect(resolveCreationDateFn).toHaveBeenCalledWith('did:plc:def')
    expect(resolveCreationDateFn).toHaveBeenCalledWith('did:plc:ghi')
  })

  it('updates the DB with the resolved date', async () => {
    const users = [mockUser('did:plc:abc')]
    stubSelectUsers(users)
    stubUpdateUser()

    const createdAt = new Date('2025-06-01T00:00:00Z')
    resolveCreationDateFn.mockResolvedValue(createdAt)

    await backfillAccountCreatedAt(deps)

    expect(dbUpdateFn).toHaveBeenCalled()
    expect(updateSetFn).toHaveBeenCalledWith({ accountCreatedAt: createdAt })
  })

  it('skips users where resolution returns null and logs a warning', async () => {
    const users = [mockUser('did:plc:abc')]
    stubSelectUsers(users)
    stubUpdateUser()

    resolveCreationDateFn.mockResolvedValue(null)

    const result = await backfillAccountCreatedAt(deps)

    expect(dbUpdateFn).not.toHaveBeenCalled()
    expect(logWarnFn).toHaveBeenCalledWith(
      { did: 'did:plc:abc' },
      'Could not resolve account creation date, skipping'
    )
    expect(result.skipped).toBe(1)
  })

  it('respects batch size configuration', async () => {
    deps = createMockDeps({ batchSize: 2 })

    const users = [mockUser('did:plc:a'), mockUser('did:plc:b'), mockUser('did:plc:c')]
    stubSelectUsers(users)
    stubUpdateUser()

    const createdAt = new Date('2025-06-01T00:00:00Z')
    resolveCreationDateFn.mockResolvedValue(createdAt)

    await backfillAccountCreatedAt(deps)

    // All 3 users should still be processed regardless of batch size
    expect(resolveCreationDateFn).toHaveBeenCalledTimes(3)
  })

  it('reports correct summary counts', async () => {
    const users = [
      mockUser('did:plc:resolved1'),
      mockUser('did:plc:resolved2'),
      mockUser('did:plc:skipped'),
    ]
    stubSelectUsers(users)
    stubUpdateUser()

    const createdAt = new Date('2025-06-01T00:00:00Z')
    resolveCreationDateFn
      .mockResolvedValueOnce(createdAt)
      .mockResolvedValueOnce(createdAt)
      .mockResolvedValueOnce(null) // skipped

    const result = await backfillAccountCreatedAt(deps)

    expect(result).toEqual<BackfillResult>({
      total: 3,
      resolved: 2,
      skipped: 1,
      failed: 0,
    })
  })

  it('counts failed resolutions when resolveCreationDate throws', async () => {
    const users = [mockUser('did:plc:good'), mockUser('did:plc:bad')]
    stubSelectUsers(users)
    stubUpdateUser()

    const createdAt = new Date('2025-06-01T00:00:00Z')
    resolveCreationDateFn
      .mockResolvedValueOnce(createdAt)
      .mockRejectedValueOnce(new Error('Unexpected failure'))

    const result = await backfillAccountCreatedAt(deps)

    expect(result.resolved).toBe(1)
    expect(result.failed).toBe(1)
    expect(logErrorFn).toHaveBeenCalled()
  })

  it('returns zeroes when no users need backfilling', async () => {
    stubSelectUsers([])

    const result = await backfillAccountCreatedAt(deps)

    expect(result).toEqual<BackfillResult>({
      total: 0,
      resolved: 0,
      skipped: 0,
      failed: 0,
    })
    expect(logInfoFn).toHaveBeenCalledWith('No users need account age backfilling')
  })

  it('logs progress at configured intervals', async () => {
    deps = createMockDeps({ batchSize: 50 })

    // Create 12 users to trigger at least one progress log (every 10)
    const users = Array.from({ length: 12 }, (_, i) => mockUser(`did:plc:user${String(i)}`))
    stubSelectUsers(users)
    stubUpdateUser()

    const createdAt = new Date('2025-06-01T00:00:00Z')
    resolveCreationDateFn.mockResolvedValue(createdAt)

    await backfillAccountCreatedAt(deps)

    // Should have logged progress after 10th user
    const progressLog = logInfoFn.mock.calls.find(
      (call: unknown[]) =>
        typeof call[0] === 'object' &&
        call[0] !== null &&
        'processed' in (call[0] as Record<string, unknown>) &&
        (call[0] as Record<string, unknown>)['processed'] === 10
    )
    expect(progressLog).toBeDefined()
  })
})
