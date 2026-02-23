import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { FirehoseService } from '../../../src/firehose/service.js'
import type { Env } from '../../../src/config/env.js'

// --- Hoisted mock state (available before vi.mock runs) ---

const { mockTapChannelCtor, channelInstances, indexerInstances } = vi.hoisted(() => ({
  mockTapChannelCtor: vi.fn(),
  channelInstances: [] as Array<{
    url: string
    handler: unknown
    opts: unknown
    start: ReturnType<typeof vi.fn>
    destroy: ReturnType<typeof vi.fn>
  }>,
  indexerInstances: [] as Array<{
    _recordHandler?: (evt: unknown) => Promise<void>
    _identityHandler?: (evt: unknown) => Promise<void>
    _errorHandler?: (err: Error) => void
  }>,
}))

vi.mock('@atproto/tap', () => {
  class MockSimpleIndexer {
    _recordHandler?: (evt: unknown) => Promise<void>
    _identityHandler?: (evt: unknown) => Promise<void>
    _errorHandler?: (err: Error) => void

    constructor() {
      indexerInstances.push(this)
    }

    record(fn: (evt: unknown) => Promise<void>) {
      this._recordHandler = fn
      return this
    }
    identity(fn: (evt: unknown) => Promise<void>) {
      this._identityHandler = fn
      return this
    }
    error(fn: (err: Error) => void) {
      this._errorHandler = fn
      return this
    }

    onEvent = vi.fn()
    onError = vi.fn()
  }

  class MockTap {
    addRepos = vi.fn().mockResolvedValue(undefined)
    removeRepos = vi.fn().mockResolvedValue(undefined)
    channel = vi.fn()
  }

  return {
    Tap: MockTap,
    SimpleIndexer: MockSimpleIndexer,
    TapChannel: mockTapChannelCtor,
  }
})

// --- Helpers ---

/**
 * Creates a mock Drizzle query chain that supports both:
 *   await db.select().from(table)          -- thenable (restoreTrackedRepos)
 *   await db.select().from(table).where()  -- chained   (getCursor)
 */
function mockQueryChain(result: unknown[] = []) {
  const promise = Promise.resolve(result) as Promise<unknown[]> & {
    where: ReturnType<typeof vi.fn>
  }
  promise.where = vi.fn().mockResolvedValue(result)
  return promise
}

function createMockDb() {
  return {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue(mockQueryChain([])),
    }),
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
        onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
      }),
    }),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      }),
    }),
    delete: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(undefined),
    }),
    transaction: vi.fn(),
  }
}

function createMockLogger() {
  return {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  }
}

function createMinimalEnv(): Env {
  return {
    DATABASE_URL: 'postgresql://barazo:barazo_dev@localhost:5432/barazo',
    VALKEY_URL: 'redis://localhost:6379',
    TAP_URL: 'http://localhost:2480',
    TAP_ADMIN_PASSWORD: 'test_secret',
    HOST: '0.0.0.0',
    PORT: 3000,
    LOG_LEVEL: 'silent',
    CORS_ORIGINS: 'http://localhost:3001',
    COMMUNITY_MODE: 'single' as const,
    COMMUNITY_DID: 'did:plc:testcommunity',
    COMMUNITY_NAME: 'Test Community',
    RATE_LIMIT_AUTH: 10,
    RATE_LIMIT_WRITE: 10,
    RATE_LIMIT_READ_ANON: 100,
    RATE_LIMIT_READ_AUTH: 300,
  }
}

/** Minimal record event with unsupported collection (handler returns immediately). */
function createTestRecordEvent(id: number) {
  return {
    id,
    type: 'record' as const,
    action: 'create' as const,
    did: 'did:plc:test',
    rev: 'rev1',
    collection: 'com.example.unsupported',
    rkey: 'test',
    record: undefined,
    cid: undefined,
    live: true,
  }
}

/** Default TapChannel mock: start() never resolves (channel stays alive). */
function defaultChannelImpl(
  this: Record<string, unknown>,
  url: string,
  handler: unknown,
  opts: unknown
) {
  this.url = url
  this.handler = handler
  this.opts = opts
  this.start = vi.fn().mockReturnValue(new Promise(() => {}))
  this.destroy = vi.fn().mockResolvedValue(undefined)
  channelInstances.push(this as (typeof channelInstances)[number])
}

