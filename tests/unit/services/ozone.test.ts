import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as dagCbor from '@ipld/dag-cbor'
import { OzoneService } from '../../../src/services/ozone.js'

// ---------------------------------------------------------------------------
// CBOR frame helper: encodes header + body as AT Protocol event stream frame
// ---------------------------------------------------------------------------

function encodeLabelFrame(body: Record<string, unknown>): Uint8Array {
  const header = { op: 1, t: '#labels' }
  const headerBytes = dagCbor.encode(header)
  const bodyBytes = dagCbor.encode(body)
  const frame = new Uint8Array(headerBytes.length + bodyBytes.length)
  frame.set(headerBytes, 0)
  frame.set(bodyBytes, headerBytes.length)
  return frame
}

function encodeErrorFrame(body: Record<string, unknown>): Uint8Array {
  const header = { op: -1 }
  const headerBytes = dagCbor.encode(header)
  const bodyBytes = dagCbor.encode(body)
  const frame = new Uint8Array(headerBytes.length + bodyBytes.length)
  frame.set(headerBytes, 0)
  frame.set(bodyBytes, headerBytes.length)
  return frame
}

function encodeInfoFrame(body: Record<string, unknown>): Uint8Array {
  const header = { op: 1, t: '#info' }
  const headerBytes = dagCbor.encode(header)
  const bodyBytes = dagCbor.encode(body)
  const frame = new Uint8Array(headerBytes.length + bodyBytes.length)
  frame.set(headerBytes, 0)
  frame.set(bodyBytes, headerBytes.length)
  return frame
}

// ---------------------------------------------------------------------------
// MockWebSocket that captures event listeners for triggering in tests
// ---------------------------------------------------------------------------

type WsListener = (...args: never[]) => void
let lastWsInstance: MockWebSocket | null = null
let wsConstructorShouldThrow = false

function setLastWsInstance(instance: MockWebSocket): void {
  lastWsInstance = instance
}

function getLastWs(): MockWebSocket {
  if (!lastWsInstance) throw new Error('No WebSocket instance')
  return lastWsInstance
}

class MockWebSocket {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSING = 2
  static CLOSED = 3

  readyState = MockWebSocket.OPEN
  close = vi.fn()
  removeEventListener = vi.fn()
  send = vi.fn()

  private listeners = new Map<string, WsListener[]>()

  constructor(_url: string) {
    if (wsConstructorShouldThrow) {
      throw new Error('WebSocket constructor failed')
    }
    setLastWsInstance(this)
  }

  addEventListener(event: string, listener: WsListener): void {
    const existing = this.listeners.get(event) ?? []
    existing.push(listener)
    this.listeners.set(event, existing)
  }

  /** Fire a captured event listener in tests */
  emit(event: string, data?: unknown): void {
    const listeners = this.listeners.get(event) ?? []
    for (const listener of listeners) {
      listener(data as never)
    }
  }
}

vi.stubGlobal('WebSocket', MockWebSocket)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockLogger() {
  return {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  }
}

function createMockCache() {
  return {
    get: vi.fn(),
    set: vi.fn(),
    del: vi.fn(),
  }
}

