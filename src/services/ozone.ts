import { eq, and, inArray } from 'drizzle-orm'
import type { Database } from '../db/index.js'
import type { Cache } from '../cache/index.js'
import type { Logger } from '../lib/logger.js'
import { ozoneLabels } from '../db/schema/ozone-labels.js'

const CACHE_TTL = 3600 // 1 hour
const CACHE_PREFIX = 'ozone:labels:'
const INITIAL_RECONNECT_MS = 1000
const MAX_RECONNECT_MS = 60000
const SPAM_LABELS = new Set(['spam', '!hide'])

interface LabelEvent {
  seq: number
  labels: Label[]
}

interface Label {
  src: string
  uri: string
  val: string
  neg?: boolean
  cts: string
  exp?: string
}

interface CachedLabel {
  val: string
  src: string
  neg: boolean
}

export class OzoneService {
  private ws: WebSocket | null = null
  private reconnectMs = INITIAL_RECONNECT_MS
  private stopping = false

  constructor(
    private db: Database,
    private cache: Cache,
    private logger: Logger,
    private labelerUrl: string
  ) {}

  start(): void {
    this.stopping = false
    this.connect()
  }

  stop(): void {
    this.stopping = true
    if (this.ws) {
      this.ws.close()
      this.ws = null
    }
  }

  private connect(): void {
    if (this.stopping) return

    const wsUrl = this.labelerUrl.replace(/^https?:/, 'wss:').replace(/\/$/, '')
    const url = `${wsUrl}/xrpc/com.atproto.label.subscribeLabels`

    this.logger.info({ url }, 'Connecting to Ozone labeler')

    try {
      this.ws = new WebSocket(url)
    } catch (err) {
      this.logger.warn({ err }, 'Failed to create Ozone WebSocket')
      this.scheduleReconnect()
      return
    }

    this.ws.addEventListener('open', () => {
      this.logger.info('Connected to Ozone labeler')
      this.reconnectMs = INITIAL_RECONNECT_MS
    })

    this.ws.addEventListener('message', (event) => {
      void this.handleMessage(event.data)
    })

    this.ws.addEventListener('close', () => {
      this.logger.info('Ozone labeler connection closed')
      this.scheduleReconnect()
    })

    this.ws.addEventListener('error', (event) => {
      this.logger.warn({ event }, 'Ozone labeler WebSocket error')
    })
  }

  private scheduleReconnect(): void {
    if (this.stopping) return

    this.logger.info({ reconnectMs: this.reconnectMs }, 'Scheduling Ozone labeler reconnect')

    setTimeout(() => {
      this.connect()
    }, this.reconnectMs)

    this.reconnectMs = Math.min(this.reconnectMs * 2, MAX_RECONNECT_MS)
  }

  private async handleMessage(data: unknown): Promise<void> {
    try {
      const text =
        data instanceof Blob ? await data.text() : typeof data === 'string' ? data : String(data)
      const event = JSON.parse(text) as LabelEvent

      if (!Array.isArray(event.labels)) return

      for (const label of event.labels) {
        await this.processLabel(label)
      }
    } catch (err) {
      this.logger.warn({ err }, 'Failed to process Ozone label event')
    }
  }

  private async processLabel(label: Label): Promise<void> {
    if (label.neg) {
      // Negation: remove the prior label
      await this.db
        .delete(ozoneLabels)
        .where(
          and(
            eq(ozoneLabels.src, label.src),
            eq(ozoneLabels.uri, label.uri),
            eq(ozoneLabels.val, label.val)
          )
        )
    } else {
      // Upsert the label
      await this.db
        .insert(ozoneLabels)
        .values({
          src: label.src,
          uri: label.uri,
          val: label.val,
          neg: false,
          cts: new Date(label.cts),
          exp: label.exp ? new Date(label.exp) : undefined,
        })
        .onConflictDoUpdate({
          target: [ozoneLabels.src, ozoneLabels.uri, ozoneLabels.val],
          set: {
            neg: false,
            cts: new Date(label.cts),
            exp: label.exp ? new Date(label.exp) : undefined,
            indexedAt: new Date(),
          },
        })
    }

    // Invalidate cache for this URI
    try {
      await this.cache.del(`${CACHE_PREFIX}${label.uri}`)
    } catch {
      // Non-critical
    }
  }