/** Get the record handler from the first indexer instance, or throw. */
function getRecordHandler() {
  const handler = indexerInstances[0]._recordHandler
  if (!handler) {
    throw new Error('record handler not registered on indexer')
  }
  return handler
}

/** TapChannel mock that rejects immediately on start(). */
function failingChannelImpl(
  this: Record<string, unknown>,
  url: string,
  handler: unknown,
  opts: unknown
) {
  this.url = url
  this.handler = handler
  this.opts = opts
  this.start = vi.fn().mockRejectedValue(new Error('Connection failed'))
  this.destroy = vi.fn().mockResolvedValue(undefined)
  channelInstances.push(this as (typeof channelInstances)[number])
}

// --- Tests ---

describe('FirehoseService', () => {
  let db: ReturnType<typeof createMockDb>
  let logger: ReturnType<typeof createMockLogger>
  let env: Env

  beforeEach(() => {
    vi.clearAllMocks()
    channelInstances.length = 0
    indexerInstances.length = 0
    mockTapChannelCtor.mockImplementation(defaultChannelImpl)

    db = createMockDb()
    logger = createMockLogger()
    env = createMinimalEnv()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('lifecycle', () => {
    it('creates a service instance', () => {
      const service = new FirehoseService(db as never, logger as never, env)
      expect(service).toBeDefined()
    })

    it('starts without throwing', async () => {
      const service = new FirehoseService(db as never, logger as never, env)
      await expect(service.start()).resolves.toBeUndefined()
    })

    it('stops without throwing', async () => {
      const service = new FirehoseService(db as never, logger as never, env)
      await service.start()
      await expect(service.stop()).resolves.toBeUndefined()
    })
  })

  describe('cursor restoration', () => {
    it('passes saved cursor as URL query parameter', async () => {
      // restoreTrackedRepos → [], getCursor → [{ cursor: 42n }]
      db.select
        .mockReturnValueOnce({ from: vi.fn().mockReturnValue(mockQueryChain([])) })
        .mockReturnValueOnce({ from: vi.fn().mockReturnValue(mockQueryChain([{ cursor: 42n }])) })

      const service = new FirehoseService(db as never, logger as never, env)
      await service.start()

      expect(channelInstances).toHaveLength(1)
      expect(channelInstances[0].url).toContain('cursor=42')
    })

    it('omits cursor when none is saved', async () => {
      const service = new FirehoseService(db as never, logger as never, env)
      await service.start()

      expect(channelInstances).toHaveLength(1)
      expect(channelInstances[0].url).not.toContain('cursor')
    })

    it('constructs WebSocket URL from TAP_URL', async () => {
      const service = new FirehoseService(db as never, logger as never, env)
      await service.start()

      expect(channelInstances[0].url).toBe('ws://localhost:2480/channel')
    })

    it('converts https to wss in channel URL', async () => {
      env.TAP_URL = 'https://tap.example.com'
      const service = new FirehoseService(db as never, logger as never, env)
      await service.start()

      expect(channelInstances[0].url).toBe('wss://tap.example.com/channel')
    })
  })

  describe('connected flag', () => {
    it('reports disconnected before start', () => {
      const service = new FirehoseService(db as never, logger as never, env)
      expect(service.getStatus().connected).toBe(false)
    })

    it('reports disconnected immediately after start (before events)', async () => {
      const service = new FirehoseService(db as never, logger as never, env)
      await service.start()
      expect(service.getStatus().connected).toBe(false)
    })

    it('reports connected after first event is processed', async () => {
      const service = new FirehoseService(db as never, logger as never, env)
      await service.start()

      await getRecordHandler()(createTestRecordEvent(1))

      expect(service.getStatus().connected).toBe(true)
      expect(service.getStatus().lastEventId).toBe(1)
    })

    it('sets connected to false on channel error', async () => {
      vi.useFakeTimers()

      let rejectChannel: ((err: Error) => void) | undefined
      mockTapChannelCtor.mockImplementationOnce(function (
        this: Record<string, unknown>,
        url: string,
        handler: unknown,
        opts: unknown
      ) {
        this.url = url
        this.handler = handler
        this.opts = opts
        this.start = vi.fn().mockReturnValue(
          new Promise<void>((_, reject) => {
            rejectChannel = reject
          })
        )
        this.destroy = vi.fn().mockResolvedValue(undefined)
        channelInstances.push(this as (typeof channelInstances)[number])
      })

      const service = new FirehoseService(db as never, logger as never, env)
      await service.start()

      await getRecordHandler()(createTestRecordEvent(1))
      expect(service.getStatus().connected).toBe(true)

      if (!rejectChannel) throw new Error('reject not captured')
      rejectChannel(new Error('Connection lost'))
      await vi.advanceTimersByTimeAsync(0)

      expect(service.getStatus().connected).toBe(false)

      await service.stop()
    })

    it('reports disconnected after stop', async () => {
      const service = new FirehoseService(db as never, logger as never, env)
      await service.start()

      await getRecordHandler()(createTestRecordEvent(1))
      expect(service.getStatus().connected).toBe(true)

      await service.stop()
      expect(service.getStatus().connected).toBe(false)
    })
  })

  describe('reconnection', () => {
    it('retries after channel error with exponential backoff', async () => {
      vi.useFakeTimers()

      let callCount = 0
      mockTapChannelCtor.mockImplementation(function (
        this: Record<string, unknown>,
        url: string,
        handler: unknown,
        opts: unknown
      ) {
        this.url = url
        this.handler = handler
        this.opts = opts
        this.destroy = vi.fn().mockResolvedValue(undefined)
        callCount++
        this.start =
          callCount <= 2
            ? vi.fn().mockRejectedValue(new Error('Connection failed'))
            : vi.fn().mockReturnValue(new Promise(() => {}))
        channelInstances.push(this as (typeof channelInstances)[number])
      })

      const service = new FirehoseService(db as never, logger as never, env)
      await service.start()
      expect(channelInstances).toHaveLength(1)

      // First rejection → 1s backoff
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(1000)
      expect(channelInstances).toHaveLength(2)

      // Second rejection → 2s backoff
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(2000)
      expect(channelInstances).toHaveLength(3)

      await service.stop()
    })

    it('resets backoff after successful event processing', async () => {
      vi.useFakeTimers()

      let channel2Reject: ((err: Error) => void) | undefined
      mockTapChannelCtor.mockImplementation(function (
        this: Record<string, unknown>,
        url: string,
        handler: unknown,
        opts: unknown
      ) {
        this.url = url
        this.handler = handler
        this.opts = opts
        this.destroy = vi.fn().mockResolvedValue(undefined)
        const idx = channelInstances.length
        if (idx === 0) {
          this.start = vi.fn().mockRejectedValue(new Error('fail'))
        } else if (idx === 1) {
          this.start = vi.fn().mockReturnValue(
            new Promise<void>((_, reject) => {
              channel2Reject = reject
            })
          )
        } else {
          this.start = vi.fn().mockReturnValue(new Promise(() => {}))
        }
        channelInstances.push(this as (typeof channelInstances)[number])
      })

      const service = new FirehoseService(db as never, logger as never, env)
      await service.start()

      // Channel #1 fails → 1s backoff
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(1000)
      expect(channelInstances).toHaveLength(2)

      // Simulate event on channel #2 → resets backoff
      await getRecordHandler()(createTestRecordEvent(100))

      // Channel #2 fails
      if (!channel2Reject) throw new Error('reject not captured')
      channel2Reject(new Error('late failure'))
      await vi.advanceTimersByTimeAsync(0)

      // Backoff should be 1s (reset), not 2s
      const before = channelInstances.length
      await vi.advanceTimersByTimeAsync(999)
      expect(channelInstances).toHaveLength(before)
      await vi.advanceTimersByTimeAsync(1)
      expect(channelInstances).toHaveLength(before + 1)

      await service.stop()
    })

    it('reads latest cursor on reconnection', async () => {
      vi.useFakeTimers()

      mockTapChannelCtor
        .mockImplementationOnce(failingChannelImpl)
        .mockImplementationOnce(defaultChannelImpl)

      const service = new FirehoseService(db as never, logger as never, env)
      await service.start()

      expect(channelInstances[0].url).not.toContain('cursor')

      // Make getCursor return a value for the reconnection attempt
      db.select.mockReturnValue({
        from: vi.fn().mockReturnValue(mockQueryChain([{ cursor: 99n }])),
      })

      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(1000)

      expect(channelInstances).toHaveLength(2)
      expect(channelInstances[1].url).toContain('cursor=99')

      await service.stop()
    })

    it('caps backoff at 60 seconds', async () => {
      vi.useFakeTimers()
      mockTapChannelCtor.mockImplementation(failingChannelImpl)

      const service = new FirehoseService(db as never, logger as never, env)
      await service.start()

      // Backoff sequence: 1s, 2s, 4s, 8s, 16s, 32s, 60s (capped)
      const backoffs = [1000, 2000, 4000, 8000, 16000, 32000, 60000]
      for (const ms of backoffs) {
        await vi.advanceTimersByTimeAsync(0)
        const before = channelInstances.length
        await vi.advanceTimersByTimeAsync(ms)
        expect(channelInstances.length).toBe(before + 1)
      }

      // Next backoff should still be 60s (capped)
      await vi.advanceTimersByTimeAsync(0)
      const before = channelInstances.length
      await vi.advanceTimersByTimeAsync(60000)
      expect(channelInstances.length).toBe(before + 1)

      await service.stop()
    })

    it('does not reconnect after stop', async () => {
      vi.useFakeTimers()
      mockTapChannelCtor.mockImplementationOnce(failingChannelImpl)

      const service = new FirehoseService(db as never, logger as never, env)
      await service.start()

      // Let rejection schedule reconnect timer
      await vi.advanceTimersByTimeAsync(0)

      await service.stop()

      // Advance far past any backoff
      await vi.advanceTimersByTimeAsync(120000)

      expect(channelInstances).toHaveLength(1)
    })

    it('does not reconnect when channel closes during shutdown', async () => {
      vi.useFakeTimers()

      // Channel start resolves immediately (clean close)
      mockTapChannelCtor.mockImplementationOnce(function (
        this: Record<string, unknown>,
        url: string,
        handler: unknown,
        opts: unknown
      ) {
        this.url = url
        this.handler = handler
        this.opts = opts
        this.start = vi.fn().mockResolvedValue(undefined)
        this.destroy = vi.fn().mockResolvedValue(undefined)
        channelInstances.push(this as (typeof channelInstances)[number])
      })

      const service = new FirehoseService(db as never, logger as never, env)
      await service.start()
      await service.stop()

      // Let resolved promise propagate
      await vi.advanceTimersByTimeAsync(0)

      // Should not reconnect
      await vi.advanceTimersByTimeAsync(120000)
      expect(channelInstances).toHaveLength(1)
    })

    it('logs reconnection attempts with attempt count and backoff', async () => {
      vi.useFakeTimers()

      mockTapChannelCtor
        .mockImplementationOnce(failingChannelImpl)
        .mockImplementationOnce(defaultChannelImpl)

      const service = new FirehoseService(db as never, logger as never, env)
      await service.start()

      await vi.advanceTimersByTimeAsync(0)

      const schedulingLog = logger.info.mock.calls.find(
        (call: unknown[]) =>
          typeof call[1] === 'string' && (call[1]).includes('Scheduling')
      )
      expect(schedulingLog).toBeDefined()
      if (!schedulingLog) throw new Error('scheduling log not found')
      expect(schedulingLog[0]).toEqual(expect.objectContaining({ attempt: 1, backoffMs: 1000 }))

      await vi.advanceTimersByTimeAsync(1000)

      const attemptLog = logger.info.mock.calls.find(
        (call: unknown[]) =>
          typeof call[1] === 'string' && (call[1]).includes('Attempting')
      )
      expect(attemptLog).toBeDefined()
      if (!attemptLog) throw new Error('attempt log not found')
      expect(attemptLog[0]).toEqual(expect.objectContaining({ attempt: 1 }))

      await service.stop()
    })
  })

  describe('error handling', () => {
    it('does not throw when start fails', async () => {
      db.select.mockReturnValue({
        from: vi.fn().mockRejectedValue(new Error('DB down')),
      })

      const service = new FirehoseService(db as never, logger as never, env)
      await expect(service.start()).resolves.toBeUndefined()
      expect(logger.error).toHaveBeenCalled()
    })
  })
})
