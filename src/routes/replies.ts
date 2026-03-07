import { eq, and, sql, asc, notInArray } from 'drizzle-orm'
import { requireCommunityDid } from '../middleware/community-resolver.js'
import type { FastifyPluginCallback } from 'fastify'
import { createPdsClient } from '../lib/pds-client.js'
import {
  notFound,
  forbidden,
  badRequest,
  errorResponseSchema,
  sendError,
} from '../lib/api-errors.js'
import { resolveMaxMaturity, maturityAllows } from '../lib/content-filter.js'
import type { MaturityUser } from '../lib/content-filter.js'
import { loadBlockMuteLists } from '../lib/block-mute.js'
import { loadMutedWords, contentMatchesMutedWords } from '../lib/muted-words.js'
import { resolveAuthors } from '../lib/resolve-authors.js'
import { createReplySchema, updateReplySchema, replyQuerySchema } from '../validation/replies.js'
import {
  runAntiSpamChecks,
  loadAntiSpamSettings,
  isNewAccount,
  isAccountTrusted,
  checkWriteRateLimit,
} from '../lib/anti-spam.js'
import { tooManyRequests } from '../lib/api-errors.js'
import { moderationQueue } from '../db/schema/moderation-queue.js'
import { replies } from '../db/schema/replies.js'
import { topics } from '../db/schema/topics.js'
import { users } from '../db/schema/users.js'
import { categories } from '../db/schema/categories.js'
import { communitySettings } from '../db/schema/community-settings.js'
import { checkOnboardingComplete } from '../lib/onboarding-gate.js'
import { createNotificationService } from '../services/notification.js'
import { extractRkey } from '../lib/at-uri.js'
import { resolveHandleToDid } from '../lib/resolve-handle-to-did.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const COLLECTION = 'forum.barazo.topic.reply'

// ---------------------------------------------------------------------------
// OpenAPI JSON Schema definitions
// ---------------------------------------------------------------------------

