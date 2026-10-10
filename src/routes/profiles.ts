import { eq, and, sql, inArray } from 'drizzle-orm'
import type { FastifyPluginCallback } from 'fastify'
import { notFound, badRequest, errorResponseSchema } from '../lib/api-errors.js'
import {
  userPreferencesSchema,
  communityPreferencesSchema,
  ageDeclarationSchema,
  resolveHandlesSchema,
} from '../validation/profiles.js'
import { users } from '../db/schema/users.js'
import { communityProfiles } from '../db/schema/community-profiles.js'
import { resolveProfile } from '../lib/resolve-profile.js'
import { topics } from '../db/schema/topics.js'
import { replies } from '../db/schema/replies.js'
import { reactions } from '../db/schema/reactions.js'
import { votes } from '../db/schema/votes.js'
import { notifications } from '../db/schema/notifications.js'
import { reports } from '../db/schema/reports.js'
import { userPreferences, userCommunityPreferences } from '../db/schema/user-preferences.js'
import { communitySettings } from '../db/schema/community-settings.js'
import { computeClusterDiversityFactor } from '../services/cluster-diversity.js'
import { sybilClusterMembers } from '../db/schema/sybil-cluster-members.js'
import { sybilClusters } from '../db/schema/sybil-clusters.js'
import { interactionGraph } from '../db/schema/interaction-graph.js'
import { pdsTrustFactors } from '../db/schema/pds-trust-factors.js'
import { resolveAuthors, type AuthorProfile } from '../lib/resolve-authors.js'
import type { Database } from '../db/index.js'

// ---------------------------------------------------------------------------
// OpenAPI JSON Schema definitions
// ---------------------------------------------------------------------------

const profileJsonSchema = {
  type: 'object' as const,
  properties: {
    did: { type: 'string' as const },
    handle: { type: 'string' as const },
    displayName: { type: ['string', 'null'] as const },
    avatarUrl: { type: ['string', 'null'] as const },
    bannerUrl: { type: ['string', 'null'] as const },
    bio: { type: ['string', 'null'] as const },
    role: { type: 'string' as const },
    firstSeenAt: { type: 'string' as const, format: 'date-time' as const },
    lastActiveAt: { type: 'string' as const, format: 'date-time' as const },
    followersCount: { type: 'number' as const },
    followsCount: { type: 'number' as const },
    atprotoPostsCount: { type: 'number' as const },
    hasBlueskyProfile: { type: 'boolean' as const },
    accountCreatedAt: { type: ['string', 'null'] as const },
    communityCount: { type: 'number' as const },
    activity: {
      type: 'object' as const,
      properties: {
        topicCount: { type: 'number' as const },
        replyCount: { type: 'number' as const },
        reactionsReceived: { type: 'number' as const },
        votesReceived: { type: 'number' as const },
      },
    },
    globalActivity: {
      type: ['object', 'null'] as const,
      properties: {
        topicCount: { type: 'number' as const },
        replyCount: { type: 'number' as const },
        reactionsReceived: { type: 'number' as const },
        votesReceived: { type: 'number' as const },
      },
    },
    labels: {
      type: 'array' as const,
      items: {
        type: 'object' as const,
        properties: {
          val: { type: 'string' as const },
          src: { type: 'string' as const },
          isSelfLabel: { type: 'boolean' as const },
        },
      },
    },
  },
}

const reputationJsonSchema = {
  type: 'object' as const,
  properties: {
    did: { type: 'string' as const },
    handle: { type: 'string' as const },
    reputation: { type: 'number' as const },
    breakdown: {
      type: 'object' as const,
      properties: {
        topicCount: { type: 'number' as const },
        replyCount: { type: 'number' as const },
        reactionsReceived: { type: 'number' as const },
      },
    },
    communityCount: { type: 'number' as const },
  },
}

const authorProfileJsonSchema = {
  type: 'object' as const,
  properties: {
    did: { type: 'string' as const },
    handle: { type: 'string' as const },
    displayName: { type: ['string', 'null'] as const },
    avatarUrl: { type: ['string', 'null'] as const },
  },
}

const preferencesJsonSchema = {
  type: 'object' as const,
  properties: {
    maturityLevel: { type: 'string' as const },
    declaredAge: {
      type: ['integer', 'null'] as const,
    },
    mutedWords: { type: 'array' as const, items: { type: 'string' as const } },
    blockedDids: {
      type: 'array' as const,
      items: { type: 'string' as const },
    },
    blockedProfiles: {
      type: 'array' as const,
      items: authorProfileJsonSchema,
    },
    mutedDids: { type: 'array' as const, items: { type: 'string' as const } },
    crossPostBluesky: { type: 'boolean' as const },
    crossPostFrontpage: { type: 'boolean' as const },
    updatedAt: { type: 'string' as const, format: 'date-time' as const },
  },
}

