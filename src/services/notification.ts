import { and, eq, inArray } from 'drizzle-orm'
import type { Database } from '../db/index.js'
import type { Logger } from '../lib/logger.js'
import { notifications } from '../db/schema/notifications.js'
import { userCommunityPreferences } from '../db/schema/user-preferences.js'
import { topics } from '../db/schema/topics.js'
import { replies } from '../db/schema/replies.js'
import { users } from '../db/schema/users.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum unique @mentions that generate notifications per post. */
const MAX_MENTION_NOTIFICATIONS = 10

/**
 * Regex to extract @mentions from content.
 * Matches `@handle.domain.tld` patterns (AT Protocol handles).
 * Does NOT match bare `@word` without a dot -- that avoids false positives.
 */
const MENTION_REGEX =
  /@([a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+)/g

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type NotificationType =
  | 'reply'
  | 'reaction'
  | 'mention'
  | 'mod_action'
  | 'cross_post_failed'
  | 'cross_post_revoked'

export interface CrossPostScopeRevokedNotificationParams {
  /** DID of the user whose cross-post scopes were revoked (notification recipient). */
  authorDid: string
  /** Community DID. */
  communityDid: string
}

export interface NotificationService {
  notifyOnReply(params: ReplyNotificationParams): Promise<void>
  notifyOnReaction(params: ReactionNotificationParams): Promise<void>
  notifyOnModAction(params: ModActionNotificationParams): Promise<void>
  notifyOnMentions(params: MentionNotificationParams): Promise<void>
  notifyOnCrossPostFailure(params: CrossPostFailureNotificationParams): Promise<void>
  notifyOnCrossPostScopeRevoked(params: CrossPostScopeRevokedNotificationParams): Promise<void>
}

export interface ReplyNotificationParams {
  /** The reply URI (used as subjectUri in the notification). */
  replyUri: string
  /** DID of the user who created the reply. */
  actorDid: string
  /** URI of the root topic. */
  topicUri: string
  /** URI of the parent (topic URI if direct reply, reply URI if nested). */
  parentUri: string
  /** Community DID. */
  communityDid: string
}

export interface ReactionNotificationParams {
  /** The subject URI that was reacted to. */
  subjectUri: string
  /** DID of the user who reacted. */
  actorDid: string
  /** Community DID. */
  communityDid: string
}

export interface ModActionNotificationParams {
  /** URI of the content affected by the mod action. */
  targetUri: string
  /** DID of the moderator. */
  moderatorDid: string
  /** DID of the content author (the notification recipient). */
  targetDid: string
  /** Community DID. */
  communityDid: string
}

export interface MentionNotificationParams {
  /** The content containing @mentions. */
  content: string
  /** URI of the post/reply containing the mentions. */
  subjectUri: string
  /** DID of the user who wrote the content. */
  actorDid: string
  /** Community DID. */
  communityDid: string
}

export interface CrossPostFailureNotificationParams {
  /** URI of the topic that failed to cross-post. */
  topicUri: string
  /** DID of the topic author (notification recipient). */
  authorDid: string
  /** Which cross-post service failed ("bluesky" or "frontpage"). */
  service: string
  /** Community DID. */
  communityDid: string
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type NotificationPrefs = {
  replies: boolean
  reactions: boolean
  mentions: boolean
  modActions: boolean
}

/**
 * Determine whether a notification of a given type should be delivered based on
 * the recipient's stored preferences.
 *
 * Defaults when no preferences are stored:
 *   - mentions: true (enabled by default)
 *   - replies, reactions, modActions: false
 *
 * mod_action is always delivered regardless of preferences — users must receive
 * moderation decisions about their content.
 */
export function isNotificationAllowed(
  type: NotificationType,
  prefs: NotificationPrefs | null | undefined
): boolean {
  if (type === 'mod_action') {
    return true
  }

  if (!prefs) {
    return type === 'mention'
  }

  if (type === 'reply') return prefs.replies
  if (type === 'reaction') return prefs.reactions
  if (type === 'mention') return prefs.mentions

  return true
}

/**
 * Extract unique AT Protocol handles from content text.
 * Returns at most MAX_MENTION_NOTIFICATIONS handles.
 */
export function extractMentions(content: string): string[] {
  const matches = new Set<string>()
  let match: RegExpExecArray | null

  // Reset regex lastIndex for safety
  MENTION_REGEX.lastIndex = 0

  while ((match = MENTION_REGEX.exec(content)) !== null) {
    const handle = match[1]
    if (handle) {
      matches.add(handle.toLowerCase())
    }
    if (matches.size >= MAX_MENTION_NOTIFICATIONS) {
      break
    }
  }

  return [...matches]
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a notification service that generates notifications for forum events.
 *
 * Notifications are fire-and-forget: failures are logged but never block
 * the calling flow. Self-notifications are suppressed (you don't get
 * notified about your own actions).
 */
export function createNotificationService(db: Database, logger: Logger): NotificationService {
  /**
   * Insert a single notification row.
   * Skips silently if recipientDid === actorDid (no self-notifications).
   * Checks per-community notification preferences before inserting.
   */
  async function insertNotification(
    recipientDid: string,
    type: NotificationType,
    subjectUri: string,
    actorDid: string,
    communityDid: string
  ): Promise<void> {
    if (recipientDid === actorDid) {
      return
    }

    if (type !== 'mod_action') {
      const prefRows = await db
        .select({ notificationPrefs: userCommunityPreferences.notificationPrefs })
        .from(userCommunityPreferences)
        .where(
          and(
            eq(userCommunityPreferences.did, recipientDid),
            eq(userCommunityPreferences.communityDid, communityDid)
          )
        )

      const prefs = prefRows[0]?.notificationPrefs
      if (!isNotificationAllowed(type, prefs)) {
        return
      }
    }

    await db.insert(notifications).values({
      recipientDid,
      type,
      subjectUri,
      actorDid,
      communityDid,
    })
  }

  return {
    async notifyOnReply(params: ReplyNotificationParams): Promise<void> {
      try {
        // Look up topic author from DB
        const topicRows = await db
          .select({ authorDid: topics.authorDid })
          .from(topics)
          .where(eq(topics.uri, params.topicUri))

        const topicAuthor = topicRows[0]?.authorDid

        if (topicAuthor) {
          await insertNotification(
            topicAuthor,
            'reply',
            params.replyUri,
            params.actorDid,
            params.communityDid
          )
        }

        // If this is a nested reply (parentUri !== topicUri), also notify
        // the parent reply author (if different from topic author)
        if (params.parentUri !== params.topicUri) {
          const parentReplyRows = await db
            .select({ authorDid: replies.authorDid })
            .from(replies)
            .where(eq(replies.uri, params.parentUri))

          const parentAuthor = parentReplyRows[0]?.authorDid
          if (parentAuthor && parentAuthor !== topicAuthor) {
            await insertNotification(
              parentAuthor,
              'reply',
              params.replyUri,
              params.actorDid,
              params.communityDid
            )
          }
        }
      } catch (err: unknown) {
        logger.error({ err, replyUri: params.replyUri }, 'Failed to generate reply notifications')
      }
    },

    async notifyOnReaction(params: ReactionNotificationParams): Promise<void> {
      try {
        // Look up the content author from topics or replies
        const topicRows = await db
          .select({ authorDid: topics.authorDid })
          .from(topics)
          .where(eq(topics.uri, params.subjectUri))

        let contentAuthor = topicRows[0]?.authorDid

        if (!contentAuthor) {
          const replyRows = await db
            .select({ authorDid: replies.authorDid })
            .from(replies)
            .where(eq(replies.uri, params.subjectUri))

          contentAuthor = replyRows[0]?.authorDid
        }

        if (contentAuthor) {
          await insertNotification(
            contentAuthor,
            'reaction',
            params.subjectUri,
            params.actorDid,
            params.communityDid
          )
        }
      } catch (err: unknown) {
        logger.error(
          { err, subjectUri: params.subjectUri },
          'Failed to generate reaction notification'
        )
      }
    },

    async notifyOnModAction(params: ModActionNotificationParams): Promise<void> {
      try {
        await insertNotification(
          params.targetDid,
          'mod_action',
          params.targetUri,
          params.moderatorDid,
          params.communityDid
        )
      } catch (err: unknown) {
        logger.error(
          { err, targetUri: params.targetUri },
          'Failed to generate mod action notification'
        )
      }
    },

    async notifyOnMentions(params: MentionNotificationParams): Promise<void> {
      try {
        const handles = extractMentions(params.content)
        if (handles.length === 0) {
          return
        }

        // Resolve handles to DIDs via the users table
        const resolvedUsers = await db
          .select({ did: users.did, handle: users.handle })
          .from(users)
          .where(inArray(users.handle, handles))

        // Generate a notification for each resolved user
        for (const resolved of resolvedUsers) {
          await insertNotification(
            resolved.did,
            'mention',
            params.subjectUri,
            params.actorDid,
            params.communityDid
          )
        }
      } catch (err: unknown) {
        logger.error(
          { err, subjectUri: params.subjectUri },
          'Failed to generate mention notifications'
        )
      }
    },

    async notifyOnCrossPostFailure(params: CrossPostFailureNotificationParams): Promise<void> {
      try {
        // Use communityDid as actorDid since this is a system-generated
        // notification (avoids self-notification suppression)
        await db.insert(notifications).values({
          recipientDid: params.authorDid,
          type: 'cross_post_failed',
          subjectUri: params.topicUri,
          actorDid: params.communityDid,
          communityDid: params.communityDid,
        })
      } catch (err: unknown) {
        logger.error(
          { err, topicUri: params.topicUri, service: params.service },
          'Failed to generate cross-post failure notification'
        )
      }
    },

    async notifyOnCrossPostScopeRevoked(
      params: CrossPostScopeRevokedNotificationParams
    ): Promise<void> {
      try {
        // Use communityDid as actorDid since this is a system-generated
        // notification (avoids self-notification suppression)
        await db.insert(notifications).values({
          recipientDid: params.authorDid,
          type: 'cross_post_revoked',
          subjectUri: params.communityDid,
          actorDid: params.communityDid,
          communityDid: params.communityDid,
        })
      } catch (err: unknown) {
        logger.error(
          { err, authorDid: params.authorDid },
          'Failed to generate cross-post scope revoked notification'
        )
      }
    },
  }
}
