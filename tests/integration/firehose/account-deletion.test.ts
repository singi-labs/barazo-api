import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { createDb } from '../../../src/db/index.js'
import type { Database } from '../../../src/db/index.js'
import { topics } from '../../../src/db/schema/topics.js'
import { replies } from '../../../src/db/schema/replies.js'
import { reactions } from '../../../src/db/schema/reactions.js'
import { users } from '../../../src/db/schema/users.js'
import { trackedRepos } from '../../../src/db/schema/tracked-repos.js'
import { TopicIndexer } from '../../../src/firehose/indexers/topic.js'
import { ReplyIndexer } from '../../../src/firehose/indexers/reply.js'
import { ReactionIndexer } from '../../../src/firehose/indexers/reaction.js'
import { RecordHandler } from '../../../src/firehose/handlers/record.js'
import { IdentityHandler } from '../../../src/firehose/handlers/identity.js'
import type { IdentityEvent } from '../../../src/firehose/types.js'
import type { AccountAgeService } from '../../../src/services/account-age.js'
import type postgres from 'postgres'

/** Stub that skips PLC resolution and always returns 'trusted'. */
function createStubAccountAgeService(): AccountAgeService {
  return {
    // eslint-disable-next-line @typescript-eslint/require-await
    resolveCreationDate: async () => null,
    determineTrustStatus: () => 'trusted',
  }
}

const DATABASE_URL =
  process.env['DATABASE_URL'] ?? 'postgresql://barazo:barazo_dev@localhost:5432/barazo'

function createLogger() {
  return {
    info: () => undefined,
    error: () => undefined,
    warn: () => undefined,
    debug: () => undefined,
  }
}

/** Asserts a single-row query result and returns the row. */
function one<T>(rows: T[]): T {
  expect(rows).toHaveLength(1)
  return rows[0] as T
}

