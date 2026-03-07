import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { createDb } from '../../../src/db/index.js'
import type { Database } from '../../../src/db/index.js'
import { topics } from '../../../src/db/schema/topics.js'
import { replies } from '../../../src/db/schema/replies.js'
import { reactions } from '../../../src/db/schema/reactions.js'
import { votes } from '../../../src/db/schema/votes.js'
import { users } from '../../../src/db/schema/users.js'
import { TopicIndexer } from '../../../src/firehose/indexers/topic.js'
import { ReplyIndexer } from '../../../src/firehose/indexers/reply.js'
import { ReactionIndexer } from '../../../src/firehose/indexers/reaction.js'
import { VoteIndexer } from '../../../src/firehose/indexers/vote.js'
import { RecordHandler } from '../../../src/firehose/handlers/record.js'
import type { RecordEvent } from '../../../src/firehose/types.js'
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

describe('firehose record processing (integration)', () => {
  let db: Database
  let client: postgres.Sql
  let handler: RecordHandler

  beforeAll(() => {
    const conn = createDb(DATABASE_URL)
    db = conn.db
    client = conn.client

    const logger = createLogger()
    const topicIndexer = new TopicIndexer(db, logger as never)
    const replyIndexer = new ReplyIndexer(db, logger as never)
    const reactionIndexer = new ReactionIndexer(db, logger as never)
    const voteIndexer = new VoteIndexer(db, logger as never)

    handler = new RecordHandler(
      { topic: topicIndexer, reply: replyIndexer, reaction: reactionIndexer, vote: voteIndexer },
      db,
      logger as never,
      createStubAccountAgeService()
    )
  })

  afterAll(async () => {
    await client.end()
  })

  beforeEach(async () => {
    // Clean tables in correct FK-safe order
    await db.delete(votes)
    await db.delete(reactions)
    await db.delete(replies)
    await db.delete(topics)
    await db.delete(users)
  })

  describe('topic lifecycle', () => {
    const topicEvent: RecordEvent = {
      id: 1,
      action: 'create',
      did: 'did:plc:integ-user1',
      rev: 'rev1',
      collection: 'forum.barazo.topic.post',
      rkey: 'topic1',
      record: {
        title: 'Integration Test Topic',
        content: {
          $type: 'forum.barazo.richtext#markdown',
          value: 'This is a test topic for integration testing.',
        },
        community: 'did:plc:community',
        category: 'general',
        publishedAt: '2026-01-15T10:00:00.000Z',
      },
      cid: 'bafytopic1',
      live: true,
    }

    it('creates a topic and upserts user stub', async () => {
      await handler.handle(topicEvent)

      const topic = one(
        await db
          .select()
          .from(topics)
          .where(eq(topics.uri, 'at://did:plc:integ-user1/forum.barazo.topic.post/topic1'))
      )

      expect(topic.title).toBe('Integration Test Topic')
      expect(topic.authorDid).toBe('did:plc:integ-user1')
      expect(topic.category).toBe('general')
      expect(topic.communityDid).toBe('did:plc:community')
      expect(topic.replyCount).toBe(0)
      expect(topic.reactionCount).toBe(0)

      // Verify user stub was created
      const user = one(await db.select().from(users).where(eq(users.did, 'did:plc:integ-user1')))

      expect(user.handle).toBe('did:plc:integ-user1') // Stub uses DID as handle
    })

    it('updates a topic', async () => {
      await handler.handle(topicEvent)

      const updateEvent: RecordEvent = {
        id: 2,
        action: 'update',
        did: 'did:plc:integ-user1',
        rev: 'rev2',
        collection: 'forum.barazo.topic.post',
        rkey: 'topic1',
        record: {
          title: 'Updated Topic Title',
          content: {
            $type: 'forum.barazo.richtext#markdown',
            value: 'Updated content for the topic.',
          },
          community: 'did:plc:community',
          category: 'discussion',
          publishedAt: '2026-01-15T10:00:00.000Z',
        },
        cid: 'bafytopic1v2',
        live: true,
      }

      await handler.handle(updateEvent)

      const topic = one(
        await db
          .select()
          .from(topics)
          .where(eq(topics.uri, 'at://did:plc:integ-user1/forum.barazo.topic.post/topic1'))
      )

      expect(topic.title).toBe('Updated Topic Title')
      expect(topic.content).toBe('Updated content for the topic.')
      expect(topic.category).toBe('discussion')
      expect(topic.cid).toBe('bafytopic1v2')
    })

    it('soft-deletes a topic', async () => {
      await handler.handle(topicEvent)

      const deleteEvent: RecordEvent = {
        id: 3,
        action: 'delete',
        did: 'did:plc:integ-user1',
        rev: 'rev3',
        collection: 'forum.barazo.topic.post',
        rkey: 'topic1',
        live: true,
      }

      await handler.handle(deleteEvent)

      const topic = one(
        await db
          .select()
          .from(topics)
          .where(eq(topics.uri, 'at://did:plc:integ-user1/forum.barazo.topic.post/topic1'))
      )

      expect(topic.isAuthorDeleted).toBe(true)
    })
  })

  describe('reply with count updates', () => {
    const topicUri = 'at://did:plc:integ-user1/forum.barazo.topic.post/topic1'

    beforeEach(async () => {
      // Create a topic first for replies to attach to
      await handler.handle({
        id: 10,
        action: 'create',
        did: 'did:plc:integ-user1',
        rev: 'rev1',
        collection: 'forum.barazo.topic.post',
        rkey: 'topic1',
        record: {
          title: 'Parent Topic',
          content: { $type: 'forum.barazo.richtext#markdown', value: 'Topic for reply tests' },
          community: 'did:plc:community',
          category: 'general',
          publishedAt: '2026-01-15T10:00:00.000Z',
        },
        cid: 'bafytopic1',
        live: true,
      })
    })

    it('creates a reply and increments reply count', async () => {
      await handler.handle({
        id: 11,
        action: 'create',
        did: 'did:plc:integ-user2',
        rev: 'rev1',
        collection: 'forum.barazo.topic.reply',
        rkey: 'reply1',
        record: {
          content: { $type: 'forum.barazo.richtext#markdown', value: 'This is a reply' },
          root: { uri: topicUri, cid: 'bafytopic1' },
          parent: { uri: topicUri, cid: 'bafytopic1' },
          community: 'did:plc:community',
          createdAt: '2026-01-15T11:00:00.000Z',
        },
        cid: 'bafyreply1',
        live: true,
      })

      // Verify reply exists
      const reply = one(
        await db
          .select()
          .from(replies)
          .where(eq(replies.uri, 'at://did:plc:integ-user2/forum.barazo.topic.reply/reply1'))
      )

      expect(reply.content).toBe('This is a reply')
      expect(reply.rootUri).toBe(topicUri)

      // Verify reply count incremented
      const topic = one(await db.select().from(topics).where(eq(topics.uri, topicUri)))

      expect(topic.replyCount).toBe(1)
    })

    it('handles multiple replies and correct count', async () => {
      // Add two replies
      for (let i = 1; i <= 2; i++) {
        await handler.handle({
          id: 20 + i,
          action: 'create',
          did: `did:plc:integ-user${String(i + 1)}`,
          rev: 'rev1',
          collection: 'forum.barazo.topic.reply',
          rkey: `reply${String(i)}`,
          record: {
            content: { $type: 'forum.barazo.richtext#markdown', value: `Reply ${String(i)}` },
            root: { uri: topicUri, cid: 'bafytopic1' },
            parent: { uri: topicUri, cid: 'bafytopic1' },
            community: 'did:plc:community',
            createdAt: `2026-01-15T1${String(i)}:00:00.000Z`,
          },
          cid: `bafyreply${String(i)}`,
          live: true,
        })
      }

      const topic = one(await db.select().from(topics).where(eq(topics.uri, topicUri)))

      expect(topic.replyCount).toBe(2)
    })
  })

  describe('reaction with count updates', () => {
    const topicUri = 'at://did:plc:integ-user1/forum.barazo.topic.post/topic1'

    beforeEach(async () => {
      await handler.handle({
        id: 30,
        action: 'create',
        did: 'did:plc:integ-user1',
        rev: 'rev1',
        collection: 'forum.barazo.topic.post',
        rkey: 'topic1',
        record: {
          title: 'Reactable Topic',
          content: { $type: 'forum.barazo.richtext#markdown', value: 'Topic for reaction tests' },
          community: 'did:plc:community',
          category: 'general',
          publishedAt: '2026-01-15T10:00:00.000Z',
        },
        cid: 'bafytopic1',
        live: true,
      })
    })

    it('creates a reaction and increments reaction count on topic', async () => {
      await handler.handle({
        id: 31,
        action: 'create',
        did: 'did:plc:integ-user2',
        rev: 'rev1',
        collection: 'forum.barazo.interaction.reaction',
        rkey: 'react1',
        record: {
          subject: { uri: topicUri, cid: 'bafytopic1' },
          type: 'like',
          community: 'did:plc:community',
          createdAt: '2026-01-15T12:00:00.000Z',
        },
        cid: 'bafyreact1',
        live: true,
      })

      // Verify reaction exists
      const reaction = one(
        await db
          .select()
          .from(reactions)
          .where(
            eq(reactions.uri, 'at://did:plc:integ-user2/forum.barazo.interaction.reaction/react1')
          )
      )

      expect(reaction.type).toBe('like')
      expect(reaction.subjectUri).toBe(topicUri)

      // Verify reaction count incremented on topic
      const topic = one(await db.select().from(topics).where(eq(topics.uri, topicUri)))

      expect(topic.reactionCount).toBe(1)
    })
  })

  describe('idempotent replay', () => {
    it('replaying a topic create is idempotent (upsert)', async () => {
      const event: RecordEvent = {
        id: 40,
        action: 'create',
        did: 'did:plc:integ-user1',
        rev: 'rev1',
        collection: 'forum.barazo.topic.post',
        rkey: 'idem-topic1',
        record: {
          title: 'Idempotent Topic',
          content: { $type: 'forum.barazo.richtext#markdown', value: 'Original content' },
          community: 'did:plc:community',
          category: 'general',
          publishedAt: '2026-01-15T10:00:00.000Z',
        },
        cid: 'bafyidem1',
        live: false,
      }

      // Process same event twice
      await handler.handle(event)
      await handler.handle(event)

      const result = await db
        .select()
        .from(topics)
        .where(eq(topics.uri, 'at://did:plc:integ-user1/forum.barazo.topic.post/idem-topic1'))

      // Should still be exactly one row
      expect(result).toHaveLength(1)
      const topic = one(result)
      expect(topic.title).toBe('Idempotent Topic')
    })

    it('replaying a reply create does not duplicate rows', async () => {
      const topicUri = 'at://did:plc:integ-user1/forum.barazo.topic.post/idem-topic2'

      // Create topic
      await handler.handle({
        id: 50,
        action: 'create',
        did: 'did:plc:integ-user1',
        rev: 'rev1',
        collection: 'forum.barazo.topic.post',
        rkey: 'idem-topic2',
        record: {
          title: 'Topic for replay test',
          content: { $type: 'forum.barazo.richtext#markdown', value: 'Content' },
          community: 'did:plc:community',
          category: 'general',
          publishedAt: '2026-01-15T10:00:00.000Z',
        },
        cid: 'bafyidem2',
        live: false,
      })

      const replyEvent: RecordEvent = {
        id: 51,
        action: 'create',
        did: 'did:plc:integ-user2',
        rev: 'rev1',
        collection: 'forum.barazo.topic.reply',
        rkey: 'idem-reply1',
        record: {
          content: { $type: 'forum.barazo.richtext#markdown', value: 'Replay test reply' },
          root: { uri: topicUri, cid: 'bafyidem2' },
          parent: { uri: topicUri, cid: 'bafyidem2' },
          community: 'did:plc:community',
          createdAt: '2026-01-15T11:00:00.000Z',
        },
        cid: 'bafyidemreply1',
        live: false,
      }

      // Reply uses onConflictDoNothing, so second insert is a no-op for the row.
      // In practice, Tap handles replay deduplication.
      await handler.handle(replyEvent)
      await handler.handle(replyEvent)

      const replyRows = await db
        .select()
        .from(replies)
        .where(eq(replies.uri, 'at://did:plc:integ-user2/forum.barazo.topic.reply/idem-reply1'))

      // Exactly one reply row (onConflictDoNothing)
      expect(replyRows).toHaveLength(1)
    })
  })

  describe('tombstone: edit-then-delete preserves reply strongRefs', () => {
    const topicUri = 'at://did:plc:integ-user1/forum.barazo.topic.post/edit-del-topic'
    const originalCid = 'bafyoriginalcid'
    const updatedCid = 'bafyupdatedcid'

    it('reply retains original CID reference after topic edit and delete', async () => {
      // Step 1: Create topic with original CID
      await handler.handle({
        id: 70,
        action: 'create',
        did: 'did:plc:integ-user1',
        rev: 'rev1',
        collection: 'forum.barazo.topic.post',
        rkey: 'edit-del-topic',
        record: {
          title: 'Original Title',
          content: { $type: 'forum.barazo.richtext#markdown', value: 'Original content' },
          community: 'did:plc:community',
          category: 'general',
          publishedAt: '2026-01-15T10:00:00.000Z',
        },
        cid: originalCid,
        live: true,
      })

      // Step 2: Another user replies, referencing the original CID
      await handler.handle({
        id: 71,
        action: 'create',
        did: 'did:plc:integ-user2',
        rev: 'rev1',
        collection: 'forum.barazo.topic.reply',
        rkey: 'edit-del-reply',
        record: {
          content: {
            $type: 'forum.barazo.richtext#markdown',
            value: 'Reply referencing original CID',
          },
          root: { uri: topicUri, cid: originalCid },
          parent: { uri: topicUri, cid: originalCid },
          community: 'did:plc:community',
          createdAt: '2026-01-15T11:00:00.000Z',
        },
        cid: 'bafyreplyeditdel',
        live: true,
      })

      // Step 3: Author edits the topic (CID changes)
      await handler.handle({
        id: 72,
        action: 'update',
        did: 'did:plc:integ-user1',
        rev: 'rev2',
        collection: 'forum.barazo.topic.post',
        rkey: 'edit-del-topic',
        record: {
          title: 'Updated Title',
          content: { $type: 'forum.barazo.richtext#markdown', value: 'Updated content' },
          community: 'did:plc:community',
          category: 'general',
          publishedAt: '2026-01-15T10:00:00.000Z',
        },
        cid: updatedCid,
        live: true,
      })

      // Step 4: Author deletes the topic
      await handler.handle({
        id: 73,
        action: 'delete',
        did: 'did:plc:integ-user1',
        rev: 'rev3',
        collection: 'forum.barazo.topic.post',
        rkey: 'edit-del-topic',
        live: true,
      })

      // Verify: topic is soft-deleted, not hard-deleted
      const topic = one(await db.select().from(topics).where(eq(topics.uri, topicUri)))
      expect(topic.isAuthorDeleted).toBe(true)
      expect(topic.cid).toBe(updatedCid)

      // Verify: reply still exists with original CID references intact
      const replyUri = 'at://did:plc:integ-user2/forum.barazo.topic.reply/edit-del-reply'
      const reply = one(await db.select().from(replies).where(eq(replies.uri, replyUri)))
      expect(reply.isAuthorDeleted).toBe(false)
      expect(reply.rootUri).toBe(topicUri)
      expect(reply.rootCid).toBe(originalCid)
      expect(reply.parentCid).toBe(originalCid)
    })
  })

  describe('tombstone: rapid create-then-delete', () => {
    it('topic ends up soft-deleted after create followed by immediate delete', async () => {
      const topicUri = 'at://did:plc:integ-user1/forum.barazo.topic.post/rapid-topic'

      // Create then immediately delete (simulates rapid firehose events)
      await handler.handle({
        id: 80,
        action: 'create',
        did: 'did:plc:integ-user1',
        rev: 'rev1',
        collection: 'forum.barazo.topic.post',
        rkey: 'rapid-topic',
        record: {
          title: 'Ephemeral Topic',
          content: { $type: 'forum.barazo.richtext#markdown', value: 'Gone before you know it' },
          community: 'did:plc:community',
          category: 'general',
          publishedAt: '2026-01-15T10:00:00.000Z',
        },
        cid: 'bafyrapid1',
        live: true,
      })

      await handler.handle({
        id: 81,
        action: 'delete',
        did: 'did:plc:integ-user1',
        rev: 'rev2',
        collection: 'forum.barazo.topic.post',
        rkey: 'rapid-topic',
        live: true,
      })

      // Topic row should exist but be soft-deleted
      const topic = one(await db.select().from(topics).where(eq(topics.uri, topicUri)))
      expect(topic.isAuthorDeleted).toBe(true)
    })

    it('replies survive when topic is rapidly created and deleted', async () => {
      const topicUri = 'at://did:plc:integ-user1/forum.barazo.topic.post/rapid-topic2'

      // Create topic
      await handler.handle({
        id: 82,
        action: 'create',
        did: 'did:plc:integ-user1',
        rev: 'rev1',
        collection: 'forum.barazo.topic.post',
        rkey: 'rapid-topic2',
        record: {
          title: 'Another Ephemeral Topic',
          content: { $type: 'forum.barazo.richtext#markdown', value: 'Will be deleted quickly' },
          community: 'did:plc:community',
          category: 'general',
          publishedAt: '2026-01-15T10:00:00.000Z',
        },
        cid: 'bafyrapid2',
        live: true,
      })

      // Another user replies before deletion
      await handler.handle({
        id: 83,
        action: 'create',
        did: 'did:plc:integ-user2',
        rev: 'rev1',
        collection: 'forum.barazo.topic.reply',
        rkey: 'rapid-reply1',
        record: {
          content: {
            $type: 'forum.barazo.richtext#markdown',
            value: 'Quick reply before deletion',
          },
          root: { uri: topicUri, cid: 'bafyrapid2' },
          parent: { uri: topicUri, cid: 'bafyrapid2' },
          community: 'did:plc:community',
          createdAt: '2026-01-15T10:00:01.000Z',
        },
        cid: 'bafyrapidreply1',
        live: true,
      })

      // Rapid delete of the topic
      await handler.handle({
        id: 84,
        action: 'delete',
        did: 'did:plc:integ-user1',
        rev: 'rev2',
        collection: 'forum.barazo.topic.post',
        rkey: 'rapid-topic2',
        live: true,
      })

      // Topic is soft-deleted
      const topic = one(await db.select().from(topics).where(eq(topics.uri, topicUri)))
      expect(topic.isAuthorDeleted).toBe(true)

      // Reply is preserved (belongs to another user)
      const replyUri = 'at://did:plc:integ-user2/forum.barazo.topic.reply/rapid-reply1'
      const reply = one(await db.select().from(replies).where(eq(replies.uri, replyUri)))
      expect(reply.isAuthorDeleted).toBe(false)
      expect(reply.content).toBe('Quick reply before deletion')
    })

    it('delete before create is handled gracefully (out-of-order events)', async () => {
      // Firehose can deliver events out of order; delete arriving before create
      // should not throw
      await handler.handle({
        id: 85,
        action: 'delete',
        did: 'did:plc:integ-user1',
        rev: 'rev2',
        collection: 'forum.barazo.topic.post',
        rkey: 'ooo-topic',
        live: true,
      })

      // Topic doesn't exist, so the update should be a no-op (0 rows affected)
      const topicUri = 'at://did:plc:integ-user1/forum.barazo.topic.post/ooo-topic'
      const result = await db.select().from(topics).where(eq(topics.uri, topicUri))
      expect(result).toHaveLength(0)
    })
  })

  describe('unsupported and invalid records', () => {
    it('skips unsupported collections', async () => {
      const event: RecordEvent = {
        id: 60,
        action: 'create',
        did: 'did:plc:integ-user1',
        rev: 'rev1',
        collection: 'app.bsky.feed.post',
        rkey: 'post1',
        record: { text: 'Hello world' },
        cid: 'bafypost1',
        live: true,
      }

      // Should not throw
      await handler.handle(event)

      // No topic should be created
      const result = await db.select().from(topics)
      expect(result).toHaveLength(0)
    })

    it('skips invalid record data', async () => {
      const event: RecordEvent = {
        id: 61,
        action: 'create',
        did: 'did:plc:integ-user1',
        rev: 'rev1',
        collection: 'forum.barazo.topic.post',
        rkey: 'bad1',
        record: { invalid: 'data' },
        cid: 'bafybad1',
        live: true,
      }

      await handler.handle(event)

      const result = await db.select().from(topics)
      expect(result).toHaveLength(0)
    })
  })
})
