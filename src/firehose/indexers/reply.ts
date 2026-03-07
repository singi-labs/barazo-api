import { eq, sql } from 'drizzle-orm'
import type { TopicReplyInput } from '@singi-labs/lexicons'
import { replies } from '../../db/schema/replies.js'
import { topics } from '../../db/schema/topics.js'
import type { Database } from '../../db/index.js'
import type { Logger } from '../../lib/logger.js'
import type { TrustStatus } from '../../services/account-age.js'
import { clampCreatedAt } from '../clamp-timestamp.js'
import { sanitizeHtml } from '../../lib/sanitize.js'

interface CreateParams {
  uri: string
  rkey: string
  did: string
  cid: string
  record: TopicReplyInput
  live: boolean
  trustStatus: TrustStatus
}

interface UpdateParams {
  uri: string
  rkey: string
  did: string
  cid: string
  record: TopicReplyInput
  live: boolean
  trustStatus: TrustStatus
}

interface DeleteParams {
  uri: string
  rkey: string
  did: string
  rootUri: string
}

export class ReplyIndexer {
  constructor(
    private db: Database,
    private logger: Logger
  ) {}

  async handleCreate(params: CreateParams): Promise<void> {
    const { uri, rkey, did, cid, record, live, trustStatus } = params

    const { root, parent } = record
    const clientCreatedAt = new Date(record.createdAt)
    const createdAt = live ? clampCreatedAt(clientCreatedAt) : clientCreatedAt

    await this.db.transaction(async (tx) => {
      // Compute depth: direct reply to topic = 1, nested = parent_depth + 1
      let depth = 1
      if (parent.uri !== root.uri) {
        const parentRows = await tx
          .select({ depth: replies.depth })
          .from(replies)
          .where(eq(replies.uri, parent.uri))
        depth = parentRows[0] ? parentRows[0].depth + 1 : 1
      }

      await tx
        .insert(replies)
        .values({
          uri,
          rkey,
          authorDid: did,
          content: sanitizeHtml(record.content.value),
          contentFormat: 'markdown',
          rootUri: root.uri,
          rootCid: root.cid,
          parentUri: parent.uri,
          parentCid: parent.cid,
          communityDid: record.community,
          cid,
          labels: record.labels ?? null,
          createdAt,
          trustStatus,
          depth,
        })
        .onConflictDoNothing()

      // Increment reply count and update last activity
      await tx
        .update(topics)
        .set({
          replyCount: sql`${topics.replyCount} + 1`,
          lastActivityAt: new Date(),
        })
        .where(eq(topics.uri, root.uri))
    })

    this.logger.debug({ uri, did, trustStatus }, 'Indexed reply')
  }

  async handleUpdate(params: UpdateParams): Promise<void> {
    const { uri, cid, record } = params

    await this.db
      .update(replies)
      .set({
        content: sanitizeHtml(record.content.value),
        contentFormat: 'markdown',
        cid,
        labels: record.labels ?? null,
        indexedAt: new Date(),
      })
      .where(eq(replies.uri, uri))

    this.logger.debug({ uri }, 'Updated reply')
  }

  async handleDelete(params: DeleteParams): Promise<void> {
    const { uri, rootUri } = params

    await this.db.transaction(async (tx) => {
      await tx.update(replies).set({ isAuthorDeleted: true }).where(eq(replies.uri, uri))

      // Decrement reply count (floor at 0 via GREATEST)
      if (rootUri) {
        await tx
          .update(topics)
          .set({
            replyCount: sql`GREATEST(${topics.replyCount} - 1, 0)`,
          })
          .where(eq(topics.uri, rootUri))
      }
    })

    this.logger.debug({ uri }, 'Soft-deleted reply (author delete)')
  }
}
