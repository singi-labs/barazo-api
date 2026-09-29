import type { LEXICON_IDS } from '@singi-labs/barazo-lexicons'

/** Record actions from the firehose. */
export type RecordAction = 'create' | 'update' | 'delete'

/** Account status from identity events. */
export type RepoStatus = 'active' | 'takendown' | 'suspended' | 'deactivated' | 'deleted'

/** A firehose record event (decoupled from @atproto/tap for testability). */
export interface RecordEvent {
  id: number
  action: RecordAction
  did: string
  rev: string
  collection: string
  rkey: string
  record?: Record<string, unknown>
  cid?: string
  live: boolean
}

/** A firehose identity event (decoupled from @atproto/tap for testability). */
export interface IdentityEvent {
  id: number
  did: string
  handle: string
  isActive: boolean
  status: RepoStatus
}

/** Interface for Tap client operations (for testability). */
export interface TapClient {
  addRepos(dids: string[]): Promise<void>
  removeRepos(dids: string[]): Promise<void>
}

/** Collections supported by Barazo. */
export const SUPPORTED_COLLECTIONS = [
  'forum.barazo.topic.post',
  'forum.barazo.topic.reply',
  'forum.barazo.interaction.reaction',
  'forum.barazo.interaction.vote',
] as const satisfies ReadonlyArray<(typeof LEXICON_IDS)[keyof typeof LEXICON_IDS]>

export type SupportedCollection = (typeof SUPPORTED_COLLECTIONS)[number]

/** Type guard: is the collection string one of the supported Barazo collections? */
export function isSupportedCollection(collection: string): collection is SupportedCollection {
  return (SUPPORTED_COLLECTIONS as readonly string[]).includes(collection)
}

/** Maps collection NSIDs to short indexer names. */
export const COLLECTION_MAP: Record<SupportedCollection, string> = {
  'forum.barazo.topic.post': 'topic',
  'forum.barazo.topic.reply': 'reply',
  'forum.barazo.interaction.reaction': 'reaction',
  'forum.barazo.interaction.vote': 'vote',
} as const
