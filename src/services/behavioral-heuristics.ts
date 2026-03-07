import { and, gte, eq, count, countDistinct, gt, lt } from 'drizzle-orm'
import type { Database } from '../db/index.js'
import type { Logger } from '../lib/logger.js'
import { reactions } from '../db/schema/reactions.js'
import { topics } from '../db/schema/topics.js'
import { replies } from '../db/schema/replies.js'
import { behavioralFlags } from '../db/schema/behavioral-flags.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BehavioralFlag {
  flagType: 'burst_voting' | 'content_similarity' | 'low_diversity'
  affectedDids: string[]
  details: string
  detectedAt: Date
}

export interface BehavioralHeuristicsService {
  detectBurstVoting(communityId: string | null): Promise<BehavioralFlag[]>
  detectContentSimilarity(communityId: string | null): Promise<BehavioralFlag[]>
  detectLowDiversity(communityId: string | null): Promise<BehavioralFlag[]>
  runAll(communityId: string | null): Promise<BehavioralFlag[]>
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Burst voting threshold: more than this many reactions in the window. */
const BURST_REACTION_THRESHOLD = 20

/** Burst voting window in minutes. */
const BURST_WINDOW_MINUTES = 10

/** Jaccard similarity threshold for content fingerprinting. */
const SIMILARITY_THRESHOLD = 0.8

/** Minimum number of posts from different DIDs with high similarity to flag. */
const SIMILARITY_MIN_POSTS = 3

/** Minimum interactions for low diversity check. */
const LOW_DIVERSITY_MIN_INTERACTIONS = 10

/** Minimum unique targets for low diversity check. */
const LOW_DIVERSITY_MIN_TARGETS = 3

/**
 * Compute normalized trigrams from text content.
 * Lowercases, strips non-alphanumeric chars, splits into 3-char sequences.
 */
export function computeTrigrams(text: string): Set<string> {
  const normalized = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  const trigrams = new Set<string>()
  for (let i = 0; i <= normalized.length - 3; i++) {
    trigrams.add(normalized.slice(i, i + 3))
  }
  return trigrams
}

/**
 * Compute Jaccard similarity between two sets.
 */
export function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1
  let intersection = 0
  for (const item of a) {
    if (b.has(item)) intersection++
  }
  const union = a.size + b.size - intersection
  return union === 0 ? 0 : intersection / union
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createBehavioralHeuristicsService(
  db: Database,
  logger: Logger
): BehavioralHeuristicsService {
  async function detectBurstVoting(communityId: string | null): Promise<BehavioralFlag[]> {
    const flags: BehavioralFlag[] = []
    const now = new Date()
    const windowStart = new Date(now.getTime() - BURST_WINDOW_MINUTES * 60 * 1000)

    try {
      // Build conditions for query
      const conditions = [gte(reactions.createdAt, windowStart)]
      if (communityId) {
        conditions.push(eq(reactions.communityDid, communityId))
      }

      // Query reactions grouped by author in the burst window using Drizzle ORM
      const rows = await db
        .select({
          authorDid: reactions.authorDid,
          reactionCount: count(),
        })
        .from(reactions)
        .where(and(...conditions))
        .groupBy(reactions.authorDid)
        .having(gt(count(), BURST_REACTION_THRESHOLD))

      if (rows.length > 0) {
        const affectedDids = rows.map((r) => r.authorDid)
        const detailParts = rows.map(
          (r) =>
            `${r.authorDid}: ${String(r.reactionCount)} reactions in ${String(BURST_WINDOW_MINUTES)}min`
        )

        const flag: BehavioralFlag = {
          flagType: 'burst_voting',
          affectedDids,
          details: `Burst voting detected: ${detailParts.join('; ')}`,
          detectedAt: now,
        }
        flags.push(flag)

        // Persist to database
        await db.insert(behavioralFlags).values({
          flagType: 'burst_voting',
          affectedDids,
          details: flag.details,
          communityDid: communityId,
          detectedAt: now,
        })

        logger.warn({ affectedDids, communityId }, 'Burst voting detected')
      }
    } catch (err: unknown) {
      logger.error({ err, communityId }, 'Failed to detect burst voting')
    }

    return flags
  }

  async function detectContentSimilarity(communityId: string | null): Promise<BehavioralFlag[]> {
    const flags: BehavioralFlag[] = []
    const now = new Date()
    const windowStart = new Date(now.getTime() - 24 * 60 * 60 * 1000) // 24h

    try {
      // Fetch recent topics
      const topicConditions = [gte(topics.publishedAt, windowStart)]
      if (communityId) {
        topicConditions.push(eq(topics.communityDid, communityId))
      }

      const recentTopics = await db
        .select({
          authorDid: topics.authorDid,
          content: topics.content,
          uri: topics.uri,
        })
        .from(topics)
        .where(and(...topicConditions))

      // Fetch recent replies
      const replyConditions = [gte(replies.createdAt, windowStart)]
      if (communityId) {
        replyConditions.push(eq(replies.communityDid, communityId))
      }

      const recentReplies = await db
        .select({
          authorDid: replies.authorDid,
          content: replies.content,
          uri: replies.uri,
        })
        .from(replies)
        .where(and(...replyConditions))

      // Combine all posts with their fingerprints
      const posts = [
        ...recentTopics.map((t) => ({
          authorDid: t.authorDid,
          content: t.content,
          uri: t.uri,
          trigrams: computeTrigrams(t.content),
        })),
        ...recentReplies.map((r) => ({
          authorDid: r.authorDid,
          content: r.content,
          uri: r.uri,
          trigrams: computeTrigrams(r.content),
        })),
      ]

      // Compare posts from different DIDs
      // Group similar posts into clusters
      const similarClusters: Map<string, Set<string>> = new Map()

      for (let i = 0; i < posts.length; i++) {
        for (let j = i + 1; j < posts.length; j++) {
          const a = posts[i]
          const b = posts[j]
          if (!a || !b) continue
          if (a.authorDid === b.authorDid) continue
          if (a.trigrams.size < 3 || b.trigrams.size < 3) continue

          const similarity = jaccardSimilarity(a.trigrams, b.trigrams)
          if (similarity >= SIMILARITY_THRESHOLD) {
            // Find or create a cluster key
            const clusterKey = a.uri
            const cluster = similarClusters.get(clusterKey) ?? new Set<string>()
            cluster.add(a.authorDid)
            cluster.add(b.authorDid)
            similarClusters.set(clusterKey, cluster)
          }
        }
      }

      // Flag clusters with enough different DIDs
      for (const [, dids] of similarClusters) {
        if (dids.size >= SIMILARITY_MIN_POSTS) {
          const affectedDids = [...dids]
          const flag: BehavioralFlag = {
            flagType: 'content_similarity',
            affectedDids,
            details: `High content similarity (Jaccard >= ${String(SIMILARITY_THRESHOLD)}) detected across ${String(affectedDids.length)} different accounts`,
            detectedAt: now,
          }
          flags.push(flag)

          await db.insert(behavioralFlags).values({
            flagType: 'content_similarity',
            affectedDids,
            details: flag.details,
            communityDid: communityId,
            detectedAt: now,
          })

          logger.warn({ affectedDids, communityId }, 'Content similarity detected')
        }
      }
    } catch (err: unknown) {
      logger.error({ err, communityId }, 'Failed to detect content similarity')
    }

    return flags
  }

  async function detectLowDiversity(communityId: string | null): Promise<BehavioralFlag[]> {
    const flags: BehavioralFlag[] = []
    const now = new Date()

    try {
      // Build conditions
      const conditions = communityId ? [eq(reactions.communityDid, communityId)] : []

      const whereClause = conditions.length > 0 ? and(...conditions) : undefined

      // Query reactions: for each author, count total and distinct targets using Drizzle ORM
      const rows = await db
        .select({
          authorDid: reactions.authorDid,
          totalInteractions: count(),
          uniqueTargets: countDistinct(reactions.subjectUri),
        })
        .from(reactions)
        .where(whereClause)
        .groupBy(reactions.authorDid)
        .having(
          and(
            gt(count(), LOW_DIVERSITY_MIN_INTERACTIONS),
            lt(countDistinct(reactions.subjectUri), LOW_DIVERSITY_MIN_TARGETS)
          )
        )

      if (rows.length > 0) {
        const affectedDids = rows.map((r) => r.authorDid)
        const detailParts = rows.map(
          (r) =>
            `${r.authorDid}: ${String(r.totalInteractions)} interactions, ${String(r.uniqueTargets)} unique targets`
        )

        const flag: BehavioralFlag = {
          flagType: 'low_diversity',
          affectedDids,
          details: `Low interaction diversity: ${detailParts.join('; ')}`,
          detectedAt: now,
        }
        flags.push(flag)

        await db.insert(behavioralFlags).values({
          flagType: 'low_diversity',
          affectedDids,
          details: flag.details,
          communityDid: communityId,
          detectedAt: now,
        })

        logger.warn({ affectedDids, communityId }, 'Low interaction diversity detected')
      }
    } catch (err: unknown) {
      logger.error({ err, communityId }, 'Failed to detect low diversity')
    }

    return flags
  }

  async function runAll(communityId: string | null): Promise<BehavioralFlag[]> {
    const results = await Promise.all([
      detectBurstVoting(communityId),
      detectContentSimilarity(communityId),
      detectLowDiversity(communityId),
    ])
    return results.flat()
  }

  return {
    detectBurstVoting,
    detectContentSimilarity,
    detectLowDiversity,
    runAll,
  }
}
