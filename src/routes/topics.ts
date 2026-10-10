import { eq, and, asc, desc, sql, inArray, notInArray, isNotNull, ne, or } from 'drizzle-orm'
import { createHash } from 'node:crypto'
import { requireCommunityDid } from '../middleware/community-resolver.js'
import type { FastifyPluginCallback } from 'fastify'
import type { Database } from '../db/index.js'
import type { Cache } from '../cache/index.js'
import { createPdsClient } from '../lib/pds-client.js'
import {
  notFound,
  forbidden,
  badRequest,
  errorResponseSchema,
  sendError,
} from '../lib/api-errors.js'
import { resolveMaxMaturity, allowedRatings, maturityAllows } from '../lib/content-filter.js'
import type { MaturityUser } from '../lib/content-filter.js'
import { createTopicSchema, updateTopicSchema, topicQuerySchema } from '../validation/topics.js'
import { createCrossPostService } from '../services/cross-post.js'
import { loadBlockMuteLists } from '../lib/block-mute.js'
import { loadMutedWords, contentMatchesMutedWords } from '../lib/muted-words.js'
import { resolveAuthors } from '../lib/resolve-authors.js'
import {
  runAntiSpamChecks,
  loadAntiSpamSettings,
  isNewAccount,
  isAccountTrusted,
  checkWriteRateLimit,
  canCreateTopic,
} from '../lib/anti-spam.js'
import { tooManyRequests } from '../lib/api-errors.js'
import { moderationQueue } from '../db/schema/moderation-queue.js'
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

const COLLECTION = 'forum.barazo.topic.post'

// ---------------------------------------------------------------------------
// OpenAPI JSON Schema definitions
// ---------------------------------------------------------------------------

const topicJsonSchema = {
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
    title: { type: 'string' as const },
    content: { type: 'string' as const },
    category: { type: 'string' as const },
    site: { type: ['string', 'null'] as const },
    tags: { type: ['array', 'null'] as const, items: { type: 'string' as const } },
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
    replyCount: { type: 'integer' as const },
    reactionCount: { type: 'integer' as const },
    viewCount: { type: 'integer' as const },
    isMuted: { type: 'boolean' as const },
    isMutedWord: { type: 'boolean' as const },
    ozoneLabel: { type: ['string', 'null'] as const },
    isPinned: { type: 'boolean' as const },
    isLocked: { type: 'boolean' as const },
    pinnedScope: { type: ['string', 'null'] as const },
    pinnedAt: { type: ['string', 'null'] as const, format: 'date-time' as const },
    categoryMaturityRating: { type: 'string' as const, enum: ['safe', 'mature', 'adult'] },
    lastActivityAt: { type: 'string' as const, format: 'date-time' as const },
    publishedAt: { type: 'string' as const, format: 'date-time' as const },
    indexedAt: { type: 'string' as const, format: 'date-time' as const },
  },
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Serialize a topic row from the DB into a JSON-safe response object.
 * Converts Date fields to ISO strings.
 * @param categoryMaturityRating - The maturity rating inherited from the topic's category.
 */
function serializeTopic(row: typeof topics.$inferSelect, categoryMaturityRating: string = 'safe') {
  const isDeleted = row.isAuthorDeleted || row.isModDeleted
  const placeholderTitle = row.isModDeleted
    ? '[Removed by moderator]'
    : row.isAuthorDeleted
      ? '[Deleted by author]'
      : row.title
  return {
    uri: row.uri,
    rkey: row.rkey,
    authorDid: row.authorDid,
    title: placeholderTitle,
    content: isDeleted ? '' : row.content,
    category: row.category,
    site: row.site ?? null,
    tags: row.tags ?? null,
    labels: row.labels ?? null,
    communityDid: row.communityDid,
    cid: row.cid,
    replyCount: row.replyCount,
    reactionCount: row.reactionCount,
    viewCount: row.viewCount,
    isAuthorDeleted: row.isAuthorDeleted,
    isModDeleted: row.isModDeleted,
    isPinned: row.isPinned,
    isLocked: row.isLocked,
    pinnedScope: row.pinnedScope ?? null,
    pinnedAt: row.pinnedAt?.toISOString() ?? null,
    categoryMaturityRating,
    lastActivityAt: row.lastActivityAt.toISOString(),
    publishedAt: row.publishedAt.toISOString(),
    indexedAt: row.indexedAt.toISOString(),
  }
}

/**
 * Encode a pagination cursor from lastActivityAt + uri.
 */
function encodeCursor(lastActivityAt: string, uri: string): string {
  return Buffer.from(JSON.stringify({ lastActivityAt, uri })).toString('base64')
}

