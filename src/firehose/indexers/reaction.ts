import { eq, sql } from 'drizzle-orm'
import type { ReactionInput } from '@singi-labs/barazo-lexicons'
import { reactions } from '../../db/schema/reactions.js'
import { topics } from '../../db/schema/topics.js'
import { replies } from '../../db/schema/replies.js'
import type { Database } from '../../db/index.js'
import type { Logger } from '../../lib/logger.js'
import { clampCreatedAt } from '../clamp-timestamp.js'
import { getCollectionFromUri } from '../../lib/at-uri.js'

const TOPIC_COLLECTION = 'forum.barazo.topic.post'
const REPLY_COLLECTION = 'forum.barazo.topic.reply'

/** Transaction type extracted from Database.transaction() callback parameter */
type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0]

interface CreateParams {
  uri: string
  rkey: string
  did: string
  cid: string
  record: ReactionInput
  live: boolean
}

interface DeleteParams {
  uri: string
  rkey: string
  did: string
  subjectUri: string
}

export class ReactionIndexer {
  constructor(
    private db: Database,
    private logger: Logger
  ) {}

  async handleCreate(params: CreateParams): Promise<void> {
    const { uri, rkey, did, cid, record, live } = params
    const { subject } = record

    // Skip self-reactions: extract the subject author DID from the AT URI
    const subjectAuthorDid = subject.uri.split('/')[2]
    if (subjectAuthorDid === did) {
      this.logger.debug({ uri, did }, 'Skipping self-reaction')
      return
    }

    const clientCreatedAt = new Date(record.createdAt)
    const createdAt = live ? clampCreatedAt(clientCreatedAt) : clientCreatedAt

    await this.db.transaction(async (tx) => {
      await tx
        .insert(reactions)
        .values({
          uri,
          rkey,
          authorDid: did,
          subjectUri: subject.uri,
          subjectCid: subject.cid,
          type: record.type,
          communityDid: record.community,
          cid,
          createdAt,
        })
        .onConflictDoNothing()

      await this.incrementReactionCount(tx, subject.uri)
    })

    this.logger.debug({ uri, did }, 'Indexed reaction')
  }

  async handleDelete(params: DeleteParams): Promise<void> {
    const { uri, subjectUri } = params

    await this.db.transaction(async (tx) => {
      await tx.delete(reactions).where(eq(reactions.uri, uri))
      await this.decrementReactionCount(tx, subjectUri)
    })

    this.logger.debug({ uri }, 'Deleted reaction')
  }

  private async incrementReactionCount(tx: Transaction, subjectUri: string): Promise<void> {
    const collection = getCollectionFromUri(subjectUri)

    if (collection === TOPIC_COLLECTION) {
      await tx
        .update(topics)
        .set({ reactionCount: sql`${topics.reactionCount} + 1` })
        .where(eq(topics.uri, subjectUri))
    } else if (collection === REPLY_COLLECTION) {
      await tx
        .update(replies)
        .set({ reactionCount: sql`${replies.reactionCount} + 1` })
        .where(eq(replies.uri, subjectUri))
    }
  }

  private async decrementReactionCount(tx: Transaction, subjectUri: string): Promise<void> {
    const collection = getCollectionFromUri(subjectUri)

    if (collection === TOPIC_COLLECTION) {
      await tx
        .update(topics)
        .set({
          reactionCount: sql`GREATEST(${topics.reactionCount} - 1, 0)`,
        })
        .where(eq(topics.uri, subjectUri))
    } else if (collection === REPLY_COLLECTION) {
      await tx
        .update(replies)
        .set({
          reactionCount: sql`GREATEST(${replies.reactionCount} - 1, 0)`,
        })
        .where(eq(replies.uri, subjectUri))
    }
  }
}
