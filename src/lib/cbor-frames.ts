import { decodeFirst } from 'cborg'

/**
 * Header of an AT Protocol XRPC event stream frame.
 *
 * @see https://atproto.com/specs/event-stream
 */
export interface FrameHeader {
  /** Operation type: 1 = regular message, -1 = error */
  op: number
  /** Lexicon sub-type in short form (e.g. '#labels'), present when op = 1 */
  t?: string
}

/**
 * Decoded AT Protocol event stream frame (header + body).
 */
export interface DecodedFrame {
  header: FrameHeader
  body: Record<string, unknown>
}

/**
 * Decode an AT Protocol XRPC event stream binary frame.
 *
 * Each WebSocket frame contains two concatenated CBOR objects:
 * 1. A header with `op` (operation type) and optional `t` (message type)
 * 2. The message body
 *
 * @param data - Raw binary data (Uint8Array, ArrayBuffer, or Buffer)
 * @returns The decoded header and body
 * @throws If the data cannot be decoded as two consecutive CBOR objects
 *
 * @see https://atproto.com/specs/event-stream
 */
export function decodeEventStreamFrame(data: Uint8Array | ArrayBuffer | Buffer): DecodedFrame {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data)

  if (bytes.length === 0) {
    throw new Error('Empty event stream frame')
  }

  const [header, remainder] = decodeFirst(bytes) as [FrameHeader, Uint8Array]

  if (remainder.length === 0) {
    throw new Error('Truncated event stream frame: missing body after header')
  }

  const [body] = decodeFirst(remainder) as [Record<string, unknown>, Uint8Array]

  return { header, body }
}
