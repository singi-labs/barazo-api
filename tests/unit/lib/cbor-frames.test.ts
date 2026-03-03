import { describe, it, expect } from 'vitest'
import * as dagCbor from '@ipld/dag-cbor'
import { decodeEventStreamFrame } from '../../../src/lib/cbor-frames.js'

// ---------------------------------------------------------------------------
// Helper: encode a CBOR frame (header || body) as the AT Protocol does
// ---------------------------------------------------------------------------

function encodeFrame(header: Record<string, unknown>, body: Record<string, unknown>): Uint8Array {
  const headerBytes = dagCbor.encode(header)
  const bodyBytes = dagCbor.encode(body)
  const frame = new Uint8Array(headerBytes.length + bodyBytes.length)
  frame.set(headerBytes, 0)
  frame.set(bodyBytes, headerBytes.length)
  return frame
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('decodeEventStreamFrame', () => {
  it('decodes a valid #labels frame into header and body', () => {
    const header = { op: 1, t: '#labels' }
    const body = {
      seq: 42,
      labels: [
        {
          src: 'did:plc:labeler1',
          uri: 'did:plc:user1',
          val: 'spam',
          neg: false,
          cts: '2026-01-15T12:00:00.000Z',
        },
      ],
    }
    const frame = encodeFrame(header, body)

    const result = decodeEventStreamFrame(frame)

    expect(result.header).toEqual(header)
    expect(result.body).toEqual(body)
  })

  it('decodes a frame with an error header (op: -1)', () => {
    const header = { op: -1 }
    const body = { error: 'ConsumerTooSlow', message: 'Consumer is too slow' }
    const frame = encodeFrame(header, body)

    const result = decodeEventStreamFrame(frame)

    expect(result.header).toEqual(header)
    expect(result.body).toEqual(body)
  })

  it('decodes a frame with a different message type', () => {
    const header = { op: 1, t: '#info' }
    const body = { name: 'OutdatedCursor' }
    const frame = encodeFrame(header, body)

    const result = decodeEventStreamFrame(frame)

    expect(result.header).toEqual(header)
    expect(result.body).toEqual(body)
  })

  it('preserves all label fields including optional exp', () => {
    const header = { op: 1, t: '#labels' }
    const body = {
      seq: 1,
      labels: [
        {
          src: 'did:plc:labeler1',
          uri: 'did:plc:user1',
          val: 'spam',
          neg: false,
          cts: '2026-01-15T12:00:00.000Z',
          exp: '2026-02-15T12:00:00.000Z',
        },
      ],
    }
    const frame = encodeFrame(header, body)

    const result = decodeEventStreamFrame(frame)

    expect(result.body).toEqual(body)
  })

  it('handles body with multiple labels', () => {
    const header = { op: 1, t: '#labels' }
    const body = {
      seq: 5,
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
          cts: '2026-01-15T13:00:00.000Z',
        },
      ],
    }
    const frame = encodeFrame(header, body)

    const result = decodeEventStreamFrame(frame)

    expect(result.body).toEqual(body)
    const labels = result.body.labels as unknown[]
    expect(labels).toHaveLength(2)
  })

  it('throws on empty buffer', () => {
    expect(() => decodeEventStreamFrame(new Uint8Array(0))).toThrow()
  })

  it('throws on truncated data (header only, no body)', () => {
    const headerBytes = dagCbor.encode({ op: 1, t: '#labels' })
    expect(() => decodeEventStreamFrame(headerBytes)).toThrow()
  })

  it('throws on invalid CBOR data', () => {
    const garbage = new Uint8Array([0xff, 0xfe, 0xfd, 0xfc])
    expect(() => decodeEventStreamFrame(garbage)).toThrow()
  })

  it('accepts ArrayBuffer input', () => {
    const header = { op: 1, t: '#labels' }
    const body = { seq: 1, labels: [] }
    const frame = encodeFrame(header, body)

    const result = decodeEventStreamFrame(frame.buffer as ArrayBuffer)

    expect(result.header).toEqual(header)
    expect(result.body).toEqual(body)
  })

  it('accepts Buffer input', () => {
    const header = { op: 1, t: '#labels' }
    const body = { seq: 1, labels: [] }
    const frame = encodeFrame(header, body)

    const result = decodeEventStreamFrame(Buffer.from(frame))

    expect(result.header).toEqual(header)
    expect(result.body).toEqual(body)
  })
})