const communityPrefsJsonSchema = {
  type: 'object' as const,
  properties: {
    communityDid: { type: 'string' as const },
    maturityOverride: { type: ['string', 'null'] as const },
    mutedWords: {
      type: ['array', 'null'] as const,
      items: { type: 'string' as const },
    },
    blockedDids: {
      type: ['array', 'null'] as const,
      items: { type: 'string' as const },
    },
    mutedDids: {
      type: ['array', 'null'] as const,
      items: { type: 'string' as const },
    },
    notificationPrefs: {
      type: ['object', 'null'] as const,
      properties: {
        replies: { type: 'boolean' as const },
        reactions: { type: 'boolean' as const },
        mentions: { type: 'boolean' as const },
        modActions: { type: 'boolean' as const },
      },
    },
    updatedAt: { type: 'string' as const, format: 'date-time' as const },
  },
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Default global preferences returned when no row exists yet. */
function defaultPreferences() {
  return {
    maturityLevel: 'sfw' as const,
    declaredAge: null as number | null,
    mutedWords: [] as string[],
    blockedDids: [] as string[],
    mutedDids: [] as string[],
    crossPostBluesky: false,
    crossPostFrontpage: false,
    updatedAt: new Date().toISOString(),
  }
}

/** Default per-community preferences returned when no row exists yet. */
function defaultCommunityPreferences(communityDid: string) {
  return {
    communityDid,
    maturityOverride: null,
    mutedWords: null,
    blockedDids: null,
    mutedDids: null,
    notificationPrefs: {
      replies: false,
      reactions: false,
      mentions: true,
      modActions: false,
    },
    updatedAt: new Date().toISOString(),
  }
}

/** Resolve a list of DIDs to AuthorProfile[], preserving order. */
async function resolveBlockedProfiles(dids: string[], db: Database): Promise<AuthorProfile[]> {
  if (dids.length === 0) return []
  const profileMap = await resolveAuthors(dids, null, db)
  return dids.map(
    (did) =>
      profileMap.get(did) ?? {
        did,
        handle: did,
        displayName: null,
        avatarUrl: null,
      }
  )
}

// ---------------------------------------------------------------------------
// Profile routes plugin
// ---------------------------------------------------------------------------

/**
 * Profile, reputation, and preferences routes for the Barazo forum.
 *
 * - GET    /api/users/:handle                              -- Public profile
 * - GET    /api/users/:handle/reputation                   -- Reputation score
 * - POST   /api/users/me/age-declaration                   -- Declare age
 * - GET    /api/users/me/preferences                              -- Global preferences
 * - PUT    /api/users/me/preferences                              -- Update global preferences
 * - GET    /api/users/me/preferences/communities                  -- List community overrides
 * - GET    /api/users/me/preferences/communities/:communityDid    -- Per-community prefs
 * - PUT    /api/users/me/preferences/communities/:communityDid    -- Update per-community prefs
 * - DELETE /api/users/me                                   -- GDPR Art. 17 purge
 */
export function profileRoutes(): FastifyPluginCallback {
  return (app, _opts, done) => {
    const { db, authMiddleware } = app

    // -------------------------------------------------------------------
    // GET /api/users/resolve-handles (auth required)
    // -------------------------------------------------------------------

    app.get(
      '/api/users/resolve-handles',
      {
        preHandler: [authMiddleware.requireAuth],
        schema: {
          tags: ['Profiles'],
          summary: 'Resolve handles to user profiles',
          security: [{ bearerAuth: [] }],
          querystring: {
            type: 'object',
            required: ['handles'],
            properties: {
              handles: { type: 'string' },
            },
          },
          response: {
            200: {
              type: 'object' as const,
              properties: {
                users: {
                  type: 'array' as const,
                  items: authorProfileJsonSchema,
                },
              },
            },
            400: errorResponseSchema,
            401: errorResponseSchema,
          },
        },
      },
      async (request, reply) => {
        const requestUser = request.user
        if (!requestUser) {
          return reply.status(401).send({ error: 'Authentication required' })
        }

        const parsed = resolveHandlesSchema.safeParse(request.query)
        if (!parsed.success) {
          throw badRequest('handles query parameter is required (comma-separated, max 25)')
        }

        const handles = parsed.data.handles

        // Look up handles in our users table
        const userRows = await db
          .select({
            did: users.did,
            handle: users.handle,
            displayName: users.displayName,
            avatarUrl: users.avatarUrl,
          })
          .from(users)
          .where(inArray(users.handle, handles))

        const foundMap = new Map<string, AuthorProfile>()
        for (const row of userRows) {
          foundMap.set(row.handle, {
            did: row.did,
            handle: row.handle,
            displayName: row.displayName,
            avatarUrl: row.avatarUrl,
          })
        }

        // For handles not found locally, try AT Protocol identity resolution
        // via the public Bluesky AppView XRPC endpoint
        const missingHandles = handles.filter((h) => !foundMap.has(h))
        for (const handle of missingHandles) {
          try {
            const url = `https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(handle)}`
            const res = await fetch(url, { signal: AbortSignal.timeout(5000) })
            if (res.ok) {
              const data = (await res.json()) as { did?: string }
              if (data.did) {
                foundMap.set(handle, {
                  did: data.did,
                  handle,
                  displayName: null,
                  avatarUrl: null,
                })
              }
            }
          } catch {
            // Handle not resolvable -- skip silently
          }
        }

        // Return in request order
        const resolved: AuthorProfile[] = handles
          .map((h) => foundMap.get(h))
          .filter((p): p is AuthorProfile => p !== undefined)

        return reply.status(200).send({ users: resolved })
      }
    )

    // -------------------------------------------------------------------
    // GET /api/users/:handle (public, optionalAuth)
    // -------------------------------------------------------------------

    app.get(
      '/api/users/:handle',
      {
        preHandler: [authMiddleware.optionalAuth],
        schema: {
          tags: ['Profiles'],
          summary: 'Get user profile and activity summary',
          params: {
            type: 'object',
            required: ['handle'],
            properties: {
              handle: { type: 'string' },
            },
          },
          querystring: {
            type: 'object',
            properties: {
              communityDid: { type: 'string' },
            },
          },
          response: {
            200: profileJsonSchema,
            404: errorResponseSchema,
          },
        },
      },
      async (request, reply) => {
        const { handle } = request.params as { handle: string }
        const { communityDid } = request.query as { communityDid?: string }

        // Look up user by handle
        const userRows = await db.select().from(users).where(eq(users.handle, handle))

        const user = userRows[0]
        if (!user) {
          throw notFound('User not found')
        }

        // Aggregate activity counts
        const topicCountResult = await db
          .select({ count: sql<number>`count(*)::int` })
          .from(topics)
          .where(eq(topics.authorDid, user.did))

        const replyCountResult = await db
          .select({ count: sql<number>`count(*)::int` })
          .from(replies)
          .where(eq(replies.authorDid, user.did))

        // Count reactions received on user's topics and replies
        const reactionsOnTopicsResult = await db
          .select({ count: sql<number>`count(*)::int` })
          .from(reactions)
          .where(
            sql`${reactions.subjectUri} IN (SELECT ${topics.uri} FROM ${topics} WHERE ${topics.authorDid} = ${user.did})`
          )

        const reactionsOnRepliesResult = await db
          .select({ count: sql<number>`count(*)::int` })
          .from(reactions)
          .where(
            sql`${reactions.subjectUri} IN (SELECT ${replies.uri} FROM ${replies} WHERE ${replies.authorDid} = ${user.did})`
          )

        const topicCount = topicCountResult[0]?.count ?? 0
        const replyCount = replyCountResult[0]?.count ?? 0
        const reactionsReceived =
          (reactionsOnTopicsResult[0]?.count ?? 0) + (reactionsOnRepliesResult[0]?.count ?? 0)

        // Count votes received on user's topics and replies
        const votesOnTopicsResult = await db
          .select({ count: sql<number>`count(*)::int` })
          .from(votes)
          .where(
            sql`${votes.subjectUri} IN (SELECT ${topics.uri} FROM ${topics} WHERE ${topics.authorDid} = ${user.did})`
          )

        const votesOnRepliesResult = await db
          .select({ count: sql<number>`count(*)::int` })
          .from(votes)
          .where(
            sql`${votes.subjectUri} IN (SELECT ${replies.uri} FROM ${replies} WHERE ${replies.authorDid} = ${user.did})`
          )

        const votesReceived =
          (votesOnTopicsResult[0]?.count ?? 0) + (votesOnRepliesResult[0]?.count ?? 0)

        // Count distinct communities the user has contributed to
        const topicCommResult = await db
          .selectDistinct({ communityDid: topics.communityDid })
          .from(topics)
          .where(eq(topics.authorDid, user.did))

        const replyCommResult = await db
          .selectDistinct({ communityDid: replies.communityDid })
          .from(replies)
          .where(eq(replies.authorDid, user.did))

        const allCommunities = new Set([
          ...topicCommResult.map((r: { communityDid: string }) => r.communityDid),
          ...replyCommResult.map((r: { communityDid: string }) => r.communityDid),
        ])

        const communityCount = allCommunities.size

        // Community-scoped activity (when communityDid is provided)
        let scopedActivity: {
          topicCount: number
          replyCount: number
          reactionsReceived: number
          votesReceived: number
        } | null = null

        if (communityDid) {
          const scopedTopicResult = await db
            .select({ count: sql<number>`count(*)::int` })
            .from(topics)
            .where(and(eq(topics.authorDid, user.did), eq(topics.communityDid, communityDid)))

          const scopedReplyResult = await db
            .select({ count: sql<number>`count(*)::int` })
            .from(replies)
            .where(and(eq(replies.authorDid, user.did), eq(replies.communityDid, communityDid)))

          const scopedReactionsOnTopics = await db
            .select({ count: sql<number>`count(*)::int` })
            .from(reactions)
            .where(
              sql`${reactions.subjectUri} IN (SELECT ${topics.uri} FROM ${topics} WHERE ${topics.authorDid} = ${user.did} AND ${topics.communityDid} = ${communityDid})`
            )

          const scopedReactionsOnReplies = await db
            .select({ count: sql<number>`count(*)::int` })
            .from(reactions)
            .where(
              sql`${reactions.subjectUri} IN (SELECT ${replies.uri} FROM ${replies} WHERE ${replies.authorDid} = ${user.did} AND ${replies.communityDid} = ${communityDid})`
            )

          const scopedVotesOnTopics = await db
            .select({ count: sql<number>`count(*)::int` })
            .from(votes)
            .where(
              sql`${votes.subjectUri} IN (SELECT ${topics.uri} FROM ${topics} WHERE ${topics.authorDid} = ${user.did} AND ${topics.communityDid} = ${communityDid})`
            )

          const scopedVotesOnReplies = await db
            .select({ count: sql<number>`count(*)::int` })
            .from(votes)
            .where(
              sql`${votes.subjectUri} IN (SELECT ${replies.uri} FROM ${replies} WHERE ${replies.authorDid} = ${user.did} AND ${replies.communityDid} = ${communityDid})`
            )

          scopedActivity = {
            topicCount: scopedTopicResult[0]?.count ?? 0,
            replyCount: scopedReplyResult[0]?.count ?? 0,
            reactionsReceived:
              (scopedReactionsOnTopics[0]?.count ?? 0) + (scopedReactionsOnReplies[0]?.count ?? 0),
            votesReceived:
              (scopedVotesOnTopics[0]?.count ?? 0) + (scopedVotesOnReplies[0]?.count ?? 0),
          }
        }

        // Build source profile for resolution
        const sourceProfile = {
          did: user.did,
          handle: user.handle,
          displayName: user.displayName ?? null,
          avatarUrl: user.avatarUrl ?? null,
          bannerUrl: user.bannerUrl ?? null,
          bio: user.bio ?? null,
        }

        // Optionally resolve through community override layer
        let resolved = sourceProfile
        if (communityDid) {
          const overrideRows = await db
            .select()
            .from(communityProfiles)
            .where(
              and(
                eq(communityProfiles.did, user.did),
                eq(communityProfiles.communityDid, communityDid)
              )
            )

          const override = overrideRows[0] ?? null
          resolved = resolveProfile(sourceProfile, override)
        }

        // Map stored labels to response format with isSelfLabel flag
        const labels = user.atprotoLabels.map((l) => ({
          val: l.val,
          src: l.src,
          isSelfLabel: l.src === user.did,
        }))

        const globalActivity = {
          topicCount,
          replyCount,
          reactionsReceived,
          votesReceived,
        }

        const responseBody: Record<string, unknown> = {
          did: resolved.did,
          handle: resolved.handle,
          displayName: resolved.displayName,
          avatarUrl: resolved.avatarUrl,
          bannerUrl: resolved.bannerUrl,
          bio: resolved.bio,
          role: user.role,
          firstSeenAt: user.firstSeenAt.toISOString(),
          lastActiveAt: user.lastActiveAt.toISOString(),
          followersCount: user.followersCount,
          followsCount: user.followsCount,
          atprotoPostsCount: user.atprotoPostsCount,
          hasBlueskyProfile: user.hasBlueskyProfile,
          accountCreatedAt: user.accountCreatedAt?.toISOString() ?? null,
          communityCount,
          activity: scopedActivity ?? globalActivity,
          labels,
        }

        if (communityDid && communityCount >= 2) {
          responseBody['globalActivity'] = globalActivity
        }

        return reply.status(200).send(responseBody)
      }
    )

    // -------------------------------------------------------------------
    // GET /api/users/:handle/reputation (public)
    // -------------------------------------------------------------------

    app.get(
      '/api/users/:handle/reputation',
      {
        preHandler: [authMiddleware.optionalAuth],
        schema: {
          tags: ['Profiles'],
          summary: 'Get user reputation score',
          params: {
            type: 'object',
            required: ['handle'],
            properties: {
              handle: { type: 'string' },
            },
          },
          response: {
            200: reputationJsonSchema,
            404: errorResponseSchema,
          },
        },
      },
      async (request, reply) => {
        const { handle } = request.params as { handle: string }

        // Look up user by handle
        const userRows = await db.select().from(users).where(eq(users.handle, handle))

        const user = userRows[0]
        if (!user) {
          throw notFound('User not found')
        }

        // Count topics
        const topicCountResult = await db
          .select({ count: sql<number>`count(*)::int` })
          .from(topics)
          .where(eq(topics.authorDid, user.did))

        // Count replies
        const replyCountResult = await db
          .select({ count: sql<number>`count(*)::int` })
          .from(replies)
          .where(eq(replies.authorDid, user.did))

        // Count reactions received
        const reactionsOnTopicsResult = await db
          .select({ count: sql<number>`count(*)::int` })
          .from(reactions)
          .where(
            sql`${reactions.subjectUri} IN (SELECT ${topics.uri} FROM ${topics} WHERE ${topics.authorDid} = ${user.did})`
          )

        const reactionsOnRepliesResult = await db
          .select({ count: sql<number>`count(*)::int` })
          .from(reactions)
          .where(
            sql`${reactions.subjectUri} IN (SELECT ${replies.uri} FROM ${replies} WHERE ${replies.authorDid} = ${user.did})`
          )

        const topicCount = topicCountResult[0]?.count ?? 0
        const replyCount = replyCountResult[0]?.count ?? 0
        const reactionsReceived =
          (reactionsOnTopicsResult[0]?.count ?? 0) + (reactionsOnRepliesResult[0]?.count ?? 0)

        // Base reputation formula: (topics * 5) + (replies * 2) + (reactions_received * 1)
        const baseReputation = topicCount * 5 + replyCount * 2 + reactionsReceived * 1

        // Trust-weighted reputation: multiply by voter trust score, PDS trust factor, and cluster diversity factor
        const voterTrustScore = await app.trustGraphService
          .getTrustScore(user.did, null)
          .catch(() => 0.1)

        // Look up PDS trust factor from user's handle domain
        let pdsTrustFactor = 0.3 // Default for unknown PDS
        try {
          const handleParts = user.handle.split('.')
          // Extract host: "jay.bsky.team" -> "bsky.team", "user.example.com" -> "example.com"
          const pdsHost = handleParts.length > 1 ? handleParts.slice(1).join('.') : user.handle

          const pdsRows = await db
            .select({ trustFactor: pdsTrustFactors.trustFactor })
            .from(pdsTrustFactors)
            .where(eq(pdsTrustFactors.pdsHost, pdsHost))

          const pdsRow = pdsRows[0]
          if (pdsRow) {
            pdsTrustFactor = pdsRow.trustFactor
          }
        } catch {
          // Non-critical: default to 0.3 for unknown PDS
        }

        // Check if user is in a flagged sybil cluster
        let inFlaggedCluster = false
        let externalInteractionCount = 0
        try {
          const memberRows = await db
            .select({ clusterId: sybilClusterMembers.clusterId })
            .from(sybilClusterMembers)
            .where(eq(sybilClusterMembers.did, user.did))

          if (memberRows.length > 0) {
            const clusterIds = memberRows.map((r) => r.clusterId)
            const flaggedRows = await db
              .select({ id: sybilClusters.id })
              .from(sybilClusters)
              .where(
                and(
                  sql`${sybilClusters.id} = ANY(${clusterIds})`,
                  eq(sybilClusters.status, 'flagged')
                )
              )
            inFlaggedCluster = flaggedRows.length > 0

            if (inFlaggedCluster) {
              // Count distinct external DIDs this user interacts with
              const externalRows = await db
                .select({
                  count: sql<number>`count(DISTINCT ${interactionGraph.targetDid})::int`,
                })
                .from(interactionGraph)
                .where(
                  and(
                    eq(interactionGraph.sourceDid, user.did),
                    sql`${interactionGraph.targetDid} NOT IN (
                      SELECT ${sybilClusterMembers.did}
                      FROM ${sybilClusterMembers}
                      WHERE ${sybilClusterMembers.clusterId} = ANY(${clusterIds})
                    )`
                  )
                )
              externalInteractionCount = externalRows[0]?.count ?? 0
            }
          }
        } catch {
          // Non-critical: default to no cluster adjustment
        }

        const clusterDiversityFactor = computeClusterDiversityFactor(
          inFlaggedCluster,
          externalInteractionCount
        )

        const reputation = Math.round(
          baseReputation * voterTrustScore * pdsTrustFactor * clusterDiversityFactor
        )

        // Count distinct communities the user has contributed to
        const topicCommResult = await db
          .selectDistinct({ communityDid: topics.communityDid })
          .from(topics)
          .where(eq(topics.authorDid, user.did))

        const replyCommResult = await db
          .selectDistinct({ communityDid: replies.communityDid })
          .from(replies)
          .where(eq(replies.authorDid, user.did))

        const allCommunities = new Set([
          ...topicCommResult.map((r: { communityDid: string }) => r.communityDid),
          ...replyCommResult.map((r: { communityDid: string }) => r.communityDid),
        ])

        const communityCount = allCommunities.size

        return reply.status(200).send({
          did: user.did,
          handle: user.handle,
          reputation,
          breakdown: {
            topicCount,
            replyCount,
            reactionsReceived,
          },
          communityCount,
        })
      }
    )

    // -------------------------------------------------------------------
    // POST /api/users/me/age-declaration (auth required)
    // -------------------------------------------------------------------

    app.post(
      '/api/users/me/age-declaration',
      {
        preHandler: [authMiddleware.requireAuth],
        schema: {
          tags: ['Profiles'],
          summary: 'Declare age to unlock mature content access',
          security: [{ bearerAuth: [] }],
          body: {
            type: 'object',
            required: ['declaredAge'],
            properties: {
              declaredAge: { type: 'integer' },
            },
          },
          response: {
            200: {
              type: 'object',
              properties: {
                success: { type: 'boolean' },
                declaredAge: {
                  type: 'integer',
                },
              },
            },
            400: errorResponseSchema,
            401: errorResponseSchema,
          },
        },
      },
      async (request, reply) => {
        const requestUser = request.user
        if (!requestUser) {
          return reply.status(401).send({ error: 'Authentication required' })
        }

        const parsed = ageDeclarationSchema.safeParse(request.body)
        if (!parsed.success) {
          throw badRequest('declaredAge must be one of: 0, 13, 14, 15, 16, 18')
        }

        const { declaredAge } = parsed.data
        const now = new Date()

        // Upsert into user_preferences
        await db
          .insert(userPreferences)
          .values({
            did: requestUser.did,
            declaredAge,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: userPreferences.did,
            set: {
              declaredAge,
              updatedAt: now,
            },
          })

        // Also update users table
        await db.update(users).set({ declaredAge }).where(eq(users.did, requestUser.did))

        return reply.status(200).send({
          success: true,
          declaredAge,
        })
      }
    )

    // -------------------------------------------------------------------
    // GET /api/users/me/preferences (auth required)
    // -------------------------------------------------------------------

    app.get(
      '/api/users/me/preferences',
      {
        preHandler: [authMiddleware.requireAuth],
        schema: {
          tags: ['Profiles'],
          summary: 'Get global user preferences',
          security: [{ bearerAuth: [] }],
          response: {
            200: preferencesJsonSchema,
            401: errorResponseSchema,
          },
        },
      },
      async (request, reply) => {
        const requestUser = request.user
        if (!requestUser) {
          return reply.status(401).send({ error: 'Authentication required' })
        }

        const rows = await db
          .select()
          .from(userPreferences)
          .where(eq(userPreferences.did, requestUser.did))

        const prefs = rows[0]
        if (!prefs) {
          return reply.status(200).send({ ...defaultPreferences(), blockedProfiles: [] })
        }

        const blockedProfiles = await resolveBlockedProfiles(prefs.blockedDids, db)

        return reply.status(200).send({
          maturityLevel: prefs.maturityLevel,
          declaredAge: prefs.declaredAge ?? null,
          mutedWords: prefs.mutedWords,
          blockedDids: prefs.blockedDids,
          blockedProfiles,
          mutedDids: prefs.mutedDids,
          crossPostBluesky: prefs.crossPostBluesky,
          crossPostFrontpage: prefs.crossPostFrontpage,
          updatedAt: prefs.updatedAt.toISOString(),
        })
      }
    )

    // -------------------------------------------------------------------
    // PUT /api/users/me/preferences (auth required)
    // -------------------------------------------------------------------

    app.put(
      '/api/users/me/preferences',
      {
        preHandler: [authMiddleware.requireAuth],
        schema: {
          tags: ['Profiles'],
          summary: 'Update global user preferences',
          security: [{ bearerAuth: [] }],
          body: {
            type: 'object',
            properties: {
              maturityLevel: { type: 'string', enum: ['sfw', 'mature'] },
              mutedWords: {
                type: 'array',
                items: { type: 'string' },
              },
              blockedDids: {
                type: 'array',
                items: { type: 'string' },
              },
              mutedDids: {
                type: 'array',
                items: { type: 'string' },
              },
              crossPostBluesky: { type: 'boolean' },
              crossPostFrontpage: { type: 'boolean' },
            },
          },
          response: {
            200: preferencesJsonSchema,
            400: errorResponseSchema,
            401: errorResponseSchema,
          },
        },
      },
      async (request, reply) => {
        const requestUser = request.user
        if (!requestUser) {
          return reply.status(401).send({ error: 'Authentication required' })
        }

        const parsed = userPreferencesSchema.safeParse(request.body)
        if (!parsed.success) {
          throw badRequest('Invalid preferences data')
        }

        const now = new Date()
        const updateData: Record<string, unknown> = { updatedAt: now }

        if (parsed.data.maturityLevel !== undefined) {
          updateData['maturityLevel'] = parsed.data.maturityLevel
        }
        if (parsed.data.mutedWords !== undefined) {
          updateData['mutedWords'] = parsed.data.mutedWords
        }
        if (parsed.data.blockedDids !== undefined) {
          updateData['blockedDids'] = parsed.data.blockedDids
        }
        if (parsed.data.mutedDids !== undefined) {
          updateData['mutedDids'] = parsed.data.mutedDids
        }
        if (parsed.data.crossPostBluesky !== undefined) {
          updateData['crossPostBluesky'] = parsed.data.crossPostBluesky
        }
        if (parsed.data.crossPostFrontpage !== undefined) {
          updateData['crossPostFrontpage'] = parsed.data.crossPostFrontpage
        }

        // Upsert
        await db
          .insert(userPreferences)
          .values({
            did: requestUser.did,
            ...parsed.data,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: userPreferences.did,
            set: updateData,
          })

        // Fetch the updated row
        const rows = await db
          .select()
          .from(userPreferences)
          .where(eq(userPreferences.did, requestUser.did))

        const prefs = rows[0]
        if (!prefs) {
          return reply.status(200).send({ ...defaultPreferences(), blockedProfiles: [] })
        }

        const updatedBlockedProfiles = await resolveBlockedProfiles(prefs.blockedDids, db)

        return reply.status(200).send({
          maturityLevel: prefs.maturityLevel,
          declaredAge: prefs.declaredAge ?? null,
          mutedWords: prefs.mutedWords,
          blockedDids: prefs.blockedDids,
          blockedProfiles: updatedBlockedProfiles,
          mutedDids: prefs.mutedDids,
          crossPostBluesky: prefs.crossPostBluesky,
          crossPostFrontpage: prefs.crossPostFrontpage,
          updatedAt: prefs.updatedAt.toISOString(),
        })
      }
    )

    // -------------------------------------------------------------------
    // GET /api/users/me/preferences/communities (auth required) -- list
    // -------------------------------------------------------------------

    app.get(
      '/api/users/me/preferences/communities',
      {
        preHandler: [authMiddleware.requireAuth],
        schema: {
          tags: ['Profiles'],
          summary: 'List all per-community user preference overrides',
          security: [{ bearerAuth: [] }],
          response: {
            200: {
              type: 'object' as const,
              properties: {
                communities: {
                  type: 'array' as const,
                  items: {
                    type: 'object' as const,
                    properties: {
                      communityDid: { type: 'string' as const },
                      communityName: { type: 'string' as const },
                      maturityLevel: { type: 'string' as const },
                      mutedWords: {
                        type: 'array' as const,
                        items: { type: 'string' as const },
                      },
                      blockedDids: {
                        type: 'array' as const,
                        items: { type: 'string' as const },
                      },
                      blockedProfiles: {
                        type: 'array' as const,
                        items: authorProfileJsonSchema,
                      },
                    },
                  },
                },
              },
            },
            401: errorResponseSchema,
          },
        },
      },
      async (request, reply) => {
        const requestUser = request.user
        if (!requestUser) {
          return reply.status(401).send({ error: 'Authentication required' })
        }

        const rows = await db
          .select({
            communityDid: userCommunityPreferences.communityDid,
            maturityOverride: userCommunityPreferences.maturityOverride,
            mutedWords: userCommunityPreferences.mutedWords,
            blockedDids: userCommunityPreferences.blockedDids,
            communityName: communitySettings.communityName,
          })
          .from(userCommunityPreferences)
          .leftJoin(
            communitySettings,
            eq(userCommunityPreferences.communityDid, communitySettings.communityDid)
          )
          .where(eq(userCommunityPreferences.did, requestUser.did))

        // Collect all blocked DIDs across communities for batch resolution
        const allBlockedDids = rows.flatMap((row) => row.blockedDids ?? [])
        const profileMap =
          allBlockedDids.length > 0
            ? await resolveAuthors([...new Set(allBlockedDids)], null, db)
            : new Map<string, AuthorProfile>()

        const communities = rows.map((row) => {
          const dids = row.blockedDids ?? []
          return {
            communityDid: row.communityDid,
            communityName: row.communityName ?? row.communityDid,
            maturityLevel: row.maturityOverride ?? 'inherit',
            mutedWords: row.mutedWords ?? [],
            blockedDids: dids,
            blockedProfiles: dids.map(
              (did) =>
                profileMap.get(did) ?? {
                  did,
                  handle: did,
                  displayName: null,
                  avatarUrl: null,
                }
            ),
          }
        })

        // Always include the current community so the settings page shows it
        // even if the user has never saved per-community preferences.
        // No membership record is created — this is purely ephemeral.
        const currentCommunityDid = request.communityDid
        if (
          currentCommunityDid &&
          !communities.some((c) => c.communityDid === currentCommunityDid)
        ) {
          const nameRows = await db
            .select({ communityName: communitySettings.communityName })
            .from(communitySettings)
            .where(eq(communitySettings.communityDid, currentCommunityDid))

          communities.push({
            communityDid: currentCommunityDid,
            communityName: nameRows[0]?.communityName ?? currentCommunityDid,
            maturityLevel: 'inherit',
            mutedWords: [],
            blockedDids: [],
            blockedProfiles: [],
          })
        }

        return reply.status(200).send({ communities })
      }
    )

    // -------------------------------------------------------------------
    // GET /api/users/me/preferences/communities/:communityDid (auth required)
    // -------------------------------------------------------------------

    app.get(
      '/api/users/me/preferences/communities/:communityDid',
      {
        preHandler: [authMiddleware.requireAuth],
        schema: {
          tags: ['Profiles'],
          summary: 'Get per-community user preferences',
          security: [{ bearerAuth: [] }],
          params: {
            type: 'object',
            required: ['communityDid'],
            properties: {
              communityDid: { type: 'string' },
            },
          },
          response: {
            200: communityPrefsJsonSchema,
            401: errorResponseSchema,
          },
        },
      },
      async (request, reply) => {
        const requestUser = request.user
        if (!requestUser) {
          return reply.status(401).send({ error: 'Authentication required' })
        }

        const { communityDid } = request.params as { communityDid: string }

        const rows = await db
          .select()
          .from(userCommunityPreferences)
          .where(
            and(
              eq(userCommunityPreferences.did, requestUser.did),
              eq(userCommunityPreferences.communityDid, communityDid)
            )
          )

        const prefs = rows[0]
        if (!prefs) {
          return reply.status(200).send(defaultCommunityPreferences(communityDid))
        }

        return reply.status(200).send({
          communityDid: prefs.communityDid,
          maturityOverride: prefs.maturityOverride ?? null,
          mutedWords: prefs.mutedWords ?? null,
          blockedDids: prefs.blockedDids ?? null,
          mutedDids: prefs.mutedDids ?? null,
          notificationPrefs: prefs.notificationPrefs ?? null,
          updatedAt: prefs.updatedAt.toISOString(),
        })
      }
    )

    // -------------------------------------------------------------------
    // PUT /api/users/me/preferences/communities/:communityDid (auth required)
    // -------------------------------------------------------------------

    app.put(
      '/api/users/me/preferences/communities/:communityDid',
      {
        preHandler: [authMiddleware.requireAuth],
        schema: {
          tags: ['Profiles'],
          summary: 'Update per-community user preferences',
          security: [{ bearerAuth: [] }],
          params: {
            type: 'object',
            required: ['communityDid'],
            properties: {
              communityDid: { type: 'string' },
            },
          },
          body: {
            type: 'object',
            properties: {
              maturityOverride: {
                type: ['string', 'null'],
                enum: ['sfw', 'mature', null],
              },
              mutedWords: {
                type: ['array', 'null'],
                items: { type: 'string' },
              },
              blockedDids: {
                type: ['array', 'null'],
                items: { type: 'string' },
              },
              mutedDids: {
                type: ['array', 'null'],
                items: { type: 'string' },
              },
              notificationPrefs: {
                type: ['object', 'null'],
                properties: {
                  replies: { type: 'boolean' },
                  reactions: { type: 'boolean' },
                  mentions: { type: 'boolean' },
                  modActions: { type: 'boolean' },
                },
              },
            },
          },
          response: {
            200: communityPrefsJsonSchema,
            400: errorResponseSchema,
            401: errorResponseSchema,
          },
        },
      },
      async (request, reply) => {
        const requestUser = request.user
        if (!requestUser) {
          return reply.status(401).send({ error: 'Authentication required' })
        }

        const { communityDid } = request.params as { communityDid: string }

        const parsed = communityPreferencesSchema.safeParse(request.body)
        if (!parsed.success) {
          throw badRequest('Invalid community preferences data')
        }

        const now = new Date()
        const updateData: Record<string, unknown> = { updatedAt: now }

        if (parsed.data.maturityOverride !== undefined) {
          updateData['maturityOverride'] = parsed.data.maturityOverride
        }
        if (parsed.data.mutedWords !== undefined) {
          updateData['mutedWords'] = parsed.data.mutedWords
        }
        if (parsed.data.blockedDids !== undefined) {
          updateData['blockedDids'] = parsed.data.blockedDids
        }
        if (parsed.data.mutedDids !== undefined) {
          updateData['mutedDids'] = parsed.data.mutedDids
        }
        if (parsed.data.notificationPrefs !== undefined) {
          updateData['notificationPrefs'] = parsed.data.notificationPrefs
        }

        // Upsert: use composite key (did, communityDid)
        await db
          .insert(userCommunityPreferences)
          .values({
            did: requestUser.did,
            communityDid,
            ...parsed.data,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: [userCommunityPreferences.did, userCommunityPreferences.communityDid],
            set: updateData,
          })

        // Fetch updated row
        const rows = await db
          .select()
          .from(userCommunityPreferences)
          .where(
            and(
              eq(userCommunityPreferences.did, requestUser.did),
              eq(userCommunityPreferences.communityDid, communityDid)
            )
          )

        const prefs = rows[0]
        if (!prefs) {
          return reply.status(200).send(defaultCommunityPreferences(communityDid))
        }

        return reply.status(200).send({
          communityDid: prefs.communityDid,
          maturityOverride: prefs.maturityOverride ?? null,
          mutedWords: prefs.mutedWords ?? null,
          blockedDids: prefs.blockedDids ?? null,
          mutedDids: prefs.mutedDids ?? null,
          notificationPrefs: prefs.notificationPrefs ?? null,
          updatedAt: prefs.updatedAt.toISOString(),
        })
      }
    )

    // -------------------------------------------------------------------
    // DELETE /api/users/me (auth required) -- GDPR Art. 17 purge
    // -------------------------------------------------------------------

    app.delete(
      '/api/users/me',
      {
        preHandler: [authMiddleware.requireAuth],
        schema: {
          tags: ['Profiles'],
          summary: 'Delete all indexed data for the authenticated user (GDPR Art. 17)',
          security: [{ bearerAuth: [] }],
          response: {
            204: { type: 'null' },
            401: errorResponseSchema,
          },
        },
      },
      async (request, reply) => {
        const requestUser = request.user
        if (!requestUser) {
          return reply.status(401).send({ error: 'Authentication required' })
        }

        const userDid = requestUser.did

        await db.transaction(async (tx) => {
          // Delete reactions by this user
          await tx.delete(reactions).where(eq(reactions.authorDid, userDid))

          // Delete notifications for/by this user
          await tx.delete(notifications).where(eq(notifications.recipientDid, userDid))
          await tx.delete(notifications).where(eq(notifications.actorDid, userDid))

          // Delete reports filed by this user
          await tx.delete(reports).where(eq(reports.reporterDid, userDid))

          // Delete replies by this user
          await tx.delete(replies).where(eq(replies.authorDid, userDid))

          // Delete topics by this user
          await tx.delete(topics).where(eq(topics.authorDid, userDid))

          // Delete community profile overrides
          await tx.delete(communityProfiles).where(eq(communityProfiles.did, userDid))

          // Delete community preferences
          await tx.delete(userCommunityPreferences).where(eq(userCommunityPreferences.did, userDid))

          // Delete global preferences
          await tx.delete(userPreferences).where(eq(userPreferences.did, userDid))

          // Delete user record
          await tx.delete(users).where(eq(users.did, userDid))
        })

        app.log.info({ did: userDid }, 'GDPR Art. 17: all indexed data purged for user')

        return reply.status(204).send()
      }
    )

    done()
  }
}
