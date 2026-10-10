import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  createNotificationService,
  extractMentions,
  isNotificationAllowed,
} from '../../../src/services/notification.js'
import type { NotificationService } from '../../../src/services/notification.js'
import { createMockDb, createChainableProxy, resetDbMocks } from '../../helpers/mock-db.js'
import type { MockDb } from '../../helpers/mock-db.js'

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const ALLOW_ALL_PREFS = { replies: true, reactions: true, mentions: true, modActions: true }
const DENY_ALL_PREFS = { replies: false, reactions: false, mentions: false, modActions: false }

const ACTOR_DID = 'did:plc:actor123'
const TOPIC_AUTHOR_DID = 'did:plc:topicauthor456'
const REPLY_AUTHOR_DID = 'did:plc:replyauthor789'
const MODERATOR_DID = 'did:plc:mod999'
const COMMUNITY_DID = 'did:plc:community123'

const TOPIC_URI = `at://${TOPIC_AUTHOR_DID}/forum.barazo.topic.post/topic1`
const REPLY_URI = `at://${ACTOR_DID}/forum.barazo.topic.reply/reply1`
const PARENT_REPLY_URI = `at://${REPLY_AUTHOR_DID}/forum.barazo.topic.reply/parentreply1`

// ---------------------------------------------------------------------------
// Mock logger
// ---------------------------------------------------------------------------

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  fatal: vi.fn(),
  trace: vi.fn(),
  child: vi.fn(() => mockLogger),
  level: 'info',
  silent: vi.fn(),
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let mockDb: MockDb
let service: NotificationService

beforeEach(() => {
  vi.clearAllMocks()
  mockDb = createMockDb()
  resetDbMocks(mockDb)
  service = createNotificationService(mockDb as never, mockLogger as never)
})

// ===========================================================================
// extractMentions
// ===========================================================================

describe('extractMentions', () => {
  it('extracts single AT Protocol handle', () => {
    const result = extractMentions('Hello @jay.bsky.team, welcome!')
    expect(result).toEqual(['jay.bsky.team'])
  })

  it('extracts multiple handles', () => {
    const result = extractMentions('cc @jay.bsky.team @alex.example.com')
    expect(result).toEqual(['jay.bsky.team', 'alex.example.com'])
  })

  it('deduplicates handles (case-insensitive)', () => {
    const result = extractMentions('@Jay.Bsky.Team and @jay.bsky.team')
    expect(result).toEqual(['jay.bsky.team'])
  })

  it('ignores bare @word without a dot', () => {
    const result = extractMentions('Hello @everyone, this is a test')
    expect(result).toEqual([])
  })

  it('limits to 10 unique mentions', () => {
    const handles = Array.from({ length: 15 }, (_, i) => `@user${String(i)}.bsky.social`)
    const content = handles.join(' ')
    const result = extractMentions(content)
    expect(result).toHaveLength(10)
  })

  it('returns empty array for content without mentions', () => {
    const result = extractMentions('No mentions here at all.')
    expect(result).toEqual([])
  })

  it('handles handles with hyphens', () => {
    const result = extractMentions('Hey @my-handle.bsky.social')
    expect(result).toEqual(['my-handle.bsky.social'])
  })

  it('handles handles with subdomains', () => {
    const result = extractMentions('@user.example.co.uk mentioned')
    expect(result).toEqual(['user.example.co.uk'])
  })
})

// ===========================================================================
// notifyOnReply
// ===========================================================================

