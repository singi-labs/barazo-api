import { Tap, SimpleIndexer, TapChannel } from '@atproto/tap'
import type { RecordEvent as TapRecordEvent, IdentityEvent as TapIdentityEvent } from '@atproto/tap'
import type { Database } from '../db/index.js'
import type { Logger } from '../lib/logger.js'
import type { Env } from '../config/env.js'
import { CursorStore } from './cursor.js'
import { RepoManager } from './repo-manager.js'
import { TopicIndexer } from './indexers/topic.js'
import { ReplyIndexer } from './indexers/reply.js'
import { ReactionIndexer } from './indexers/reaction.js'
import { VoteIndexer } from './indexers/vote.js'
import { RecordHandler } from './handlers/record.js'
import { IdentityHandler } from './handlers/identity.js'
import { createAccountAgeService } from '../services/account-age.js'
import type { RecordEvent, IdentityEvent } from './types.js'

interface FirehoseStatus {
  connected: boolean
  lastEventId: number | null
}

const MIN_BACKOFF_MS = 1000
const MAX_BACKOFF_MS = 60_000

export class FirehoseService {
  private tap: Tap
  private channel: TapChannel | null = null
  private cursorStore: CursorStore
  private repoManager: RepoManager
  private recordHandler: RecordHandler
  private identityHandler: IdentityHandler
  private indexer: SimpleIndexer | null = null
  private connected = false
  private lastEventId: number | null = null
  private shuttingDown = false
  private reconnectAttempts = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null

  constructor(
    db: Database,
    private logger: Logger,
    private env: Env
  ) {
    this.tap = new Tap(env.TAP_URL, {
      adminPassword: env.TAP_ADMIN_PASSWORD,
    })

    this.cursorStore = new CursorStore(db)
    this.repoManager = new RepoManager(db, this.tap, logger)

    const topicIndexer = new TopicIndexer(db, logger)
    const replyIndexer = new ReplyIndexer(db, logger)
    const reactionIndexer = new ReactionIndexer(db, logger)
    const voteIndexer = new VoteIndexer(db, logger)
    const accountAgeService = createAccountAgeService(logger)

    this.recordHandler = new RecordHandler(
      { topic: topicIndexer, reply: replyIndexer, reaction: reactionIndexer, vote: voteIndexer },
      db,
      logger,
      accountAgeService
    )

    this.identityHandler = new IdentityHandler(db, logger)
  }

  async start(): Promise<void> {
    try {
      this.shuttingDown = false
      await this.repoManager.restoreTrackedRepos()

      this.indexer = new SimpleIndexer()

      this.indexer.record(async (evt: TapRecordEvent) => {
        const event: RecordEvent = {
          id: evt.id,
          action: evt.action,
          did: evt.did,
          rev: evt.rev,
          collection: evt.collection,
          rkey: evt.rkey,
          ...(evt.record !== undefined ? { record: evt.record as Record<string, unknown> } : {}),
          ...(evt.cid !== undefined ? { cid: evt.cid } : {}),
          live: evt.live,
        }

        await this.recordHandler.handle(event)
        this.onEventProcessed(evt.id)
      })

      this.indexer.identity(async (evt: TapIdentityEvent) => {
        const event: IdentityEvent = {
          id: evt.id,
          did: evt.did,
          handle: evt.handle,
          isActive: evt.isActive,
          status: evt.status,
        }

        await this.identityHandler.handle(event)
        this.onEventProcessed(evt.id)
      })

      this.indexer.error((err: Error) => {
        this.logger.error({ err }, 'Firehose indexer error')
      })

      const cursor = await this.cursorStore.getCursor()
      this.startChannel(cursor)

      this.logger.info(
        { cursor: cursor !== null ? cursor.toString() : null },
        'Firehose subscription started'
      )
    } catch (err) {
      this.logger.error({ err }, 'Failed to start firehose service')
      this.connected = false
    }
  }

  async stop(): Promise<void> {
    this.shuttingDown = true

    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }

    if (this.channel) {
      await this.channel.destroy()
      this.channel = null
    }

    await this.cursorStore.flush()
    this.connected = false
    this.logger.info('Firehose subscription stopped')
  }

  getStatus(): FirehoseStatus {
    return {
      connected: this.connected,
      lastEventId: this.lastEventId,
    }
  }

  getRepoManager(): RepoManager {
    return this.repoManager
  }

  private onEventProcessed(id: number): void {
    if (!this.connected) {
      this.connected = true
      this.logger.info('Firehose connection confirmed')
    }
    this.reconnectAttempts = 0
    this.lastEventId = id
    this.cursorStore.saveCursor(BigInt(id))
  }

  private startChannel(cursor: bigint | null): void {
    if (this.shuttingDown || !this.indexer) {
      return
    }

    this.channel = this.createChannel(cursor)

    this.channel
      .start()
      .then(() => {
        this.connected = false
        if (!this.shuttingDown) {
          this.logger.warn('Firehose channel closed, scheduling reconnection')
          this.scheduleReconnect()
        }
      })
      .catch((err: unknown) => {
        this.connected = false
        if (!this.shuttingDown) {
          this.logger.error({ err }, 'Firehose channel error, scheduling reconnection')
          this.scheduleReconnect()
        }
      })
  }

  private createChannel(cursor: bigint | null): TapChannel {
    if (!this.indexer) {
      throw new Error('Cannot create channel: indexer not initialized')
    }

    const url = new URL(this.env.TAP_URL)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    url.pathname = '/channel'
    if (cursor !== null) {
      url.searchParams.set('cursor', cursor.toString())
    }

    return new TapChannel(url.toString(), this.indexer, {
      adminPassword: this.env.TAP_ADMIN_PASSWORD,
    })
  }

  private scheduleReconnect(): void {
    if (this.shuttingDown) {
      return
    }

    this.reconnectAttempts++
    const backoffMs = Math.min(
      MIN_BACKOFF_MS * Math.pow(2, this.reconnectAttempts - 1),
      MAX_BACKOFF_MS
    )

    this.logger.info(
      { attempt: this.reconnectAttempts, backoffMs },
      'Scheduling firehose reconnection'
    )

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      void this.attemptReconnect()
    }, backoffMs)
  }

  private async attemptReconnect(): Promise<void> {
    if (this.shuttingDown) {
      return
    }

    try {
      const cursor = await this.cursorStore.getCursor()

      this.logger.info(
        { attempt: this.reconnectAttempts, cursor: cursor?.toString() ?? null },
        'Attempting firehose reconnection'
      )

      this.startChannel(cursor)
    } catch (err) {
      this.logger.error({ err, attempt: this.reconnectAttempts }, 'Firehose reconnection failed')
      this.scheduleReconnect()
    }
  }
}