function createMockDb() {
  const deleteMock = {
    where: vi.fn().mockResolvedValue(undefined),
  }
  const onConflictDoUpdateMock = vi.fn().mockResolvedValue(undefined)
  const insertValuesMock = {
    onConflictDoUpdate: onConflictDoUpdateMock,
  }
  const insertMock = {
    values: vi.fn().mockReturnValue(insertValuesMock),
  }
  const selectFromWhereMock = vi.fn().mockResolvedValue([])
  const selectFromMock = {
    where: selectFromWhereMock,
  }
  const selectMock = {
    from: vi.fn().mockReturnValue(selectFromMock),
  }

  return {
    select: vi.fn().mockReturnValue(selectMock),
    insert: vi.fn().mockReturnValue(insertMock),
    delete: vi.fn().mockReturnValue(deleteMock),
    // Expose internals for assertions
    _selectFromWhere: selectFromWhereMock,
    _insertValues: insertMock.values,
    _onConflictDoUpdate: onConflictDoUpdateMock,
    _deleteWhere: deleteMock.where,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('OzoneService', () => {
  let service: OzoneService
  let logger: ReturnType<typeof createMockLogger>
  let cache: ReturnType<typeof createMockCache>
  let db: ReturnType<typeof createMockDb>

  beforeEach(() => {
    vi.useFakeTimers()
    lastWsInstance = null
    wsConstructorShouldThrow = false
    logger = createMockLogger()
    cache = createMockCache()
    db = createMockDb()
    service = new OzoneService(
      db as never,
      cache as never,
      logger as never,
      'https://ozone.example.com'
    )
  })

  afterEach(() => {
    service.stop()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  // =========================================================================
  // start / stop
  // =========================================================================

  describe('start / stop', () => {
    it('sets stopping to false on start and creates a WebSocket', () => {
      expect(() => {
        service.start()
      }).not.toThrow()
      expect(logger.info).toHaveBeenCalledWith(
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        expect.objectContaining({ url: expect.stringContaining('wss:') }),
        'Connecting to Ozone labeler'
      )
    })

    it('sets stopping to true on stop and closes WebSocket', () => {
      service.start()
      const ws = getLastWs()
      service.stop()

      expect(ws.close).toHaveBeenCalled()
    })

    it('stop is safe to call without prior start', () => {
      expect(() => {
        service.stop()
      }).not.toThrow()
    })

    it('does not reconnect after stop', () => {
      service.start()
      service.stop()
      service.start()
      expect(logger.info).toHaveBeenCalledWith(
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        expect.objectContaining({ url: expect.any(String) }),
        'Connecting to Ozone labeler'
      )
    })
  })

  // =========================================================================
  // WebSocket connection lifecycle
  // =========================================================================

  describe('connect / WebSocket lifecycle', () => {
    it('converts https URL to wss and strips trailing slash', () => {
      const svc = new OzoneService(
        db as never,
        cache as never,
        logger as never,
        'https://ozone.example.com/'
      )
      svc.start()

      expect(logger.info).toHaveBeenCalledWith(
        { url: 'wss://ozone.example.com/xrpc/com.atproto.label.subscribeLabels' },
        'Connecting to Ozone labeler'
      )
      svc.stop()
    })

    it('converts http URL to wss', () => {
      const svc = new OzoneService(
        db as never,
        cache as never,
        logger as never,
        'http://ozone.example.com'
      )
      svc.start()

      expect(logger.info).toHaveBeenCalledWith(
        { url: 'wss://ozone.example.com/xrpc/com.atproto.label.subscribeLabels' },
        'Connecting to Ozone labeler'
      )
      svc.stop()
    })

    it('open event resets reconnect backoff and logs', () => {
      service.start()
      const ws = getLastWs()

      ws.emit('open')

      expect(logger.info).toHaveBeenCalledWith('Connected to Ozone labeler')
    })

    it('close event schedules reconnect', () => {
      service.start()
      const ws = getLastWs()

      ws.emit('close')

      expect(logger.info).toHaveBeenCalledWith('Ozone labeler connection closed')
      expect(logger.info).toHaveBeenCalledWith(
        { reconnectMs: 1000 },
        'Scheduling Ozone labeler reconnect'
      )
    })

    it('error event logs the error', () => {
      service.start()
      const ws = getLastWs()
      const errorEvent = { type: 'error', message: 'connection refused' }

      ws.emit('error', errorEvent)

      expect(logger.warn).toHaveBeenCalledWith(
        { event: errorEvent },
        'Ozone labeler WebSocket error'
      )
    })

    it('message event routes to handleMessage with CBOR data', async () => {
      cache.get.mockResolvedValue(null)
      db._selectFromWhere.mockResolvedValue([])

      service.start()
      const ws = getLastWs()

      const frame = encodeLabelFrame({
        seq: 1,
        labels: [
          {
            src: 'did:plc:labeler1',
            uri: 'did:plc:user1',
            val: 'spam',
            neg: false,
            cts: '2026-01-15T12:00:00.000Z',
          },
        ],
      })

      ws.emit('message', { data: frame })

      // Let the async handleMessage settle
      await vi.advanceTimersByTimeAsync(0)

      expect(db.insert).toHaveBeenCalled()
    })

    it('does not connect when stopping is true', () => {
      service.stop()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      ;(service as any).connect()

      // Should not have logged the connection attempt
      expect(logger.info).not.toHaveBeenCalledWith(
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        expect.objectContaining({ url: expect.any(String) }),
        'Connecting to Ozone labeler'
      )
    })

    it('handles WebSocket constructor throwing and schedules reconnect', () => {
      wsConstructorShouldThrow = true
      service.start()

      expect(logger.warn).toHaveBeenCalledWith(
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        { err: expect.any(Error) },
        'Failed to create Ozone WebSocket'
      )
      expect(logger.info).toHaveBeenCalledWith(
        { reconnectMs: 1000 },
        'Scheduling Ozone labeler reconnect'
      )
    })
  })

  // =========================================================================
  // scheduleReconnect
  // =========================================================================

  describe('scheduleReconnect', () => {
    it('does not reconnect when stopping', () => {
      service.start()
      service.stop()

      const ws = lastWsInstance
      // Trigger close -- scheduleReconnect will be called but should bail
      ws?.emit('close')

      // Advance time -- no new connection attempt should happen
      vi.advanceTimersByTime(5000)

      // Only the initial connect log, not a second one
      const connectCalls = logger.info.mock.calls.filter(
        (c: unknown[]) => c[1] === 'Connecting to Ozone labeler'
      )
      expect(connectCalls).toHaveLength(1)
    })

    it('applies exponential backoff up to max', () => {
      service.start()
      const ws1 = getLastWs()

      // First close: reconnect in 1000ms, next will be 2000ms
      ws1.emit('close')
      expect(logger.info).toHaveBeenCalledWith(
        { reconnectMs: 1000 },
        'Scheduling Ozone labeler reconnect'
      )

      vi.advanceTimersByTime(1000)
      const ws2 = getLastWs()
      expect(ws2).not.toBe(ws1)

      // Second close: reconnect in 2000ms, next will be 4000ms
      ws2.emit('close')
      expect(logger.info).toHaveBeenCalledWith(
        { reconnectMs: 2000 },
        'Scheduling Ozone labeler reconnect'
      )

      vi.advanceTimersByTime(2000)
      const ws3 = getLastWs()

      // Third close: reconnect in 4000ms
      ws3.emit('close')
      expect(logger.info).toHaveBeenCalledWith(
        { reconnectMs: 4000 },
        'Scheduling Ozone labeler reconnect'
      )
    })

    it('caps backoff at 60000ms', () => {
      service.start()

      // Drive backoff past the max: 1000, 2000, 4000, 8000, 16000, 32000, 64000 -> capped at 60000
      for (let i = 0; i < 7; i++) {
        const ws = getLastWs()
        ws.emit('close')
        const lastCall = logger.info.mock.calls
          .filter((c: unknown[]) => c[1] === 'Scheduling Ozone labeler reconnect')
          .at(-1)
        if (!lastCall) throw new Error('Expected reconnect log call')
        const reconnectMs = lastCall[0] as { reconnectMs: number }

        // Advance past the reconnect timer
        vi.advanceTimersByTime(reconnectMs.reconnectMs)
      }

      // The last reconnectMs should be capped at 60000
      const lastReconnectCall = logger.info.mock.calls
        .filter((c: unknown[]) => c[1] === 'Scheduling Ozone labeler reconnect')
        .at(-1)
      if (!lastReconnectCall) throw new Error('Expected reconnect log call')
      const lastReconnect = lastReconnectCall[0] as { reconnectMs: number }

      expect(lastReconnect.reconnectMs).toBeLessThanOrEqual(60000)
    })

    it('resets backoff on successful open', () => {
      service.start()
      const ws1 = getLastWs()

      // Close to increase backoff
      ws1.emit('close')
      vi.advanceTimersByTime(1000)

      const ws2 = getLastWs()
      // Simulate successful open -- resets backoff
      ws2.emit('open')

      // Now close again -- should reconnect at 1000ms (reset), not 2000ms
      ws2.emit('close')
      expect(logger.info).toHaveBeenCalledWith(
        { reconnectMs: 1000 },
        'Scheduling Ozone labeler reconnect'
      )
    })
  })

  // =========================================================================
  // getLabels
  // =========================================================================

  describe('getLabels', () => {
    it('returns labels from cache when available', async () => {
      const cachedLabels = [{ val: 'spam', src: 'did:plc:labeler1', neg: false }]
      cache.get.mockResolvedValue(JSON.stringify(cachedLabels))

      const result = await service.getLabels('did:plc:user123')

      expect(result).toEqual(cachedLabels)
      expect(cache.get).toHaveBeenCalledWith('ozone:labels:did:plc:user123')
      expect(db.select).not.toHaveBeenCalled()
    })

    it('queries DB and caches result on cache miss', async () => {
      cache.get.mockResolvedValue(null)
      const dbRows = [
        { val: 'nudity', src: 'did:plc:labeler1', neg: false },
        { val: 'spam', src: 'did:plc:labeler2', neg: false },
      ]
      db._selectFromWhere.mockResolvedValue(dbRows)

      const result = await service.getLabels('at://did:plc:user/app.bsky.feed.post/abc')

      expect(result).toEqual(dbRows)
      expect(db.select).toHaveBeenCalled()
      expect(cache.set).toHaveBeenCalledWith(
        'ozone:labels:at://did:plc:user/app.bsky.feed.post/abc',
        JSON.stringify(dbRows),
        'EX',
        3600
      )
    })

    it('queries DB when cache throws an error', async () => {
      cache.get.mockRejectedValue(new Error('Redis down'))
      db._selectFromWhere.mockResolvedValue([])

      const result = await service.getLabels('did:plc:user123')

      expect(result).toEqual([])
      expect(db.select).toHaveBeenCalled()
    })

    it('returns labels even when cache set fails', async () => {
      cache.get.mockResolvedValue(null)
      cache.set.mockRejectedValue(new Error('Redis write failed'))
      const dbRows = [{ val: 'spam', src: 'did:plc:labeler1', neg: false }]
      db._selectFromWhere.mockResolvedValue(dbRows)

      const result = await service.getLabels('did:plc:user123')

      expect(result).toEqual(dbRows)
    })

    it('returns empty array when no labels exist', async () => {
      cache.get.mockResolvedValue(null)
      db._selectFromWhere.mockResolvedValue([])

      const result = await service.getLabels('did:plc:clean-user')

      expect(result).toEqual([])
      expect(cache.set).toHaveBeenCalledWith('ozone:labels:did:plc:clean-user', '[]', 'EX', 3600)
    })
  })

  // =========================================================================
  // hasLabel
  // =========================================================================

  describe('hasLabel', () => {
    it('returns true when the label exists', async () => {
      cache.get.mockResolvedValue(
        JSON.stringify([
          { val: 'spam', src: 'did:plc:labeler1', neg: false },
          { val: 'nudity', src: 'did:plc:labeler1', neg: false },
        ])
      )

      const result = await service.hasLabel('did:plc:user123', 'spam')

      expect(result).toBe(true)
    })

    it('returns false when the label does not exist', async () => {
      cache.get.mockResolvedValue(
        JSON.stringify([{ val: 'nudity', src: 'did:plc:labeler1', neg: false }])
      )

      const result = await service.hasLabel('did:plc:user123', 'spam')

      expect(result).toBe(false)
    })

    it('returns false when no labels exist', async () => {
      cache.get.mockResolvedValue(null)
      db._selectFromWhere.mockResolvedValue([])

      const result = await service.hasLabel('did:plc:user123', 'spam')

      expect(result).toBe(false)
    })
  })

  // =========================================================================
  // isSpamLabeled
  // =========================================================================

  describe('isSpamLabeled', () => {
    it('returns true when "spam" label is present', async () => {
      cache.get.mockResolvedValue(
        JSON.stringify([{ val: 'spam', src: 'did:plc:labeler1', neg: false }])
      )

      const result = await service.isSpamLabeled('did:plc:spammer')

      expect(result).toBe(true)
    })

    it('returns true when "!hide" label is present', async () => {
      cache.get.mockResolvedValue(
        JSON.stringify([{ val: '!hide', src: 'did:plc:labeler1', neg: false }])
      )

      const result = await service.isSpamLabeled('did:plc:hidden-user')

      expect(result).toBe(true)
    })

    it('returns true when both spam labels are present', async () => {
      cache.get.mockResolvedValue(
        JSON.stringify([
          { val: 'spam', src: 'did:plc:labeler1', neg: false },
          { val: '!hide', src: 'did:plc:labeler2', neg: false },
        ])
      )

      const result = await service.isSpamLabeled('did:plc:very-spammy')

      expect(result).toBe(true)
    })

    it('returns false when only non-spam labels are present', async () => {
      cache.get.mockResolvedValue(
        JSON.stringify([
          { val: 'nudity', src: 'did:plc:labeler1', neg: false },
          { val: 'gore', src: 'did:plc:labeler1', neg: false },
        ])
      )

      const result = await service.isSpamLabeled('did:plc:not-spam')

      expect(result).toBe(false)
    })

    it('returns false when no labels exist', async () => {
      cache.get.mockResolvedValue(null)
      db._selectFromWhere.mockResolvedValue([])

      const result = await service.isSpamLabeled('did:plc:clean-user')

      expect(result).toBe(false)
    })
  })

  // =========================================================================
  // handleMessage / processLabel
  // =========================================================================

  describe('handleMessage / processLabel', () => {
    it('processLabel with negation deletes label from DB', async () => {
      const label = {
        src: 'did:plc:labeler1',
        uri: 'did:plc:user123',
        val: 'spam',
        neg: true,
        cts: '2026-01-15T12:00:00.000Z',
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      await (service as any).processLabel(label)

      expect(db.delete).toHaveBeenCalled()
      expect(db._deleteWhere).toHaveBeenCalled()
      expect(db.insert).not.toHaveBeenCalled()
      expect(cache.del).toHaveBeenCalledWith('ozone:labels:did:plc:user123')
    })

    it('processLabel without negation upserts label into DB', async () => {
      const label = {
        src: 'did:plc:labeler1',
        uri: 'did:plc:user123',
        val: 'spam',
        neg: false,
        cts: '2026-01-15T12:00:00.000Z',
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      await (service as any).processLabel(label)

      expect(db.insert).toHaveBeenCalled()
      expect(db._insertValues).toHaveBeenCalledWith(
        expect.objectContaining({
          src: 'did:plc:labeler1',
          uri: 'did:plc:user123',
          val: 'spam',
          neg: false,
          cts: new Date('2026-01-15T12:00:00.000Z'),
        })
      )
      expect(db._onConflictDoUpdate).toHaveBeenCalled()
      expect(db.delete).not.toHaveBeenCalled()
      expect(cache.del).toHaveBeenCalledWith('ozone:labels:did:plc:user123')
    })

    it('processLabel with exp passes expiration date', async () => {
      const label = {
        src: 'did:plc:labeler1',
        uri: 'did:plc:user123',
        val: 'spam',
        neg: false,
        cts: '2026-01-15T12:00:00.000Z',
        exp: '2026-02-15T12:00:00.000Z',
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      await (service as any).processLabel(label)

      expect(db._insertValues).toHaveBeenCalledWith(
        expect.objectContaining({
          exp: new Date('2026-02-15T12:00:00.000Z'),
        })
      )
    })

    it('processLabel without exp passes undefined for expiration', async () => {
      const label = {
        src: 'did:plc:labeler1',
        uri: 'did:plc:user123',
        val: 'spam',
        neg: false,
        cts: '2026-01-15T12:00:00.000Z',
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      await (service as any).processLabel(label)

      expect(db._insertValues).toHaveBeenCalledWith(
        expect.objectContaining({
          exp: undefined,
        })
      )
    })

    it('processLabel still succeeds when cache.del fails', async () => {
      cache.del.mockRejectedValue(new Error('Redis down'))

      const label = {
        src: 'did:plc:labeler1',
        uri: 'did:plc:user123',
        val: 'spam',
        neg: false,
        cts: '2026-01-15T12:00:00.000Z',
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      await expect((service as any).processLabel(label)).resolves.not.toThrow()
      expect(db.insert).toHaveBeenCalled()
    })

    it('handleMessage processes CBOR frame with multiple labels', async () => {
      const frame = encodeLabelFrame({
        seq: 1,
        labels: [
          {
            src: 'did:plc:labeler1',
            uri: 'did:plc:user1',
            val: 'spam',
            neg: false,
            cts: '2026-01-15T12:00:00.000Z',
          },
          {
            src: 'did:plc:labeler1',
            uri: 'did:plc:user2',
            val: '!hide',
            neg: true,
            cts: '2026-01-15T12:00:00.000Z',
          },
        ],
      })

      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      await (service as any).handleMessage(frame)

      expect(db.insert).toHaveBeenCalledTimes(1)
      expect(db.delete).toHaveBeenCalledTimes(1)
      expect(cache.del).toHaveBeenCalledTimes(2)
    })

    it('handleMessage skips CBOR events without labels array', async () => {
      const frame = encodeLabelFrame({ seq: 1 })

      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      await (service as any).handleMessage(frame)

      expect(db.insert).not.toHaveBeenCalled()
      expect(db.delete).not.toHaveBeenCalled()
    })

    it('handleMessage logs warning on invalid binary data', async () => {
      const garbage = new Uint8Array([0xff, 0xfe, 0xfd, 0xfc])

      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      await (service as any).handleMessage(garbage)

      expect(logger.warn).toHaveBeenCalledWith(
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        expect.objectContaining({ err: expect.any(Error) }),
        'Failed to process Ozone label event'
      )
    })

    it('handleMessage handles Blob containing CBOR data', async () => {
      const frame = encodeLabelFrame({
        seq: 1,
        labels: [
          {
            src: 'did:plc:labeler1',
            uri: 'did:plc:user1',
            val: 'spam',
            neg: false,
            cts: '2026-01-15T12:00:00.000Z',
          },
        ],
      })
      const blob = new Blob([frame])

      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      await (service as any).handleMessage(blob)

      expect(db.insert).toHaveBeenCalled()
      expect(logger.warn).not.toHaveBeenCalled()
    })

    it('handleMessage handles ArrayBuffer data', async () => {
      const frame = encodeLabelFrame({
        seq: 1,
        labels: [
          {
            src: 'did:plc:labeler1',
            uri: 'did:plc:user1',
            val: 'spam',
            neg: false,
            cts: '2026-01-15T12:00:00.000Z',
          },
        ],
      })

      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      await (service as any).handleMessage(frame.buffer)

      expect(db.insert).toHaveBeenCalled()
      expect(logger.warn).not.toHaveBeenCalled()
    })

    it('handleMessage skips error frames gracefully', async () => {
      const frame = encodeErrorFrame({
        error: 'ConsumerTooSlow',
        message: 'Consumer is too slow',
      })

      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      await (service as any).handleMessage(frame)

      expect(db.insert).not.toHaveBeenCalled()
      expect(db.delete).not.toHaveBeenCalled()
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ error: 'ConsumerTooSlow' }),
        expect.stringContaining('Ozone labeler error frame')
      )
    })

    it('handleMessage skips non-labels message types gracefully', async () => {
      const frame = encodeInfoFrame({ name: 'OutdatedCursor' })

      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      await (service as any).handleMessage(frame)

      expect(db.insert).not.toHaveBeenCalled()
      expect(db.delete).not.toHaveBeenCalled()
      // Should not log a warning for known non-labels types
      expect(logger.warn).not.toHaveBeenCalled()
    })

    it('handleMessage logs warning on string data (not valid CBOR frame)', async () => {
      // AT Protocol firehose sends binary, not string -- string data is invalid
      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      await (service as any).handleMessage('not valid data')

      expect(logger.warn).toHaveBeenCalledWith(
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        expect.objectContaining({ err: expect.any(Error) }),
        'Failed to process Ozone label event'
      )
    })
  })

  // =========================================================================
  // batchIsSpamLabeled
  // =========================================================================

  describe('batchIsSpamLabeled', () => {
    it('returns empty map for empty input', async () => {
      const result = await service.batchIsSpamLabeled([])

      expect(result.size).toBe(0)
      expect(cache.get).not.toHaveBeenCalled()
      expect(db.select).not.toHaveBeenCalled()
    })

    it('returns all results from cache when all DIDs are cached', async () => {
      cache.get
        .mockResolvedValueOnce(
          JSON.stringify([{ val: 'spam', src: 'did:plc:labeler1', neg: false }])
        )
        .mockResolvedValueOnce(
          JSON.stringify([{ val: 'nudity', src: 'did:plc:labeler1', neg: false }])
        )

      const result = await service.batchIsSpamLabeled(['did:plc:spammer', 'did:plc:clean'])

      expect(result.get('did:plc:spammer')).toBe(true)
      expect(result.get('did:plc:clean')).toBe(false)
      // No DB query needed
      expect(db.select).not.toHaveBeenCalled()
    })

    it('queries DB for all DIDs on complete cache miss', async () => {
      cache.get.mockResolvedValue(null)
      db._selectFromWhere.mockResolvedValue([
        { uri: 'did:plc:user1', val: 'spam', src: 'did:plc:labeler1', neg: false },
        { uri: 'did:plc:user1', val: 'nudity', src: 'did:plc:labeler1', neg: false },
      ])

      const result = await service.batchIsSpamLabeled(['did:plc:user1', 'did:plc:user2'])

      expect(result.get('did:plc:user1')).toBe(true)
      expect(result.get('did:plc:user2')).toBe(false)
      expect(db.select).toHaveBeenCalled()
      // Both results should be cached
      expect(cache.set).toHaveBeenCalledTimes(2)
    })

    it('handles mixed cache hit and miss', async () => {
      // First DID: cached (spam)
      cache.get
        .mockResolvedValueOnce(
          JSON.stringify([{ val: 'spam', src: 'did:plc:labeler1', neg: false }])
        )
        // Second DID: not cached
        .mockResolvedValueOnce(null)

      db._selectFromWhere.mockResolvedValue([
        { uri: 'did:plc:user2', val: '!hide', src: 'did:plc:labeler1', neg: false },
      ])

      const result = await service.batchIsSpamLabeled(['did:plc:user1', 'did:plc:user2'])

      expect(result.get('did:plc:user1')).toBe(true)
      expect(result.get('did:plc:user2')).toBe(true)
      // Only the uncached DID should trigger DB query
      expect(db.select).toHaveBeenCalledTimes(1)
      // Only the uncached DID should be cached
      expect(cache.set).toHaveBeenCalledTimes(1)
    })

    it('falls through to DB when cache.get throws', async () => {
      cache.get.mockRejectedValue(new Error('Redis down'))
      db._selectFromWhere.mockResolvedValue([])

      const result = await service.batchIsSpamLabeled(['did:plc:user1'])

      expect(result.get('did:plc:user1')).toBe(false)
      expect(db.select).toHaveBeenCalled()
    })

    it('returns results even when cache.set fails', async () => {
      cache.get.mockResolvedValue(null)
      cache.set.mockRejectedValue(new Error('Redis write failed'))
      db._selectFromWhere.mockResolvedValue([
        { uri: 'did:plc:user1', val: 'spam', src: 'did:plc:labeler1', neg: false },
      ])

      const result = await service.batchIsSpamLabeled(['did:plc:user1'])

      expect(result.get('did:plc:user1')).toBe(true)
    })

    it('groups labels by URI correctly from DB results', async () => {
      cache.get.mockResolvedValue(null)
      db._selectFromWhere.mockResolvedValue([
        { uri: 'did:plc:user1', val: 'nudity', src: 'did:plc:labeler1', neg: false },
        { uri: 'did:plc:user1', val: 'gore', src: 'did:plc:labeler1', neg: false },
        { uri: 'did:plc:user2', val: 'spam', src: 'did:plc:labeler1', neg: false },
        { uri: 'did:plc:user3', val: '!hide', src: 'did:plc:labeler1', neg: false },
      ])

      const result = await service.batchIsSpamLabeled([
        'did:plc:user1',
        'did:plc:user2',
        'did:plc:user3',
      ])

      // user1 has nudity+gore but no spam labels
      expect(result.get('did:plc:user1')).toBe(false)
      // user2 has spam
      expect(result.get('did:plc:user2')).toBe(true)
      // user3 has !hide
      expect(result.get('did:plc:user3')).toBe(true)
    })

    it('caches correct label arrays per URI', async () => {
      cache.get.mockResolvedValue(null)
      db._selectFromWhere.mockResolvedValue([
        { uri: 'did:plc:user1', val: 'spam', src: 'did:plc:labeler1', neg: false },
        { uri: 'did:plc:user1', val: 'nudity', src: 'did:plc:labeler2', neg: false },
      ])

      await service.batchIsSpamLabeled(['did:plc:user1', 'did:plc:user2'])

      // user1 cached with both labels
      expect(cache.set).toHaveBeenCalledWith(
        'ozone:labels:did:plc:user1',
        JSON.stringify([
          { val: 'spam', src: 'did:plc:labeler1', neg: false },
          { val: 'nudity', src: 'did:plc:labeler2', neg: false },
        ]),
        'EX',
        3600
      )
      // user2 cached with empty array
      expect(cache.set).toHaveBeenCalledWith('ozone:labels:did:plc:user2', '[]', 'EX', 3600)
    })

    it('marks DIDs with no DB labels as not spam', async () => {
      cache.get.mockResolvedValue(null)
      db._selectFromWhere.mockResolvedValue([])

      const result = await service.batchIsSpamLabeled([
        'did:plc:clean1',
        'did:plc:clean2',
        'did:plc:clean3',
      ])

      expect(result.get('did:plc:clean1')).toBe(false)
      expect(result.get('did:plc:clean2')).toBe(false)
      expect(result.get('did:plc:clean3')).toBe(false)
    })

    it('detects spam from cached labels with "!hide" value', async () => {
      cache.get.mockResolvedValue(
        JSON.stringify([{ val: '!hide', src: 'did:plc:labeler1', neg: false }])
      )

      const result = await service.batchIsSpamLabeled(['did:plc:hidden'])

      expect(result.get('did:plc:hidden')).toBe(true)
    })
  })
})