describe('notifyOnReply', () => {
  it('notifies topic author when someone replies', async () => {
    // Mock: select topic author, then prefs (allow replies)
    mockDb.select
      .mockReturnValueOnce(createChainableProxy([{ authorDid: TOPIC_AUTHOR_DID }]))
      .mockReturnValueOnce(createChainableProxy([{ notificationPrefs: ALLOW_ALL_PREFS }]))

    // Mock: insert notification
    const insertChain = createChainableProxy()
    mockDb.insert.mockReturnValue(insertChain)

    await service.notifyOnReply({
      replyUri: REPLY_URI,
      actorDid: ACTOR_DID,
      topicUri: TOPIC_URI,
      parentUri: TOPIC_URI, // direct reply to topic
      communityDid: COMMUNITY_DID,
    })

    expect(mockDb.insert).toHaveBeenCalled()
  })

  it('does not notify when replying to own topic', async () => {
    // Actor IS the topic author
    const selectChain = createChainableProxy([{ authorDid: ACTOR_DID }])
    mockDb.select.mockReturnValue(selectChain)

    const insertChain = createChainableProxy()
    mockDb.insert.mockReturnValue(insertChain)

    await service.notifyOnReply({
      replyUri: REPLY_URI,
      actorDid: ACTOR_DID,
      topicUri: `at://${ACTOR_DID}/forum.barazo.topic.post/topic1`,
      parentUri: `at://${ACTOR_DID}/forum.barazo.topic.post/topic1`,
      communityDid: COMMUNITY_DID,
    })

    // insert should not be called for notifications (only select for topic lookup)
    expect(mockDb.insert).not.toHaveBeenCalled()
  })

  it('notifies both topic author and parent reply author for nested replies', async () => {
    // select: topic author, prefs for topic author, parent reply author, prefs for parent author
    mockDb.select
      .mockReturnValueOnce(createChainableProxy([{ authorDid: TOPIC_AUTHOR_DID }]))
      .mockReturnValueOnce(createChainableProxy([{ notificationPrefs: ALLOW_ALL_PREFS }]))
      .mockReturnValueOnce(createChainableProxy([{ authorDid: REPLY_AUTHOR_DID }]))
      .mockReturnValueOnce(createChainableProxy([{ notificationPrefs: ALLOW_ALL_PREFS }]))

    const insertChain = createChainableProxy()
    mockDb.insert.mockReturnValue(insertChain)

    await service.notifyOnReply({
      replyUri: REPLY_URI,
      actorDid: ACTOR_DID,
      topicUri: TOPIC_URI,
      parentUri: PARENT_REPLY_URI, // nested reply
      communityDid: COMMUNITY_DID,
    })

    // Should insert two notifications: one for topic author, one for parent reply author
    expect(mockDb.insert).toHaveBeenCalledTimes(2)
  })

  it('does not duplicate notification when parent reply author is topic author', async () => {
    // Same author for topic and parent reply
    // select: topic author, prefs for topic author, parent reply author (same person, deduplicated)
    mockDb.select
      .mockReturnValueOnce(createChainableProxy([{ authorDid: TOPIC_AUTHOR_DID }]))
      .mockReturnValueOnce(createChainableProxy([{ notificationPrefs: ALLOW_ALL_PREFS }]))
      .mockReturnValueOnce(createChainableProxy([{ authorDid: TOPIC_AUTHOR_DID }]))
    // No prefs lookup for parent since parentAuthor === topicAuthor (deduplicated before insertNotification)

    const insertChain = createChainableProxy()
    mockDb.insert.mockReturnValue(insertChain)

    await service.notifyOnReply({
      replyUri: REPLY_URI,
      actorDid: ACTOR_DID,
      topicUri: TOPIC_URI,
      parentUri: PARENT_REPLY_URI,
      communityDid: COMMUNITY_DID,
    })

    // Only one notification (topic author = parent reply author)
    expect(mockDb.insert).toHaveBeenCalledTimes(1)
  })

  it('logs error and does not throw on DB failure', async () => {
    mockDb.select.mockReturnValue(createChainableProxy(Promise.reject(new Error('DB error'))))

    await expect(
      service.notifyOnReply({
        replyUri: REPLY_URI,
        actorDid: ACTOR_DID,
        topicUri: TOPIC_URI,
        parentUri: TOPIC_URI,
        communityDid: COMMUNITY_DID,
      })
    ).resolves.toBeUndefined()

    expect(mockLogger.error).toHaveBeenCalled()
  })
})

// ===========================================================================
// notifyOnReaction
// ===========================================================================