const replyJsonSchema = {
  type: 'object' as const,
  properties: {
    uri: { type: 'string' as const },
    rkey: { type: 'string' as const },
    authorDid: { type: 'string' as const },
    author: {
      type: 'object' as const,
      properties: {
        did: { type: 'string' as const },
        handle: { type: 'string' as const },
        displayName: { type: ['string', 'null'] as const },
        avatarUrl: { type: ['string', 'null'] as const },
      },
    },
    content: { type: 'string' as const },
    rootUri: { type: 'string' as const },
    rootCid: { type: 'string' as const },
    parentUri: { type: 'string' as const },
    parentCid: { type: 'string' as const },
    labels: {
      type: ['object', 'null'] as const,
      properties: {
        values: {
          type: 'array' as const,
          items: {
            type: 'object' as const,
            properties: { val: { type: 'string' as const } },
          },
        },
      },
    },
    communityDid: { type: 'string' as const },
    cid: { type: 'string' as const },
    depth: { type: 'integer' as const },
    childCount: { type: 'integer' as const },
    reactionCount: { type: 'integer' as const },
    isAuthorDeleted: { type: 'boolean' as const },
    isModDeleted: { type: 'boolean' as const },
    isMuted: { type: 'boolean' as const },
    isMutedWord: { type: 'boolean' as const },
    ozoneLabel: { type: ['string', 'null'] as const },
    createdAt: { type: 'string' as const, format: 'date-time' as const },
    indexedAt: { type: 'string' as const, format: 'date-time' as const },
  },
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Serialize a reply row from the DB into a JSON-safe response object.
 * Converts Date fields to ISO strings and computes depth.
 */
function serializeReply(row: typeof replies.$inferSelect) {
  const depth = row.depth

  const placeholderContent = row.isModDeleted
    ? '[Removed by moderator]'
    : row.isAuthorDeleted
      ? '[Deleted by author]'
      : row.content

  return {
    uri: row.uri,
    rkey: row.rkey,
    authorDid: row.authorDid,
    content: placeholderContent,
    rootUri: row.rootUri,
    rootCid: row.rootCid,
    parentUri: row.parentUri,
    parentCid: row.parentCid,
    labels: row.labels ?? null,
    communityDid: row.communityDid,
    cid: row.cid,
    depth,
    reactionCount: row.reactionCount,
    isAuthorDeleted: row.isAuthorDeleted,
    isModDeleted: row.isModDeleted,
    createdAt: row.createdAt.toISOString(),
    indexedAt: row.indexedAt.toISOString(),
  }
}

/**
 * Encode a pagination cursor from createdAt + uri.
 */
function encodeCursor(createdAt: string, uri: string): string {
  return Buffer.from(JSON.stringify({ createdAt, uri })).toString('base64')
}

/**
 * Decode a pagination cursor. Returns null if invalid.
 */
function decodeCursor(cursor: string): { createdAt: string; uri: string } | null {
  try {
    const decoded = JSON.parse(Buffer.from(cursor, 'base64').toString('utf-8')) as Record<
      string,
      unknown
    >
    if (typeof decoded.createdAt === 'string' && typeof decoded.uri === 'string') {
      return { createdAt: decoded.createdAt, uri: decoded.uri }
    }
    return null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Reply routes plugin
// ---------------------------------------------------------------------------

/**
 * Reply routes for the Barazo forum.
 *
 * - POST   /api/topics/:topicUri/replies                 -- Create a reply
 * - GET    /api/topics/:topicUri/replies                  -- List replies for a topic
 * - GET    /api/replies/by-author-rkey/:handle/:rkey      -- Get a reply by author handle and rkey
 * - PUT    /api/replies/:uri                              -- Update a reply
 * - DELETE /api/replies/:uri                              -- Delete a reply
 */
export function replyRoutes(): FastifyPluginCallback {
  return (app, _opts, done) => {
    const { db, env, authMiddleware, firehose } = app
    const pdsClient = createPdsClient(app.oauthClient, app.log)
    const notificationService = createNotificationService(db, app.log)

    // -------------------------------------------------------------------
    // POST /api/topics/:topicUri/replies (auth required)
    // -------------------------------------------------------------------

    app.post(
      '/api/topics/:topicUri/replies',
      {
        preHandler: [authMiddleware.requireAuth],
        schema: {
          tags: ['Replies'],
          summary: 'Create a reply to a topic',
          security: [{ bearerAuth: [] }],
          params: {
            type: 'object',
            required: ['topicUri'],
            properties: {
              topicUri: { type: 'string' },
            },
          },
          body: {
            type: 'object',
            required: ['content'],
            properties: {
              content: { type: 'string', minLength: 1, maxLength: 50000 },
              parentUri: { type: 'string', minLength: 1 },
              labels: {
                type: 'object',
                properties: {
                  values: {
                    type: 'array',
                    items: {
                      type: 'object',
                      required: ['val'],
                      properties: { val: { type: 'string' } },
                    },
                  },
                },
              },
            },
          },
          response: {
            201: {
              type: 'object',
              properties: {
                uri: { type: 'string' },
                cid: { type: 'string' },
                rkey: { type: 'string' },
                content: { type: 'string' },
                moderationStatus: { type: 'string', enum: ['approved', 'held', 'rejected'] },
                createdAt: { type: 'string', format: 'date-time' },
              },
            },
            400: errorResponseSchema,
            401: errorResponseSchema,
            403: errorResponseSchema,
            404: errorResponseSchema,
            500: errorResponseSchema,
            502: errorResponseSchema,
          },
        },
      },
      async (request, reply) => {
        const user = request.user
        if (!user) {
          return reply.status(401).send({ error: 'Authentication required' })
        }

        const parsed = createReplySchema.safeParse(request.body)
        if (!parsed.success) {
          throw badRequest('Invalid reply data')
        }

        const { topicUri } = request.params as { topicUri: string }
        const decodedTopicUri = decodeURIComponent(topicUri)
        const { content, parentUri, labels } = parsed.data

        // Look up the parent topic
        const topicRows = await db.select().from(topics).where(eq(topics.uri, decodedTopicUri))

        const topic = topicRows[0]
        if (!topic) {
          throw notFound('Topic not found')
        }

        // Onboarding gate: block if user hasn't completed mandatory onboarding
        const onboarding = await checkOnboardingComplete(db, user.did, topic.communityDid)
        if (!onboarding.complete) {
          return reply.status(403).send({
            error: 'Onboarding required',
            fields: onboarding.missingFields,
          })
        }

        // Ozone label check: spam-labeled accounts get stricter rate limits
        let ozoneSpamLabeled = false
        if (app.ozoneService) {
          ozoneSpamLabeled = await app.ozoneService.isSpamLabeled(user.did)
        }

        // Anti-spam checks
        const antiSpamSettings = await loadAntiSpamSettings(db, app.cache, topic.communityDid)
        const trusted =
          !ozoneSpamLabeled &&
          (await isAccountTrusted(
            db,
            user.did,
            topic.communityDid,
            antiSpamSettings.trustedPostThreshold
          ))

        if (!trusted) {
          // Ozone spam-labeled accounts are always treated as new (stricter rate limits)
          const isNew =
            ozoneSpamLabeled ||
            (await isNewAccount(db, user.did, topic.communityDid, antiSpamSettings.newAccountDays))

          // Write rate limit
          const rateLimited = await checkWriteRateLimit(
            app.cache,
            user.did,
            topic.communityDid,
            isNew,
            antiSpamSettings
          )
          if (rateLimited) {
            throw tooManyRequests('Write rate limit exceeded. Please try again later.')
          }
        }

        // Content-level anti-spam checks (word filter, first-post queue, link hold, burst)
        const spamResult = await runAntiSpamChecks(db, app.cache, {
          authorDid: user.did,
          communityDid: topic.communityDid,
          contentType: 'reply',
          content,
        })

        // Resolve parent reference
        let parentRefUri = topic.uri
        let parentRefCid = topic.cid

        let depth = 1
        if (parentUri) {
          // Look up the parent reply
          const parentReplyRows = await db.select().from(replies).where(eq(replies.uri, parentUri))

          const parentReply = parentReplyRows[0]
          if (!parentReply) {
            throw badRequest('Parent reply not found')
          }
          parentRefUri = parentReply.uri
          parentRefCid = parentReply.cid
          depth = parentReply.depth + 1
        }

        const now = new Date().toISOString()

        // Build AT Protocol record
        const record: Record<string, unknown> = {
          content: { $type: 'forum.barazo.richtext#markdown', value: content },
          community: topic.communityDid,
          root: { uri: topic.uri, cid: topic.cid },
          parent: { uri: parentRefUri, cid: parentRefCid },
          createdAt: now,
          ...(labels ? { labels } : {}),
        }

        // Write record to user's PDS
        let pdsResult: { uri: string; cid: string }
        try {
          pdsResult = await pdsClient.createRecord(user.did, COLLECTION, record)
        } catch (err: unknown) {
          if (err instanceof Error && 'statusCode' in err) throw err
          app.log.error({ err, did: user.did }, 'PDS write failed for reply creation')
          return sendError(reply, 502, 'Failed to write to remote PDS')
        }

        const rkey = extractRkey(pdsResult.uri)

        try {
          // Track repo if this is user's first post
          const repoManager = firehose.getRepoManager()
          const alreadyTracked = await repoManager.isTracked(user.did)
          if (!alreadyTracked) {
            await repoManager.trackRepo(user.did)
          }

          // Insert into local DB optimistically
          const contentModerationStatus = spamResult.held ? 'held' : 'approved'
          await db
            .insert(replies)
            .values({
              uri: pdsResult.uri,
              rkey,
              authorDid: user.did,
              content,
              rootUri: topic.uri,
              rootCid: topic.cid,
              parentUri: parentRefUri,
              parentCid: parentRefCid,
              communityDid: topic.communityDid,
              cid: pdsResult.cid,
              labels: labels ?? null,
              reactionCount: 0,
              depth,
              moderationStatus: contentModerationStatus,
              createdAt: new Date(now),
              indexedAt: new Date(),
            })
            .onConflictDoUpdate({
              target: replies.uri,
              set: {
                content,
                labels: labels ?? null,
                cid: pdsResult.cid,
                moderationStatus: contentModerationStatus,
                indexedAt: new Date(),
              },
            })

          // Insert moderation queue entries if held
          if (spamResult.held) {
            const queueEntries = spamResult.reasons.map((r) => ({
              contentUri: pdsResult.uri,
              contentType: 'reply' as const,
              authorDid: user.did,
              communityDid: topic.communityDid,
              queueReason: r.reason,
              matchedWords: r.matchedWords ?? null,
            }))
            await db.insert(moderationQueue).values(queueEntries)

            app.log.info(
              {
                replyUri: pdsResult.uri,
                reasons: spamResult.reasons.map((r) => r.reason),
                authorDid: user.did,
              },
              'Reply held for moderation'
            )
          }

          // Update parent topic: increment replyCount, set lastActivityAt
          // Only count approved replies in the visible reply count
          if (!spamResult.held) {
            await db
              .update(topics)
              .set({
                replyCount: sql`${topics.replyCount} + 1`,
                lastActivityAt: new Date(),
              })
              .where(eq(topics.uri, decodedTopicUri))
          }

          // Fire-and-forget: generate notifications for reply + mentions
          if (!spamResult.held) {
            notificationService
              .notifyOnReply({
                replyUri: pdsResult.uri,
                actorDid: user.did,
                topicUri: decodedTopicUri,
                parentUri: parentRefUri,
                communityDid: topic.communityDid,
              })
              .catch((err: unknown) => {
                app.log.error({ err, replyUri: pdsResult.uri }, 'Reply notification failed')
              })

            notificationService
              .notifyOnMentions({
                content,
                subjectUri: pdsResult.uri,
                actorDid: user.did,
                communityDid: topic.communityDid,
              })
              .catch((err: unknown) => {
                app.log.error({ err, replyUri: pdsResult.uri }, 'Mention notification failed')
              })

            // Fire-and-forget: record interaction graph edges
            app.interactionGraphService
              .recordReply(user.did, topic.authorDid, topic.communityDid)
              .catch((err: unknown) => {
                app.log.warn(
                  { err, replyUri: pdsResult.uri },
                  'Interaction graph recordReply failed'
                )
              })

            app.interactionGraphService
              .recordCoParticipation(decodedTopicUri, topic.communityDid)
              .catch((err: unknown) => {
                app.log.warn(
                  { err, topicUri: decodedTopicUri },
                  'Interaction graph recordCoParticipation failed'
                )
              })
          }

          return await reply.status(201).send({
            uri: pdsResult.uri,
            cid: pdsResult.cid,
            rkey,
            content,
            moderationStatus: contentModerationStatus,
            createdAt: now,
          })
        } catch (err: unknown) {
          if (err instanceof Error && 'statusCode' in err) throw err
          app.log.error({ err, did: user.did }, 'Failed to create reply')
          return sendError(reply, 500, 'Failed to save reply locally')
        }
      }
    )

    // -------------------------------------------------------------------
    // GET /api/topics/:topicUri/replies (public, optionalAuth)
    // -------------------------------------------------------------------

    app.get(
      '/api/topics/:topicUri/replies',
      {
        config: { rateLimit: { max: env.RATE_LIMIT_READ_ANON, timeWindow: '1 minute' } },
        preHandler: [authMiddleware.optionalAuth],
        schema: {
          tags: ['Replies'],
          summary: 'List replies for a topic with pagination',
          params: {
            type: 'object',
            required: ['topicUri'],
            properties: {
              topicUri: { type: 'string' },
            },
          },
          querystring: {
            type: 'object',
            properties: {
              cursor: { type: 'string' },
              limit: { type: 'string' },
              depth: { type: 'string' },
            },
          },
          response: {
            200: {
              type: 'object',
              properties: {
                replies: { type: 'array', items: replyJsonSchema },
                cursor: { type: ['string', 'null'] },
              },
            },
            400: errorResponseSchema,
            404: errorResponseSchema,
          },
        },
      },
      async (request, reply) => {
        const { topicUri } = request.params as { topicUri: string }
        const decodedTopicUri = decodeURIComponent(topicUri)

        const parsedQuery = replyQuerySchema.safeParse(request.query)
        if (!parsedQuery.success) {
          throw badRequest('Invalid query parameters')
        }

        // Check that the topic exists
        const topicRows = await db.select().from(topics).where(eq(topics.uri, decodedTopicUri))

        const topic = topicRows[0]
        if (!topic) {
          throw notFound('Topic not found')
        }

        // Maturity check: verify the topic's category is within the user's allowed level
        const communityDid = requireCommunityDid(request)
        const catRows = await db
          .select({ maturityRating: categories.maturityRating })
          .from(categories)
          .where(
            and(eq(categories.slug, topic.category), eq(categories.communityDid, communityDid))
          )

        if (catRows.length === 0) {
          app.log.warn(
            { category: topic.category, communityDid },
            'Category not found for maturity check, defaulting to safe'
          )
        }
        const categoryRating = catRows[0]?.maturityRating ?? 'safe'

        let userProfile: MaturityUser | undefined
        if (request.user) {
          const userRows = await db
            .select({ declaredAge: users.declaredAge, maturityPref: users.maturityPref })
            .from(users)
            .where(eq(users.did, request.user.did))
          const row = userRows[0]
          if (row) {
            userProfile = row
          }
        }

        // Fetch community age threshold
        const replySettingsRows = await db
          .select({ ageThreshold: communitySettings.ageThreshold })
          .from(communitySettings)
          .where(eq(communitySettings.communityDid, communityDid))
        const replyAgeThreshold = replySettingsRows[0]?.ageThreshold ?? 16

        const maxMaturity = resolveMaxMaturity(userProfile, replyAgeThreshold)
        if (!maturityAllows(maxMaturity, categoryRating)) {
          throw forbidden('Content restricted by maturity settings')
        }

        // Block/mute filtering: load the authenticated user's preferences
        const { blockedDids, mutedDids } = await loadBlockMuteLists(request.user?.did, db)

        const { cursor, limit, depth: maxDepth } = parsedQuery.data
        const conditions = [
          eq(replies.rootUri, decodedTopicUri),
          eq(replies.moderationStatus, 'approved'),
          sql`${replies.depth} <= ${maxDepth}`,
        ]

        // Exclude replies by blocked authors
        if (blockedDids.length > 0) {
          conditions.push(notInArray(replies.authorDid, blockedDids))
        }

        // Cursor-based pagination (ASC order for conversation flow)
        if (cursor) {
          const decoded = decodeCursor(cursor)
          if (decoded) {
            conditions.push(
              sql`(${replies.createdAt}, ${replies.uri}) > (${decoded.createdAt}::timestamptz, ${decoded.uri})`
            )
          }
        }

        const whereClause = and(...conditions)

        // Fetch limit + 1 to detect if there are more pages
        const fetchLimit = limit + 1
        const rows = await db
          .select()
          .from(replies)
          .where(whereClause)
          .orderBy(asc(replies.createdAt))
          .limit(fetchLimit)

        const hasMore = rows.length > limit
        const resultRows = hasMore ? rows.slice(0, limit) : rows
        const serialized = resultRows.map(serializeReply)

        // Query child counts for replies at the depth boundary
        const childCountResult = await db
          .select({
            parentUri: replies.parentUri,
            childCount: sql<number>`count(*)`.as('child_count'),
          })
          .from(replies)
          .where(
            and(
              eq(replies.rootUri, decodedTopicUri),
              sql`${replies.depth} = ${maxDepth + 1}`,
              eq(replies.moderationStatus, 'approved')
            )
          )
          .groupBy(replies.parentUri)

        const childCountMap = new Map(childCountResult.map((r) => [r.parentUri, r.childCount]))

        // Ozone label annotation: flag content from spam-labeled accounts
        const ozoneMap = new Map<string, string | null>()
        if (app.ozoneService) {
          const uniqueDids = [...new Set(serialized.map((r) => r.authorDid))]
          const spamMap = await app.ozoneService.batchIsSpamLabeled(uniqueDids)
          for (const [did, isSpam] of spamMap) {
            ozoneMap.set(did, isSpam ? 'spam' : null)
          }
        }

        // Batch-resolve author profiles
        const authorMap = await resolveAuthors(
          serialized.map((r) => r.authorDid),
          topic.communityDid,
          db
        )

        // Load muted words for content filtering
        const mutedWords = await loadMutedWords(request.user?.did, topic.communityDid, db)

        // Annotate muted authors and muted word matches (content still returned, just flagged)
        const mutedSet = new Set(mutedDids)
        const annotatedReplies = serialized.map((r) => ({
          ...r,
          author: authorMap.get(r.authorDid) ?? {
            did: r.authorDid,
            handle: r.authorDid,
            displayName: null,
            avatarUrl: null,
          },
          childCount: childCountMap.get(r.uri) ?? 0,
          isMuted: mutedSet.has(r.authorDid),
          isMutedWord: contentMatchesMutedWords(r.content, mutedWords),
          ozoneLabel: ozoneMap.get(r.authorDid) ?? null,
        }))

        let nextCursor: string | null = null
        if (hasMore) {
          const lastRow = resultRows[resultRows.length - 1]
          if (lastRow) {
            nextCursor = encodeCursor(lastRow.createdAt.toISOString(), lastRow.uri)
          }
        }

        return reply.status(200).send({
          replies: annotatedReplies,
          cursor: nextCursor,
        })
      }
    )

    // -------------------------------------------------------------------
    // GET /api/replies/by-author-rkey/:handle/:rkey (public, optionalAuth)
    // -------------------------------------------------------------------

    app.get(
      '/api/replies/by-author-rkey/:handle/:rkey',
      {
        preHandler: [authMiddleware.optionalAuth],
        schema: {
          tags: ['Replies'],
          summary: 'Get a single reply by author handle and rkey',
          params: {
            type: 'object',
            required: ['handle', 'rkey'],
            properties: {
              handle: { type: 'string' },
              rkey: { type: 'string' },
            },
          },
          response: {
            200: replyJsonSchema,
            404: errorResponseSchema,
          },
        },
      },
      async (request, reply) => {
        const { handle, rkey } = request.params as { handle: string; rkey: string }

        const did = await resolveHandleToDid(handle, db, app.log)
        if (!did) {
          throw notFound('User not found')
        }

        const rows = await db
          .select()
          .from(replies)
          .where(and(eq(replies.authorDid, did), eq(replies.rkey, rkey)))

        const row = rows[0]
        if (!row) {
          throw notFound('Reply not found')
        }

        const serialized = serializeReply(row)
        const communityDid = requireCommunityDid(request)
        const authorMap = await resolveAuthors([row.authorDid], communityDid, db)

        return reply.status(200).send({
          ...serialized,
          author: authorMap.get(row.authorDid) ?? {
            did: row.authorDid,
            handle: row.authorDid,
            displayName: null,
            avatarUrl: null,
          },
        })
      }
    )

    // -------------------------------------------------------------------
    // PUT /api/replies/:uri (auth required, author only)
    // -------------------------------------------------------------------

    app.put(
      '/api/replies/:uri',
      {
        preHandler: [authMiddleware.requireAuth],
        schema: {
          tags: ['Replies'],
          summary: 'Update a reply (author only)',
          security: [{ bearerAuth: [] }],
          params: {
            type: 'object',
            required: ['uri'],
            properties: {
              uri: { type: 'string' },
            },
          },
          body: {
            type: 'object',
            required: ['content'],
            properties: {
              content: { type: 'string', minLength: 1, maxLength: 50000 },
              labels: {
                type: 'object',
                properties: {
                  values: {
                    type: 'array',
                    items: {
                      type: 'object',
                      required: ['val'],
                      properties: { val: { type: 'string' } },
                    },
                  },
                },
              },
            },
          },
          response: {
            200: replyJsonSchema,
            400: errorResponseSchema,
            401: errorResponseSchema,
            403: errorResponseSchema,
            404: errorResponseSchema,
            500: errorResponseSchema,
            502: errorResponseSchema,
          },
        },
      },
      async (request, reply) => {
        const user = request.user
        if (!user) {
          return reply.status(401).send({ error: 'Authentication required' })
        }

        const parsed = updateReplySchema.safeParse(request.body)
        if (!parsed.success) {
          throw badRequest('Invalid update data')
        }

        const { uri } = request.params as { uri: string }
        const decodedUri = decodeURIComponent(uri)

        // Fetch existing reply
        const existing = await db.select().from(replies).where(eq(replies.uri, decodedUri))

        const replyRow = existing[0]
        if (!replyRow) {
          throw notFound('Reply not found')
        }

        // Author check
        if (replyRow.authorDid !== user.did) {
          throw forbidden('Not authorized to edit this reply')
        }

        const { content, labels } = parsed.data
        const rkey = extractRkey(decodedUri)

        // Resolve labels for PDS record: use provided value, or fall back to existing
        const resolvedLabels = labels !== undefined ? labels : (replyRow.labels ?? null)

        // Build updated record for PDS
        const updatedRecord: Record<string, unknown> = {
          content: { $type: 'forum.barazo.richtext#markdown', value: content },
          community: replyRow.communityDid,
          root: { uri: replyRow.rootUri, cid: replyRow.rootCid },
          parent: { uri: replyRow.parentUri, cid: replyRow.parentCid },
          createdAt: replyRow.createdAt.toISOString(),
          ...(resolvedLabels ? { labels: resolvedLabels } : {}),
        }

        // Update record on user's PDS
        let pdsResult: { uri: string; cid: string }
        try {
          pdsResult = await pdsClient.updateRecord(user.did, COLLECTION, rkey, updatedRecord)
        } catch (err: unknown) {
          if (err instanceof Error && 'statusCode' in err) throw err
          app.log.error({ err, uri: decodedUri }, 'PDS update failed for reply')
          return sendError(reply, 502, 'Failed to update record on remote PDS')
        }

        try {
          // Build DB update set
          const dbUpdates: Record<string, unknown> = {
            content,
            cid: pdsResult.cid,
            indexedAt: new Date(),
          }
          if (labels !== undefined) dbUpdates.labels = labels

          const updated = await db
            .update(replies)
            .set(dbUpdates)
            .where(eq(replies.uri, decodedUri))
            .returning()

          const updatedRow = updated[0]
          if (!updatedRow) {
            throw notFound('Reply not found after update')
          }

          return await reply.status(200).send(serializeReply(updatedRow))
        } catch (err: unknown) {
          if (err instanceof Error && 'statusCode' in err) throw err
          app.log.error({ err, uri: decodedUri }, 'Failed to update reply')
          return sendError(reply, 500, 'Failed to save reply update locally')
        }
      }
    )

    // -------------------------------------------------------------------
    // DELETE /api/replies/:uri (auth required, author or moderator)
    // -------------------------------------------------------------------

    app.delete(
      '/api/replies/:uri',
      {
        preHandler: [authMiddleware.requireAuth],
        schema: {
          tags: ['Replies'],
          summary: 'Delete a reply (author or moderator)',
          security: [{ bearerAuth: [] }],
          params: {
            type: 'object',
            required: ['uri'],
            properties: {
              uri: { type: 'string' },
            },
          },
          response: {
            204: { type: 'null' },
            401: errorResponseSchema,
            403: errorResponseSchema,
            404: errorResponseSchema,
            500: errorResponseSchema,
            502: errorResponseSchema,
          },
        },
      },
      async (request, reply) => {
        const user = request.user
        if (!user) {
          return reply.status(401).send({ error: 'Authentication required' })
        }

        const { uri } = request.params as { uri: string }
        const decodedUri = decodeURIComponent(uri)

        // Fetch existing reply
        const existing = await db.select().from(replies).where(eq(replies.uri, decodedUri))

        const replyRow = existing[0]
        if (!replyRow) {
          throw notFound('Reply not found')
        }

        const isAuthor = replyRow.authorDid === user.did

        // Check if user is a moderator or admin
        let isMod = false
        if (!isAuthor) {
          const userRows = await db.select().from(users).where(eq(users.did, user.did))

          const userRow = userRows[0]
          isMod = userRow?.role === 'moderator' || userRow?.role === 'admin'
        }

        if (!isAuthor && !isMod) {
          throw forbidden('Not authorized to delete this reply')
        }

        // Author: delete from PDS; moderator: skip PDS deletion
        if (isAuthor) {
          const rkey = extractRkey(decodedUri)
          try {
            await pdsClient.deleteRecord(user.did, COLLECTION, rkey)
          } catch (err: unknown) {
            if (err instanceof Error && 'statusCode' in err) throw err
            app.log.error({ err, uri: decodedUri }, 'PDS delete failed for reply')
            return sendError(reply, 502, 'Failed to delete record from remote PDS')
          }
        }

        try {
          // Soft-delete reply and update topic replyCount in a transaction
          await db.transaction(async (tx) => {
            await tx
              .update(replies)
              .set({ isAuthorDeleted: true })
              .where(eq(replies.uri, decodedUri))
            await tx
              .update(topics)
              .set({
                replyCount: sql`GREATEST(${topics.replyCount} - 1, 0)`,
              })
              .where(eq(topics.uri, replyRow.rootUri))
          })

          return await reply.status(204).send()
        } catch (err: unknown) {
          if (err instanceof Error && 'statusCode' in err) throw err
          app.log.error({ err, uri: decodedUri }, 'Failed to delete reply')
          return sendError(reply, 500, 'Failed to delete reply locally')
        }
      }
    )

    done()
  }
}
