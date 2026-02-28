import { eq, sql } from 'drizzle-orm'
import type { VoteInput } from '@barazo-forum/lexicons'
import { votes } from '../../db/schema/votes.js'
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
  record: VoteInput
  live: boolean
}

interface DeleteParams {
  uri: string
  rkey: string
  did: string
  subjectUri: string
}

export class VoteIndexer {
  constructor(
    private db: Database,
    private logger: Logger
  ) {}

  async handleCreate(params: CreateParams): Promise<void> {
    const { uri, rkey, did, cid, record, live } = params
    const { subject } = record
    const clientCreatedAt = new Date(record.createdAt)
    const createdAt = live ? clampCreatedAt(clientCreatedAt) : clientCreatedAt

    await this.db.transaction(async (tx) => {
      await tx
        .insert(votes)
        .values({
          uri,
          rkey,
          authorDid: did,
          subjectUri: subject.uri,
          subjectCid: subject.cid,
          direction: record.direction,
          communityDid: record.community,
          cid,
          createdAt,
        })
        .onConflictDoNothing()

      await this.incrementVoteCount(tx, subject.uri)
    })

    this.logger.debug({ uri, did }, 'Indexed vote')
  }

  async handleDelete(params: DeleteParams): Promise<void> {
    const { uri, subjectUri } = params

    await this.db.transaction(async (tx) => {
      await tx.delete(votes).where(eq(votes.uri, uri))
      await this.decrementVoteCount(tx, subjectUri)
    })

    this.logger.debug({ uri }, 'Deleted vote')
  }

  private async incrementVoteCount(tx: Transaction, subjectUri: string): Promise<void> {
    const collection = getCollectionFromUri(subjectUri)

    if (collection === TOPIC_COLLECTION) {
      await tx
        .update(topics)
        .set({ voteCount: sql`${topics.voteCount} + 1` })
        .where(eq(topics.uri, subjectUri))
    } else if (collection === REPLY_COLLECTION) {
      await tx
        .update(replies)
        .set({ voteCount: sql`${replies.voteCount} + 1` })
        .where(eq(replies.uri, subjectUri))
    }
  }

  private async decrementVoteCount(tx: Transaction, subjectUri: string): Promise<void> {
    const collection = getCollectionFromUri(subjectUri)

    if (collection === TOPIC_COLLECTION) {
      await tx
        .update(topics)
        .set({
          voteCount: sql`GREATEST(${topics.voteCount} - 1, 0)`,
        })
        .where(eq(topics.uri, subjectUri))
    } else if (collection === REPLY_COLLECTION) {
      await tx
        .update(replies)
        .set({
          voteCount: sql`GREATEST(${replies.voteCount} - 1, 0)`,
        })
        .where(eq(replies.uri, subjectUri))
    }
  }
}