describe('notifyOnReaction', () => {
  it('notifies topic author when their topic gets a reaction', async () => {
    // select: topic author, then prefs (allow reactions)
    mockDb.select
      .mockReturnValueOnce(createChainableProxy([{ authorDid: TOPIC_AUTHOR_DID }]))
      .mockReturnValueOnce(createChainableProxy([{ notificationPrefs: ALLOW_ALL_PREFS }]))

    const insertChain = createChainableProxy()
    mockDb.insert.mockReturnValue(insertChain)

    await service.notifyOnReaction({
      subjectUri: TOPIC_URI,
      actorDid: ACTOR_DID,
      communityDid: COMMUNITY_DID,
    })

    expect(mockDb.insert).toHaveBeenCalled()
  })

  it('notifies reply author when their reply gets a reaction', async () => {
    // select: topic lookup (no match), reply lookup (match), then prefs (allow reactions)
    mockDb.select
      .mockReturnValueOnce(createChainableProxy([]))
      .mockReturnValueOnce(createChainableProxy([{ authorDid: REPLY_AUTHOR_DID }]))
      .mockReturnValueOnce(createChainableProxy([{ notificationPrefs: ALLOW_ALL_PREFS }]))

    const insertChain = createChainableProxy()
    mockDb.insert.mockReturnValue(insertChain)

    await service.notifyOnReaction({
      subjectUri: PARENT_REPLY_URI,
      actorDid: ACTOR_DID,
      communityDid: COMMUNITY_DID,
    })

    expect(mockDb.insert).toHaveBeenCalled()
  })

  it('does not notify when reacting to own content', async () => {
    const selectChain = createChainableProxy([{ authorDid: ACTOR_DID }])
    mockDb.select.mockReturnValue(selectChain)

    const insertChain = createChainableProxy()
    mockDb.insert.mockReturnValue(insertChain)

    await service.notifyOnReaction({
      subjectUri: `at://${ACTOR_DID}/forum.barazo.topic.post/mytopic`,
      actorDid: ACTOR_DID,
      communityDid: COMMUNITY_DID,
    })

    expect(mockDb.insert).not.toHaveBeenCalled()
  })
})

// ===========================================================================
// notifyOnModAction
// ===========================================================================

describe('notifyOnModAction', () => {
  it('notifies content author of moderation action', async () => {
    const insertChain = createChainableProxy()
    mockDb.insert.mockReturnValue(insertChain)

    await service.notifyOnModAction({
      targetUri: TOPIC_URI,
      moderatorDid: MODERATOR_DID,
      targetDid: TOPIC_AUTHOR_DID,
      communityDid: COMMUNITY_DID,
    })

    expect(mockDb.insert).toHaveBeenCalled()
  })

  it('does not notify when moderator acts on own content', async () => {
    const insertChain = createChainableProxy()
    mockDb.insert.mockReturnValue(insertChain)

    await service.notifyOnModAction({
      targetUri: TOPIC_URI,
      moderatorDid: MODERATOR_DID,
      targetDid: MODERATOR_DID, // same person
      communityDid: COMMUNITY_DID,
    })

    expect(mockDb.insert).not.toHaveBeenCalled()
  })
})

// ===========================================================================
// notifyOnMentions
// ===========================================================================

describe('notifyOnMentions', () => {
  it('resolves handles to DIDs and creates mention notifications', async () => {
    // select: resolve handles, then prefs for the mentioned user (allow mentions)
    mockDb.select
      .mockReturnValueOnce(
        createChainableProxy([{ did: 'did:plc:mentioned1', handle: 'jay.bsky.team' }])
      )
      .mockReturnValueOnce(createChainableProxy([{ notificationPrefs: ALLOW_ALL_PREFS }]))

    const insertChain = createChainableProxy()
    mockDb.insert.mockReturnValue(insertChain)

    await service.notifyOnMentions({
      content: 'Hey @jay.bsky.team check this out',
      subjectUri: REPLY_URI,
      actorDid: ACTOR_DID,
      communityDid: COMMUNITY_DID,
    })

    expect(mockDb.insert).toHaveBeenCalled()
  })

  it('does not create notifications for unresolved handles', async () => {
    // No users found for the handle
    const emptySelectChain = createChainableProxy([])
    mockDb.select.mockReturnValue(emptySelectChain)

    await service.notifyOnMentions({
      content: 'Hey @unknown.example.com',
      subjectUri: REPLY_URI,
      actorDid: ACTOR_DID,
      communityDid: COMMUNITY_DID,
    })

    expect(mockDb.insert).not.toHaveBeenCalled()
  })

  it('does not create notification for self-mention', async () => {
    const userSelectChain = createChainableProxy([{ did: ACTOR_DID, handle: 'me.bsky.social' }])
    mockDb.select.mockReturnValue(userSelectChain)

    const insertChain = createChainableProxy()
    mockDb.insert.mockReturnValue(insertChain)

    await service.notifyOnMentions({
      content: 'I am @me.bsky.social',
      subjectUri: REPLY_URI,
      actorDid: ACTOR_DID,
      communityDid: COMMUNITY_DID,
    })

    expect(mockDb.insert).not.toHaveBeenCalled()
  })

  it('skips when content has no mentions', async () => {
    await service.notifyOnMentions({
      content: 'No mentions here',
      subjectUri: REPLY_URI,
      actorDid: ACTOR_DID,
      communityDid: COMMUNITY_DID,
    })

    // Should not even query the DB
    expect(mockDb.select).not.toHaveBeenCalled()
    expect(mockDb.insert).not.toHaveBeenCalled()
  })
})