/**
 * Decode a pagination cursor. Returns null if invalid.
 */
function decodeCursor(cursor: string): { lastActivityAt: string; uri: string } | null {
  try {
    const decoded = JSON.parse(Buffer.from(cursor, 'base64').toString('utf-8')) as Record<
      string,
      unknown
    >
    if (typeof decoded.lastActivityAt === 'string' && typeof decoded.uri === 'string') {
      return { lastActivityAt: decoded.lastActivityAt, uri: decoded.uri }
    }
    return null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// View count helper
// ---------------------------------------------------------------------------

const VIEW_COUNT_TTL_SECONDS = 60

/**
 * Increment the view count for a topic if the request IP has not already
 * been counted within the deduplication window (~60 s).
 * Silently skips on any cache error to avoid blocking the response.
 */
async function incrementViewCount(
  db: Database,
  cache: Cache,
  topicUri: string,
  requestIp: string
): Promise<void> {
  try {
    const dedupKey = `viewcount:dedup:${createHash('sha256')
      .update(requestIp + topicUri)
      .digest('hex')}`
    const existing = await cache.get(dedupKey)
    if (!existing) {
      await cache.set(dedupKey, '1', 'EX', VIEW_COUNT_TTL_SECONDS)
      await db
        .update(topics)
        .set({ viewCount: sql`view_count + 1` })
        .where(eq(topics.uri, topicUri))
    }
  } catch {
    // Cache unavailable or DB error — skip silently; view count is best-effort
  }
}

// ---------------------------------------------------------------------------
// Topic routes plugin
// ---------------------------------------------------------------------------

/**
 * Topic routes for the Barazo forum.
 *
 * - POST   /api/topics          -- Create a new topic
 * - GET    /api/topics           -- List topics (paginated)
 * - GET    /api/topics/:uri      -- Get a single topic
 * - PUT    /api/topics/:uri      -- Update a topic
 * - DELETE /api/topics/:uri      -- Delete a topic
 */
export function topicRoutes(): FastifyPluginCallback {
  return (app, _opts, done) => {
    const { db, env, authMiddleware, firehose } = app
    const pdsClient = createPdsClient(app.oauthClient, app.log)
    const notificationService = createNotificationService(db, app.log)
    const crossPostService = createCrossPostService(
      pdsClient,
      db,
      app.log,
      {
        blueskyEnabled: env.FEATURE_CROSSPOST_BLUESKY,
        frontpageEnabled: env.FEATURE_CROSSPOST_FRONTPAGE,
        publicUrl: env.PUBLIC_URL,
        communityName: env.COMMUNITY_NAME,
      },
      notificationService
    )

    // -------------------------------------------------------------------
    // POST /api/topics (auth required)
    // -------------------------------------------------------------------

    app.post(
      '/api/topics',
      {
        preHandler: [authMiddleware.requireAuth],
        schema: {
          tags: ['Topics'],
          summary: 'Create a new topic',
          security: [{ bearerAuth: [] }],
          body: {
            type: 'object',
            required: ['title', 'content', 'category'],
            properties: {
              title: { type: 'string', minLength: 1, maxLength: 200 },
              content: { type: 'string', minLength: 1, maxLength: 100000 },
              category: { type: 'string', minLength: 1 },
              tags: {
                type: 'array',
                items: { type: 'string', minLength: 1, maxLength: 30 },
                maxItems: 5,
              },
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
                title: { type: 'string' },
                category: { type: 'string' },
                authorHandle: { type: 'string' },
                moderationStatus: { type: 'string', enum: ['approved', 'held', 'rejected'] },
                publishedAt: { type: 'string', format: 'date-time' },
              },
            },
            400: errorResponseSchema,
            401: errorResponseSchema,
            403: errorResponseSchema,
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

        const parsed = createTopicSchema.safeParse(request.body)
        if (!parsed.success) {
          throw badRequest('Invalid topic data')
        }

        const { title, content, category, tags, labels } = parsed.data
        const now = new Date().toISOString()
        const communityDid = requireCommunityDid(request)

        // Onboarding gate: block if user hasn't completed mandatory onboarding
        const onboarding = await checkOnboardingComplete(db, user.did, communityDid)
        if (!onboarding.complete) {
          return reply.status(403).send({
            error: 'Onboarding required',
            fields: onboarding.missingFields,
          })
        }

        // Maturity check: verify user can post in this category
        const catRows = await db
          .select({ maturityRating: categories.maturityRating })
          .from(categories)
          .where(and(eq(categories.slug, category), eq(categories.communityDid, communityDid)))

        const categoryRating = catRows[0]?.maturityRating ?? 'safe'

        const userRows = await db
          .select({ declaredAge: users.declaredAge, maturityPref: users.maturityPref })
          .from(users)
          .where(eq(users.did, user.did))
        const userProfile: MaturityUser | undefined = userRows[0] ?? undefined

        // Fetch community age threshold
        const settingsRows = await db
          .select({ ageThreshold: communitySettings.ageThreshold })
          .from(communitySettings)
          .where(eq(communitySettings.communityDid, communityDid))
        const ageThreshold = settingsRows[0]?.ageThreshold ?? 16

        const maxMaturity = resolveMaxMaturity(userProfile, ageThreshold)
        if (!maturityAllows(maxMaturity, categoryRating)) {
          throw forbidden('Content restricted by maturity settings')
        }

        // Ozone label check: spam-labeled accounts get stricter rate limits
        let ozoneSpamLabeled = false
        if (app.ozoneService) {
          ozoneSpamLabeled = await app.ozoneService.isSpamLabeled(user.did)
        }

        // Anti-spam checks
        const antiSpamSettings = await loadAntiSpamSettings(db, app.cache, communityDid)
        const trusted =
          !ozoneSpamLabeled &&
          (await isAccountTrusted(
            db,
            user.did,
            communityDid,
            antiSpamSettings.trustedPostThreshold
          ))

        if (!trusted) {
          // Ozone spam-labeled accounts are always treated as new (stricter rate limits)
          const isNew =
            ozoneSpamLabeled ||
            (await isNewAccount(db, user.did, communityDid, antiSpamSettings.newAccountDays))

          // Write rate limit
          const rateLimited = await checkWriteRateLimit(
            app.cache,
            user.did,
            communityDid,
            isNew,
            antiSpamSettings
          )
          if (rateLimited) {
            throw tooManyRequests('Write rate limit exceeded. Please try again later.')
          }

          // Topic creation delay: new accounts need at least one approved reply
          if (antiSpamSettings.topicCreationDelayEnabled) {
            const canPost = await canCreateTopic(db, user.did, communityDid, true)
            if (!canPost) {
              throw forbidden(
                'New accounts must have at least one approved reply before creating topics'
              )
            }
          }
        }

        // Content-level anti-spam checks (word filter, first-post queue, link hold, burst)
        const spamResult = await runAntiSpamChecks(db, app.cache, {
          authorDid: user.did,
          communityDid,
          contentType: 'topic',
          title,
          content,
        })

        // Build AT Protocol record
        const record: Record<string, unknown> = {
          title,
          content: { $type: 'forum.barazo.richtext#markdown', value: content },
          category,
          tags: tags ?? [],
          community: communityDid,
          publishedAt: now,
          ...(labels ? { labels } : {}),
        }

        // Write record to user's PDS
        let pdsResult: { uri: string; cid: string }
        try {
          pdsResult = await pdsClient.createRecord(user.did, COLLECTION, record)
        } catch (err: unknown) {
          if (err instanceof Error && 'statusCode' in err) throw err
          app.log.error({ err, did: user.did }, 'PDS write failed for topic creation')
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

          // Insert into local DB optimistically (don't wait for firehose)
          const contentModerationStatus = spamResult.held ? 'held' : 'approved'
          await db
            .insert(topics)
            .values({
              uri: pdsResult.uri,
              rkey,
              authorDid: user.did,
              title,
              content,
              category,
              tags: tags ?? [],
              labels: labels ?? null,
              communityDid,
              cid: pdsResult.cid,
              replyCount: 0,
              reactionCount: 0,
              moderationStatus: contentModerationStatus,
              lastActivityAt: new Date(now),
              publishedAt: new Date(now),
              indexedAt: new Date(),
            })
            .onConflictDoUpdate({
              target: topics.uri,
              set: {
                title,
                content,
                category,
                tags: tags ?? [],
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
              contentType: 'topic' as const,
              authorDid: user.did,
              communityDid,
              queueReason: r.reason,
              matchedWords: r.matchedWords ?? null,
            }))
            await db.insert(moderationQueue).values(queueEntries)

            app.log.info(
              {
                topicUri: pdsResult.uri,
                reasons: spamResult.reasons.map((r) => r.reason),
                authorDid: user.did,
              },
              'Topic held for moderation'
            )
          }

          // Fire cross-posting in background (fire-and-forget, does not block response)
          // Only cross-post if content is approved (not held)
          if (
            !spamResult.held &&
            (env.FEATURE_CROSSPOST_BLUESKY || env.FEATURE_CROSSPOST_FRONTPAGE)
          ) {
            crossPostService
              .crossPostTopic({
                did: user.did,
                handle: user.handle,
                topicUri: pdsResult.uri,
                title,
                content,
                category,
                communityDid,
              })
              .catch((err: unknown) => {
                app.log.error({ err, topicUri: pdsResult.uri }, 'Cross-posting failed')
              })
          }

          // Fire-and-forget: generate mention notifications from topic content
          if (!spamResult.held) {
            notificationService
              .notifyOnMentions({
                content,
                subjectUri: pdsResult.uri,
                actorDid: user.did,
                communityDid,
              })
              .catch((err: unknown) => {
                app.log.error({ err, topicUri: pdsResult.uri }, 'Mention notification failed')
              })
          }

          return await reply.status(201).send({
            uri: pdsResult.uri,
            cid: pdsResult.cid,
            rkey,
            title,
            category,
            authorHandle: user.handle,
            moderationStatus: contentModerationStatus,
            publishedAt: now,
          })
        } catch (err: unknown) {
          if (err instanceof Error && 'statusCode' in err) throw err
          app.log.error({ err, did: user.did }, 'Failed to create topic')
          return sendError(reply, 500, 'Failed to save topic locally')
        }
      }
    )

    // -------------------------------------------------------------------
    // GET /api/topics (public, optionalAuth)
    // -------------------------------------------------------------------

    app.get(
      '/api/topics',
      {
        config: { rateLimit: { max: env.RATE_LIMIT_READ_ANON, timeWindow: '1 minute' } },
        preHandler: [authMiddleware.optionalAuth],
        schema: {
          tags: ['Topics'],
          summary: 'List topics with pagination',
          querystring: {
            type: 'object',
            properties: {
              cursor: { type: 'string' },
              limit: { type: 'string' },
              category: { type: 'string' },
              tag: { type: 'string' },
              sort: { type: 'string', enum: ['latest', 'popular'] },
            },
          },
          response: {
            200: {
              type: 'object',
              properties: {
                topics: { type: 'array', items: topicJsonSchema },
                cursor: { type: ['string', 'null'] },
              },
            },
            400: errorResponseSchema,
          },
        },
      },
      async (request, reply) => {
        const parsed = topicQuerySchema.safeParse(request.query)
        if (!parsed.success) {
          throw badRequest('Invalid query parameters')
        }

        const { cursor, limit, category, tag, sort } = parsed.data
        const conditions = []

        // Maturity filtering: resolve user's max allowed maturity level
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

        // Fetch community age threshold (use request.communityDid if available, else default)
        let listAgeThreshold = 16
        if (request.communityDid) {
          const settingsRowsList = await db
            .select({ ageThreshold: communitySettings.ageThreshold })
            .from(communitySettings)
            .where(eq(communitySettings.communityDid, request.communityDid))
          listAgeThreshold = settingsRowsList[0]?.ageThreshold ?? 16
        }

        const maxMaturity = resolveMaxMaturity(userProfile, listAgeThreshold)
        const allowed = allowedRatings(maxMaturity)

        // Slug→maturityRating lookup, populated by the category queries below
        const categoryMaturityMap = new Map<string, string>()

        if (env.COMMUNITY_MODE === 'multi') {
          // ---------------------------------------------------------------
          // Multi mode: multi-community filtering
          // ---------------------------------------------------------------

          // Get all community settings with a valid communityDid
          const communityRows = await db
            .select({
              communityDid: communitySettings.communityDid,
              maturityRating: communitySettings.maturityRating,
            })
            .from(communitySettings)
            .where(isNotNull(communitySettings.communityDid))

          // Filter: NEVER show adult communities in global mode,
          // check mature communities against user's max maturity preference
          const allowedCommunityDids = communityRows
            .filter(
              (c): c is typeof c & { communityDid: string } =>
                !!c.communityDid &&
                c.maturityRating !== 'adult' &&
                maturityAllows(maxMaturity, c.maturityRating)
            )
            .map((c) => c.communityDid)

          if (allowedCommunityDids.length === 0) {
            return reply.status(200).send({ topics: [], cursor: null })
          }

          // Restrict topics to allowed communities
          conditions.push(inArray(topics.communityDid, allowedCommunityDids))

          // Also filter by category maturity across all allowed communities
          const allowedCats = await db
            .select({ slug: categories.slug, maturityRating: categories.maturityRating })
            .from(categories)
            .where(
              and(
                inArray(categories.communityDid, allowedCommunityDids),
                inArray(categories.maturityRating, allowed)
              )
            )

          const allowedSlugs = [...new Set(allowedCats.map((c) => c.slug))]
          // Build slug→maturityRating lookup for serialization
          for (const cat of allowedCats) {
            categoryMaturityMap.set(cat.slug, cat.maturityRating)
          }
          if (allowedSlugs.length === 0) {
            return reply.status(200).send({ topics: [], cursor: null })
          }
          conditions.push(inArray(topics.category, allowedSlugs))

          // Exclude content from accounts < 24h old in global aggregator feeds.
          // Uses a query-time check so trust auto-upgrades after 24h without a cron job:
          // exclude WHERE trust_status = 'new' AND author's account_created_at > now() - 24h.
          // Content from new accounts remains visible in specific community feeds (single mode).
          conditions.push(
            or(
              ne(topics.trustStatus, 'new'),
              sql`NOT EXISTS (
              SELECT 1 FROM users u
              WHERE u.did = ${topics.authorDid}
              AND u.account_created_at > NOW() - INTERVAL '24 hours'
            )`
            )
          )
        } else {
          // ---------------------------------------------------------------
          // Single mode: filter by the one configured community
          // ---------------------------------------------------------------

          const communityDid = requireCommunityDid(request)

          // Get category slugs matching allowed maturity levels
          const allowedCategories = await db
            .select({ slug: categories.slug, maturityRating: categories.maturityRating })
            .from(categories)
            .where(
              and(
                eq(categories.communityDid, communityDid),
                inArray(categories.maturityRating, allowed)
              )
            )

          const allowedSlugs = allowedCategories.map((c) => c.slug)
          // Build slug→maturityRating lookup for serialization
          for (const cat of allowedCategories) {
            categoryMaturityMap.set(cat.slug, cat.maturityRating)
          }

          // If no categories are allowed, return empty result
          if (allowedSlugs.length === 0) {
            return reply.status(200).send({ topics: [], cursor: null })
          }

          // Filter topics to only those in allowed categories
          conditions.push(inArray(topics.category, allowedSlugs))
        }

        // Only show approved, non-deleted content in public listings
        conditions.push(eq(topics.moderationStatus, 'approved'))
        conditions.push(eq(topics.isAuthorDeleted, false))

        // Block/mute filtering: load the authenticated user's preferences
        const { blockedDids, mutedDids } = await loadBlockMuteLists(request.user?.did, db)

        // Exclude topics by blocked authors
        if (blockedDids.length > 0) {
          conditions.push(notInArray(topics.authorDid, blockedDids))
        }

        // Category filter (explicit user filter, further narrows results)
        if (category) {
          conditions.push(eq(topics.category, category))
        }

        // Tag filter (jsonb contains)
        if (tag) {
          conditions.push(sql`${topics.tags} @> ${JSON.stringify([tag])}::jsonb`)
        }

        // Cursor-based pagination (only for 'latest' sort; popular uses score ranking)
        if (sort !== 'popular' && cursor) {
          const decoded = decodeCursor(cursor)
          if (decoded) {
            conditions.push(
              sql`(${topics.lastActivityAt}, ${topics.uri}) < (${decoded.lastActivityAt}::timestamptz, ${decoded.uri})`
            )
          }
        }

        const whereClause = conditions.length > 0 ? and(...conditions) : undefined

        // Fetch limit + 1 to detect if there are more pages
        const fetchLimit = limit + 1

        // Time-decay popularity score:
        //   score = (reply_count + reaction_count * 0.3) / (age_in_hours + 2) ^ 1.2
        const popularityScore = sql`(${topics.replyCount} + ${topics.reactionCount} * 0.3) / POWER(EXTRACT(EPOCH FROM (NOW() - ${topics.publishedAt})) / 3600.0 + 2, 1.2)`

        // Pinned-first ordering: when browsing a category, both category-pinned
        // and forum-pinned topics float to the top. On the homepage (no category
        // filter), only forum-pinned topics get promoted.
        const pinnedFirst = category
          ? sql`CASE WHEN ${topics.pinnedScope} IS NOT NULL THEN 0 ELSE 1 END`
          : sql`CASE WHEN ${topics.pinnedScope} = 'forum' THEN 0 ELSE 1 END`

        const rows = await db
          .select()
          .from(topics)
          .where(whereClause)
          .orderBy(
            asc(pinnedFirst),
            sort === 'popular' ? desc(popularityScore) : desc(topics.lastActivityAt)
          )
          .limit(fetchLimit)

        const hasMore = rows.length > limit
        const resultRows = hasMore ? rows.slice(0, limit) : rows
        const serialized = resultRows.map((row) =>
          serializeTopic(row, categoryMaturityMap.get(row.category) ?? 'safe')
        )

        // Ozone label annotation: flag content from spam-labeled accounts
        const ozoneMap = new Map<string, string | null>()
        if (app.ozoneService) {
          const uniqueDids = [...new Set(serialized.map((t) => t.authorDid))]
          const spamMap = await app.ozoneService.batchIsSpamLabeled(uniqueDids)
          for (const [did, isSpam] of spamMap) {
            ozoneMap.set(did, isSpam ? 'spam' : null)
          }
        }

        // Load muted words for content filtering
        const communityDid = requireCommunityDid(request)
        const mutedWords = await loadMutedWords(request.user?.did, communityDid, db)

        // Batch-resolve author profiles
        const authorMap = await resolveAuthors(
          serialized.map((t) => t.authorDid),
          communityDid,
          db
        )

        // Annotate muted authors and muted word matches (content still returned, just flagged)
        const mutedSet = new Set(mutedDids)
        const annotatedTopics = serialized.map((t) => ({
          ...t,
          author: authorMap.get(t.authorDid) ?? {
            did: t.authorDid,
            handle: t.authorDid,
            displayName: null,
            avatarUrl: null,
          },
          isMuted: mutedSet.has(t.authorDid),
          isMutedWord: contentMatchesMutedWords(t.content, mutedWords, t.title),
          ozoneLabel: ozoneMap.get(t.authorDid) ?? null,
        }))

        let nextCursor: string | null = null
        if (hasMore && sort !== 'popular') {
          const lastRow = resultRows[resultRows.length - 1]
          if (lastRow) {
            nextCursor = encodeCursor(lastRow.lastActivityAt.toISOString(), lastRow.uri)
          }
        }

        return reply.status(200).send({
          topics: annotatedTopics,
          cursor: nextCursor,
        })
      }
    )

    // -------------------------------------------------------------------
    // GET /api/topics/by-rkey/:rkey (public, no auth)
    // -------------------------------------------------------------------

    app.get(
      '/api/topics/by-rkey/:rkey',
      {
        preHandler: [authMiddleware.optionalAuth],
        schema: {
          tags: ['Topics'],
          summary: 'Get a single topic by rkey (for SEO/metadata)',
          params: {
            type: 'object',
            required: ['rkey'],
            properties: {
              rkey: { type: 'string' },
            },
          },
          response: {
            200: topicJsonSchema,
            403: errorResponseSchema,
            404: errorResponseSchema,
          },
        },
      },
      async (request, reply) => {
        const { rkey } = request.params as { rkey: string }

        const rows = await db.select().from(topics).where(eq(topics.rkey, rkey))

        const row = rows[0]
        if (!row) {
          throw notFound('Topic not found')
        }

        // Look up the category maturity rating
        const communityDid = requireCommunityDid(request)
        const catRows = await db
          .select({ maturityRating: categories.maturityRating })
          .from(categories)
          .where(and(eq(categories.slug, row.category), eq(categories.communityDid, communityDid)))
        const categoryRating = catRows[0]?.maturityRating ?? 'safe'

        // Maturity check: verify the topic's category is within the user's allowed level
        let userProfile: MaturityUser | undefined
        if (request.user) {
          const userRows = await db
            .select({ declaredAge: users.declaredAge, maturityPref: users.maturityPref })
            .from(users)
            .where(eq(users.did, request.user.did))
          userProfile = userRows[0] ?? undefined
        }

        const rkeySettingsRows = await db
          .select({ ageThreshold: communitySettings.ageThreshold })
          .from(communitySettings)
          .where(eq(communitySettings.communityDid, communityDid))
        const rkeyAgeThreshold = rkeySettingsRows[0]?.ageThreshold ?? 16

        const maxMaturity = resolveMaxMaturity(userProfile, rkeyAgeThreshold)
        if (!maturityAllows(maxMaturity, categoryRating)) {
          throw forbidden('Content restricted by maturity settings')
        }

        const serialized = serializeTopic(row, categoryRating)
        const authorMap = await resolveAuthors([row.authorDid], communityDid, db)

        await incrementViewCount(db, app.cache, row.uri, request.ip)

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
    // GET /api/topics/by-author-rkey/:handle/:rkey (public, optionalAuth)
    // -------------------------------------------------------------------

    app.get(
      '/api/topics/by-author-rkey/:handle/:rkey',
      {
        preHandler: [authMiddleware.optionalAuth],
        schema: {
          tags: ['Topics'],
          summary: 'Get a single topic by author handle and rkey',
          params: {
            type: 'object',
            required: ['handle', 'rkey'],
            properties: {
              handle: { type: 'string' },
              rkey: { type: 'string' },
            },
          },
          response: {
            200: topicJsonSchema,
            403: errorResponseSchema,
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
          .from(topics)
          .where(and(eq(topics.authorDid, did), eq(topics.rkey, rkey)))

        const row = rows[0]
        if (!row) {
          throw notFound('Topic not found')
        }

        const communityDid = requireCommunityDid(request)
        const catRows = await db
          .select({ maturityRating: categories.maturityRating })
          .from(categories)
          .where(and(eq(categories.slug, row.category), eq(categories.communityDid, communityDid)))
        const categoryRating = catRows[0]?.maturityRating ?? 'safe'

        let userProfile: MaturityUser | undefined
        if (request.user) {
          const userRows = await db
            .select({ declaredAge: users.declaredAge, maturityPref: users.maturityPref })
            .from(users)
            .where(eq(users.did, request.user.did))
          userProfile = userRows[0] ?? undefined
        }

        const authorRkeySettingsRows = await db
          .select({ ageThreshold: communitySettings.ageThreshold })
          .from(communitySettings)
          .where(eq(communitySettings.communityDid, communityDid))
        const authorRkeyAgeThreshold = authorRkeySettingsRows[0]?.ageThreshold ?? 16

        const maxMaturity = resolveMaxMaturity(userProfile, authorRkeyAgeThreshold)
        if (!maturityAllows(maxMaturity, categoryRating)) {
          throw forbidden('Content restricted by maturity settings')
        }

        const serialized = serializeTopic(row, categoryRating)
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
    // GET /api/topics/:uri (public, optionalAuth)
    // -------------------------------------------------------------------

    app.get(
      '/api/topics/:uri',
      {
        preHandler: [authMiddleware.optionalAuth],
        schema: {
          tags: ['Topics'],
          summary: 'Get a single topic by AT URI',
          params: {
            type: 'object',
            required: ['uri'],
            properties: {
              uri: { type: 'string' },
            },
          },
          response: {
            200: topicJsonSchema,
            403: errorResponseSchema,
            404: errorResponseSchema,
          },
        },
      },
      async (request, reply) => {
        const { uri } = request.params as { uri: string }
        const decodedUri = decodeURIComponent(uri)

        const rows = await db.select().from(topics).where(eq(topics.uri, decodedUri))

        const row = rows[0]
        if (!row) {
          throw notFound('Topic not found')
        }

        // Maturity check: verify the topic's category is within the user's allowed level
        const communityDid = requireCommunityDid(request)
        const catRows = await db
          .select({ maturityRating: categories.maturityRating })
          .from(categories)
          .where(and(eq(categories.slug, row.category), eq(categories.communityDid, communityDid)))

        if (catRows.length === 0) {
          app.log.warn(
            { category: row.category, communityDid },
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
          userProfile = userRows[0] ?? undefined
        }

        // Fetch community age threshold
        const singleSettingsRows = await db
          .select({ ageThreshold: communitySettings.ageThreshold })
          .from(communitySettings)
          .where(eq(communitySettings.communityDid, communityDid))
        const singleAgeThreshold = singleSettingsRows[0]?.ageThreshold ?? 16

        const maxMaturity = resolveMaxMaturity(userProfile, singleAgeThreshold)
        if (!maturityAllows(maxMaturity, categoryRating)) {
          throw forbidden('Content restricted by maturity settings')
        }

        const serialized = serializeTopic(row, categoryRating)
        const authorMap = await resolveAuthors([row.authorDid], communityDid, db)

        await incrementViewCount(db, app.cache, decodedUri, request.ip)

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
    // PUT /api/topics/:uri (auth required, author only)
    // -------------------------------------------------------------------

    app.put(
      '/api/topics/:uri',
      {
        preHandler: [authMiddleware.requireAuth],
        schema: {
          tags: ['Topics'],
          summary: 'Update a topic (author only)',
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
            properties: {
              title: { type: 'string', minLength: 1, maxLength: 200 },
              content: { type: 'string', minLength: 1, maxLength: 100000 },
              category: { type: 'string', minLength: 1 },
              tags: {
                type: 'array',
                items: { type: 'string', minLength: 1, maxLength: 30 },
                maxItems: 5,
              },
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
            200: topicJsonSchema,
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

        const parsed = updateTopicSchema.safeParse(request.body)
        if (!parsed.success) {
          throw badRequest('Invalid update data')
        }

        const { uri } = request.params as { uri: string }
        const decodedUri = decodeURIComponent(uri)

        // Fetch existing topic
        const existing = await db.select().from(topics).where(eq(topics.uri, decodedUri))

        const topic = existing[0]
        if (!topic) {
          throw notFound('Topic not found')
        }

        // Author check
        if (topic.authorDid !== user.did) {
          throw forbidden('Not authorized to edit this topic')
        }

        const updates = parsed.data
        const rkey = extractRkey(decodedUri)

        // Resolve labels for PDS record: use provided value, or fall back to existing
        const resolvedLabels =
          updates.labels !== undefined ? (updates.labels ?? null) : (topic.labels ?? null)

        // Build updated record for PDS
        const updatedRecord: Record<string, unknown> = {
          title: updates.title ?? topic.title,
          content: {
            $type: 'forum.barazo.richtext#markdown',
            value: updates.content ?? topic.content,
          },
          category: updates.category ?? topic.category,
          tags: updates.tags ?? topic.tags ?? [],
          community: topic.communityDid,
          publishedAt: topic.publishedAt.toISOString(),
          ...(topic.site ? { site: topic.site } : {}),
          ...(resolvedLabels ? { labels: resolvedLabels } : {}),
        }

        // Update record on user's PDS
        let pdsResult: { uri: string; cid: string }
        try {
          pdsResult = await pdsClient.updateRecord(user.did, COLLECTION, rkey, updatedRecord)
        } catch (err: unknown) {
          if (err instanceof Error && 'statusCode' in err) throw err
          app.log.error({ err, uri: decodedUri }, 'PDS update failed for topic')
          return sendError(reply, 502, 'Failed to update record on remote PDS')
        }

        try {
          // Build DB update set
          const dbUpdates: Record<string, unknown> = {
            cid: pdsResult.cid,
            indexedAt: new Date(),
          }
          if (updates.title !== undefined) dbUpdates.title = updates.title
          if (updates.content !== undefined) dbUpdates.content = updates.content
          if (updates.category !== undefined) dbUpdates.category = updates.category
          if (updates.tags !== undefined) dbUpdates.tags = updates.tags
          if (updates.labels !== undefined) dbUpdates.labels = updates.labels ?? null

          const updated = await db
            .update(topics)
            .set(dbUpdates)
            .where(eq(topics.uri, decodedUri))
            .returning()

          const updatedRow = updated[0]
          if (!updatedRow) {
            throw notFound('Topic not found after update')
          }

          return await reply.status(200).send(serializeTopic(updatedRow))
        } catch (err: unknown) {
          if (err instanceof Error && 'statusCode' in err) throw err
          app.log.error({ err, uri: decodedUri }, 'Failed to update topic')
          return sendError(reply, 500, 'Failed to save topic update locally')
        }
      }
    )

    // -------------------------------------------------------------------
    // DELETE /api/topics/:uri (auth required, author or moderator)
    // -------------------------------------------------------------------

    app.delete(
      '/api/topics/:uri',
      {
        preHandler: [authMiddleware.requireAuth],
        schema: {
          tags: ['Topics'],
          summary: 'Delete a topic (author or moderator)',
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

        // Fetch existing topic
        const existing = await db.select().from(topics).where(eq(topics.uri, decodedUri))

        const topic = existing[0]
        if (!topic) {
          throw notFound('Topic not found')
        }

        const isAuthor = topic.authorDid === user.did

        // Check if user is a moderator or admin
        let isMod = false
        if (!isAuthor) {
          const userRows = await db.select().from(users).where(eq(users.did, user.did))

          const userRow = userRows[0]
          isMod = userRow?.role === 'moderator' || userRow?.role === 'admin'
        }

        if (!isAuthor && !isMod) {
          throw forbidden('Not authorized to delete this topic')
        }

        // Author: delete from PDS; moderator: skip PDS deletion
        if (isAuthor) {
          const rkey = extractRkey(decodedUri)
          try {
            await pdsClient.deleteRecord(user.did, COLLECTION, rkey)
          } catch (err: unknown) {
            if (err instanceof Error && 'statusCode' in err) throw err
            app.log.error({ err, uri: decodedUri }, 'PDS delete failed for topic')
            return sendError(reply, 502, 'Failed to delete record from remote PDS')
          }
        }

        try {
          // Best-effort cross-post deletion (fire-and-forget)
          crossPostService.deleteCrossPosts(decodedUri, user.did).catch((err: unknown) => {
            app.log.warn({ err, topicUri: decodedUri }, 'Failed to delete cross-posts')
          })

          // Soft-delete: mark as author-deleted, preserve replies (they belong to other users)
          await db.update(topics).set({ isAuthorDeleted: true }).where(eq(topics.uri, decodedUri))

          return await reply.status(204).send()
        } catch (err: unknown) {
          if (err instanceof Error && 'statusCode' in err) throw err
          app.log.error({ err, uri: decodedUri }, 'Failed to delete topic')
          return sendError(reply, 500, 'Failed to delete topic locally')
        }
      }
    )

    done()
  }
}