describe('firehose account deletion (integration)', () => {
  let db: Database
  let client: postgres.Sql
  let recordHandler: RecordHandler
  let identityHandler: IdentityHandler

  const deletedUserDid = 'did:plc:deleted-user'
  const survivingUserDid = 'did:plc:surviving-user'

  beforeAll(() => {
    const conn = createDb(DATABASE_URL)
    db = conn.db
    client = conn.client

    const logger = createLogger()
    const topicIndexer = new TopicIndexer(db, logger as never)
    const replyIndexer = new ReplyIndexer(db, logger as never)
    const reactionIndexer = new ReactionIndexer(db, logger as never)

    recordHandler = new RecordHandler(
      { topic: topicIndexer, reply: replyIndexer, reaction: reactionIndexer },
      db,
      logger as never,
      createStubAccountAgeService()
    )

    identityHandler = new IdentityHandler(db, logger as never)
  })

  afterAll(async () => {
    await client.end()
  })

  beforeEach(async () => {
    // Clean all tables
    await db.delete(reactions)
    await db.delete(replies)
    await db.delete(topics)
    await db.delete(trackedRepos)
    await db.delete(users)
  })

  async function populateDataForBothUsers(): Promise<void> {
    // Create data for the user that will be deleted
    await recordHandler.handle({
      id: 100,
      action: 'create',
      did: deletedUserDid,
      rev: 'rev1',
      collection: 'forum.barazo.topic.post',
      rkey: 'del-topic1',
      record: {
        title: 'Deleted user topic',
        content: { $type: 'forum.barazo.richtext#markdown', value: 'This will be purged' },
        community: 'did:plc:community',
        category: 'general',
        publishedAt: '2026-01-15T10:00:00.000Z',
      },
      cid: 'bafydeltopic1',
      live: true,
    })

    // Deleted user's reply on their own topic
    const deletedTopicUri = `at://${deletedUserDid}/forum.barazo.topic.post/del-topic1`
    await recordHandler.handle({
      id: 101,
      action: 'create',
      did: deletedUserDid,
      rev: 'rev1',
      collection: 'forum.barazo.topic.reply',
      rkey: 'del-reply1',
      record: {
        content: { $type: 'forum.barazo.richtext#markdown', value: 'Deleted user reply' },
        root: { uri: deletedTopicUri, cid: 'bafydeltopic1' },
        parent: { uri: deletedTopicUri, cid: 'bafydeltopic1' },
        community: 'did:plc:community',
        createdAt: '2026-01-15T11:00:00.000Z',
      },
      cid: 'bafydelreply1',
      live: true,
    })

    // Create data for the surviving user
    await recordHandler.handle({
      id: 200,
      action: 'create',
      did: survivingUserDid,
      rev: 'rev1',
      collection: 'forum.barazo.topic.post',
      rkey: 'surv-topic1',
      record: {
        title: 'Surviving user topic',
        content: { $type: 'forum.barazo.richtext#markdown', value: 'This should remain' },
        community: 'did:plc:community',
        category: 'general',
        publishedAt: '2026-01-15T10:00:00.000Z',
      },
      cid: 'bafysurvtopic1',
      live: true,
    })

    // Surviving user's reaction on deleted user's topic
    await recordHandler.handle({
      id: 201,
      action: 'create',
      did: survivingUserDid,
      rev: 'rev1',
      collection: 'forum.barazo.interaction.reaction',
      rkey: 'surv-react1',
      record: {
        subject: { uri: deletedTopicUri, cid: 'bafydeltopic1' },
        type: 'like',
        community: 'did:plc:community',
        createdAt: '2026-01-15T12:00:00.000Z',
      },
      cid: 'bafysurvreact1',
      live: true,
    })

    // Deleted user's reaction on surviving user's topic
    const survivingTopicUri = `at://${survivingUserDid}/forum.barazo.topic.post/surv-topic1`
    await recordHandler.handle({
      id: 102,
      action: 'create',
      did: deletedUserDid,
      rev: 'rev1',
      collection: 'forum.barazo.interaction.reaction',
      rkey: 'del-react1',
      record: {
        subject: { uri: survivingTopicUri, cid: 'bafysurvtopic1' },
        type: 'like',
        community: 'did:plc:community',
        createdAt: '2026-01-15T13:00:00.000Z',
      },
      cid: 'bafydelreact1',
      live: true,
    })

    // Add deleted user to tracked repos
    await db.insert(trackedRepos).values({ did: deletedUserDid }).onConflictDoNothing()
  }

  it('purges all data for deleted account', async () => {
    await populateDataForBothUsers()

    // Verify data exists before deletion
    const topicsBefore = await db.select().from(topics).where(eq(topics.authorDid, deletedUserDid))
    expect(topicsBefore).toHaveLength(1)

    const repliesBefore = await db
      .select()
      .from(replies)
      .where(eq(replies.authorDid, deletedUserDid))
    expect(repliesBefore).toHaveLength(1)

    const reactionsBefore = await db
      .select()
      .from(reactions)
      .where(eq(reactions.authorDid, deletedUserDid))
    expect(reactionsBefore).toHaveLength(1)

    const userBefore = await db.select().from(users).where(eq(users.did, deletedUserDid))
    expect(userBefore).toHaveLength(1)

    const trackedBefore = await db
      .select()
      .from(trackedRepos)
      .where(eq(trackedRepos.did, deletedUserDid))
    expect(trackedBefore).toHaveLength(1)

    // Fire deletion event
    const deletionEvent: IdentityEvent = {
      id: 999,
      did: deletedUserDid,
      handle: 'deleted.user',
      isActive: false,
      status: 'deleted',
    }

    await identityHandler.handle(deletionEvent)

    // Verify all data for deleted user is gone
    const topicsAfter = await db.select().from(topics).where(eq(topics.authorDid, deletedUserDid))
    expect(topicsAfter).toHaveLength(0)

    const repliesAfter = await db
      .select()
      .from(replies)
      .where(eq(replies.authorDid, deletedUserDid))
    expect(repliesAfter).toHaveLength(0)

    const reactionsAfter = await db
      .select()
      .from(reactions)
      .where(eq(reactions.authorDid, deletedUserDid))
    expect(reactionsAfter).toHaveLength(0)

    const userAfter = await db.select().from(users).where(eq(users.did, deletedUserDid))
    expect(userAfter).toHaveLength(0)

    const trackedAfter = await db
      .select()
      .from(trackedRepos)
      .where(eq(trackedRepos.did, deletedUserDid))
    expect(trackedAfter).toHaveLength(0)
  })

  it("preserves other users' data during deletion", async () => {
    await populateDataForBothUsers()

    // Fire deletion for one user
    const deletionEvent: IdentityEvent = {
      id: 1000,
      did: deletedUserDid,
      handle: 'deleted.user',
      isActive: false,
      status: 'deleted',
    }

    await identityHandler.handle(deletionEvent)

    // Verify surviving user's topic is untouched
    const survivingTopics = one(
      await db.select().from(topics).where(eq(topics.authorDid, survivingUserDid))
    )
    expect(survivingTopics.title).toBe('Surviving user topic')

    // Verify surviving user still exists
    const survivingUser = one(await db.select().from(users).where(eq(users.did, survivingUserDid)))
    expect(survivingUser.did).toBe(survivingUserDid)

    // Surviving user's reaction on deleted user's topic should still exist
    // (it's owned by the surviving user, even though the subject is gone)
    const survivingReactions = one(
      await db.select().from(reactions).where(eq(reactions.authorDid, survivingUserDid))
    )
    expect(survivingReactions.authorDid).toBe(survivingUserDid)
  })

  it('handles active identity event (user handle update)', async () => {
    // First create the user via a record event
    await recordHandler.handle({
      id: 300,
      action: 'create',
      did: 'did:plc:handle-test',
      rev: 'rev1',
      collection: 'forum.barazo.topic.post',
      rkey: 'ht-topic1',
      record: {
        title: 'Handle test',
        content: { $type: 'forum.barazo.richtext#markdown', value: 'Testing handle update' },
        community: 'did:plc:community',
        category: 'general',
        publishedAt: '2026-01-15T10:00:00.000Z',
      },
      cid: 'bafyht1',
      live: true,
    })

    // User stub has DID as handle
    const userBefore = one(
      await db.select().from(users).where(eq(users.did, 'did:plc:handle-test'))
    )
    expect(userBefore.handle).toBe('did:plc:handle-test')

    // Fire identity active event with real handle
    const identityEvent: IdentityEvent = {
      id: 301,
      did: 'did:plc:handle-test',
      handle: 'real-handle.bsky.social',
      isActive: true,
      status: 'active',
    }

    await identityHandler.handle(identityEvent)

    // Verify handle was updated
    const userAfter = one(await db.select().from(users).where(eq(users.did, 'did:plc:handle-test')))
    expect(userAfter.handle).toBe('real-handle.bsky.social')
  })
})