  /**
   * Get all active labels for a URI (DID or content URI).
   * Results are cached in Valkey for 1 hour.
   */
  async getLabels(uri: string): Promise<CachedLabel[]> {
    const cacheKey = `${CACHE_PREFIX}${uri}`

    // Try cache first
    try {
      const cached = await this.cache.get(cacheKey)
      if (cached) {
        return JSON.parse(cached) as CachedLabel[]
      }
    } catch {
      // Fall through to DB
    }

    const rows = await this.db
      .select({
        val: ozoneLabels.val,
        src: ozoneLabels.src,
        neg: ozoneLabels.neg,
      })
      .from(ozoneLabels)
      .where(and(eq(ozoneLabels.uri, uri), eq(ozoneLabels.neg, false)))

    const labels: CachedLabel[] = rows.map((r) => ({
      val: r.val,
      src: r.src,
      neg: r.neg,
    }))

    // Cache result
    try {
      await this.cache.set(cacheKey, JSON.stringify(labels), 'EX', CACHE_TTL)
    } catch {
      // Non-critical
    }

    return labels
  }

  /**
   * Check if a URI has a specific label value.
   */
  async hasLabel(uri: string, val: string): Promise<boolean> {
    const labels = await this.getLabels(uri)
    return labels.some((l) => l.val === val)
  }

  /**
   * Check if a DID or URI has any spam-related labels (spam, !hide).
   */
  async isSpamLabeled(didOrUri: string): Promise<boolean> {
    const labels = await this.getLabels(didOrUri)
    return labels.some((l) => SPAM_LABELS.has(l.val))
  }

  /**
   * Batch check which DIDs have spam-related labels.
   * Uses a single DB query for all cache misses instead of N+1 individual queries.
   */
  async batchIsSpamLabeled(dids: string[]): Promise<Map<string, boolean>> {
    const result = new Map<string, boolean>()
    if (dids.length === 0) return result

    const uncached: string[] = []

    // Check cache first
    for (const did of dids) {
      const cacheKey = `${CACHE_PREFIX}${did}`
      try {
        const cached = await this.cache.get(cacheKey)
        if (cached) {
          const labels = JSON.parse(cached) as CachedLabel[]
          result.set(
            did,
            labels.some((l) => SPAM_LABELS.has(l.val))
          )
          continue
        }
      } catch {
        // Fall through to DB
      }
      uncached.push(did)
    }

    if (uncached.length === 0) return result

    // Batch DB query for all uncached DIDs
    const rows = await this.db
      .select({
        uri: ozoneLabels.uri,
        val: ozoneLabels.val,
        src: ozoneLabels.src,
        neg: ozoneLabels.neg,
      })
      .from(ozoneLabels)
      .where(and(inArray(ozoneLabels.uri, uncached), eq(ozoneLabels.neg, false)))

    // Group by URI
    const labelsByUri = new Map<string, CachedLabel[]>()
    for (const row of rows) {
      const labels = labelsByUri.get(row.uri) ?? []
      labels.push({ val: row.val, src: row.src, neg: row.neg })
      labelsByUri.set(row.uri, labels)
    }

    // Cache and build results
    for (const did of uncached) {
      const labels = labelsByUri.get(did) ?? []
      result.set(
        did,
        labels.some((l) => SPAM_LABELS.has(l.val))
      )
      try {
        await this.cache.set(`${CACHE_PREFIX}${did}`, JSON.stringify(labels), 'EX', CACHE_TTL)
      } catch {
        // Non-critical
      }
    }

    return result
  }
}