// ===========================================================================
// isNotificationAllowed (pure helper)
// ===========================================================================

describe('isNotificationAllowed', () => {
  it('allows reply when prefs.replies is true', () => {
    expect(isNotificationAllowed('reply', { ...DENY_ALL_PREFS, replies: true })).toBe(true)
  })

  it('denies reply when prefs.replies is false', () => {
    expect(isNotificationAllowed('reply', { ...ALLOW_ALL_PREFS, replies: false })).toBe(false)
  })

  it('allows reaction when prefs.reactions is true', () => {
    expect(isNotificationAllowed('reaction', { ...DENY_ALL_PREFS, reactions: true })).toBe(true)
  })

  it('denies reaction when prefs.reactions is false', () => {
    expect(isNotificationAllowed('reaction', { ...ALLOW_ALL_PREFS, reactions: false })).toBe(false)
  })

  it('allows mention when prefs.mentions is true', () => {
    expect(isNotificationAllowed('mention', { ...DENY_ALL_PREFS, mentions: true })).toBe(true)
  })

  it('denies mention when prefs.mentions is false', () => {
    expect(isNotificationAllowed('mention', { ...ALLOW_ALL_PREFS, mentions: false })).toBe(false)
  })

  it('defaults to mentions=true when prefs are null', () => {
    expect(isNotificationAllowed('mention', null)).toBe(true)
  })

  it('defaults to replies=false when prefs are null', () => {
    expect(isNotificationAllowed('reply', null)).toBe(false)
  })

  it('defaults to reactions=false when prefs are null', () => {
    expect(isNotificationAllowed('reaction', null)).toBe(false)
  })

  it('mod_action is always allowed regardless of prefs', () => {
    expect(isNotificationAllowed('mod_action', DENY_ALL_PREFS)).toBe(true)
    expect(isNotificationAllowed('mod_action', null)).toBe(true)
  })
})

// ===========================================================================
// Preference-based filtering (integration with notification service)
// ===========================================================================

describe('notification preference filtering', () => {
  it('suppresses reply notification when replies preference is disabled', async () => {
    mockDb.select
      .mockReturnValueOnce(createChainableProxy([{ authorDid: TOPIC_AUTHOR_DID }]))
      .mockReturnValueOnce(createChainableProxy([{ notificationPrefs: { ...DENY_ALL_PREFS } }]))

    const insertChain = createChainableProxy()
    mockDb.insert.mockReturnValue(insertChain)

    await service.notifyOnReply({
      replyUri: REPLY_URI,
      actorDid: ACTOR_DID,
      topicUri: TOPIC_URI,
      parentUri: TOPIC_URI,
      communityDid: COMMUNITY_DID,
    })

    expect(mockDb.insert).not.toHaveBeenCalled()
  })

  it('suppresses reaction notification when reactions preference is disabled', async () => {
    mockDb.select
      .mockReturnValueOnce(createChainableProxy([{ authorDid: TOPIC_AUTHOR_DID }]))
      .mockReturnValueOnce(createChainableProxy([{ notificationPrefs: { ...DENY_ALL_PREFS } }]))

    const insertChain = createChainableProxy()
    mockDb.insert.mockReturnValue(insertChain)

    await service.notifyOnReaction({
      subjectUri: TOPIC_URI,
      actorDid: ACTOR_DID,
      communityDid: COMMUNITY_DID,
    })

    expect(mockDb.insert).not.toHaveBeenCalled()
  })

  it('suppresses mention notification when mentions preference is disabled', async () => {
    mockDb.select
      .mockReturnValueOnce(
        createChainableProxy([{ did: 'did:plc:mentioned1', handle: 'jay.bsky.team' }])
      )
      .mockReturnValueOnce(createChainableProxy([{ notificationPrefs: { ...DENY_ALL_PREFS } }]))

    const insertChain = createChainableProxy()
    mockDb.insert.mockReturnValue(insertChain)

    await service.notifyOnMentions({
      content: 'Hey @jay.bsky.team',
      subjectUri: REPLY_URI,
      actorDid: ACTOR_DID,
      communityDid: COMMUNITY_DID,
    })

    expect(mockDb.insert).not.toHaveBeenCalled()
  })

  it('sends reply notification when no prefs exist and default allows it (no row)', async () => {
    // No prefs row found → default: replies=false, so no notification
    mockDb.select
      .mockReturnValueOnce(createChainableProxy([{ authorDid: TOPIC_AUTHOR_DID }]))
      .mockReturnValueOnce(createChainableProxy([])) // empty → no prefs row

    await service.notifyOnReply({
      replyUri: REPLY_URI,
      actorDid: ACTOR_DID,
      topicUri: TOPIC_URI,
      parentUri: TOPIC_URI,
      communityDid: COMMUNITY_DID,
    })

    expect(mockDb.insert).not.toHaveBeenCalled()
  })

  it('sends mention notification when no prefs exist (default: mentions=true)', async () => {
    // No prefs row → default: mentions=true → notification is sent
    mockDb.select
      .mockReturnValueOnce(
        createChainableProxy([{ did: 'did:plc:mentioned1', handle: 'jay.bsky.team' }])
      )
      .mockReturnValueOnce(createChainableProxy([])) // empty → no prefs row

    const insertChain = createChainableProxy()
    mockDb.insert.mockReturnValue(insertChain)

    await service.notifyOnMentions({
      content: 'Hey @jay.bsky.team',
      subjectUri: REPLY_URI,
      actorDid: ACTOR_DID,
      communityDid: COMMUNITY_DID,
    })

    expect(mockDb.insert).toHaveBeenCalled()
  })

  it('always delivers mod_action notification regardless of preferences', async () => {
    const insertChain = createChainableProxy()
    mockDb.insert.mockReturnValue(insertChain)

    await service.notifyOnModAction({
      targetUri: TOPIC_URI,
      moderatorDid: MODERATOR_DID,
      targetDid: TOPIC_AUTHOR_DID,
      communityDid: COMMUNITY_DID,
    })

    // No prefs lookup, insert always called
    expect(mockDb.select).not.toHaveBeenCalled()
    expect(mockDb.insert).toHaveBeenCalled()
  })
})

// ===========================================================================
// notifyOnCrossPostFailure
// ===========================================================================

describe('notifyOnCrossPostFailure', () => {
  it('creates a cross_post_failed notification for the topic author', async () => {
    const insertChain = createChainableProxy()
    mockDb.insert.mockReturnValue(insertChain)

    await service.notifyOnCrossPostFailure({
      topicUri: TOPIC_URI,
      authorDid: ACTOR_DID,
      service: 'bluesky',
      communityDid: COMMUNITY_DID,
    })

    expect(mockDb.insert).toHaveBeenCalled()
  })

  it('creates separate notifications for different failed services', async () => {
    const insertChain = createChainableProxy()
    mockDb.insert.mockReturnValue(insertChain)

    await service.notifyOnCrossPostFailure({
      topicUri: TOPIC_URI,
      authorDid: ACTOR_DID,
      service: 'bluesky',
      communityDid: COMMUNITY_DID,
    })

    await service.notifyOnCrossPostFailure({
      topicUri: TOPIC_URI,
      authorDid: ACTOR_DID,
      service: 'frontpage',
      communityDid: COMMUNITY_DID,
    })

    expect(mockDb.insert).toHaveBeenCalledTimes(2)
  })

  it('logs error and does not throw on DB failure', async () => {
    const insertChain = createChainableProxy()
    insertChain.values.mockRejectedValue(new Error('DB error'))
    mockDb.insert.mockReturnValue(insertChain)

    await expect(
      service.notifyOnCrossPostFailure({
        topicUri: TOPIC_URI,
        authorDid: ACTOR_DID,
        service: 'bluesky',
        communityDid: COMMUNITY_DID,
      })
    ).resolves.toBeUndefined()

    expect(mockLogger.error).toHaveBeenCalled()
  })
})
