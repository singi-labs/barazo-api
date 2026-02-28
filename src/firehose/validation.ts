import {
  topicPostSchema,
  topicReplySchema,
  reactionSchema,
  voteSchema,
  type TopicPostInput,
  type TopicReplyInput,
  type ReactionInput,
  type VoteInput,
} from '@barazo-forum/lexicons'
import type { SupportedCollection } from './types.js'
import { isSupportedCollection } from './types.js'

const MAX_RECORD_SIZE = 64 * 1024 // 64KB

/** Maps collection NSIDs to their validated Zod output type. */
export type CollectionDataMap = {
  'forum.barazo.topic.post': TopicPostInput
  'forum.barazo.topic.reply': TopicReplyInput
  'forum.barazo.interaction.reaction': ReactionInput
  'forum.barazo.interaction.vote': VoteInput
}

type ValidationResult<T = unknown> = { success: true; data: T } | { success: false; error: string }

const schemaMap: Record<
  SupportedCollection,
  { safeParse: (data: unknown) => { success: boolean; data?: unknown; error?: unknown } }
> = {
  'forum.barazo.topic.post': topicPostSchema,
  'forum.barazo.topic.reply': topicReplySchema,
  'forum.barazo.interaction.reaction': reactionSchema,
  'forum.barazo.interaction.vote': voteSchema,
}

export function validateRecord<C extends SupportedCollection>(
  collection: C,
  record: unknown
): ValidationResult<CollectionDataMap[C]> {
  if (!isSupportedCollection(collection)) {
    return { success: false, error: `Unsupported collection: ${String(collection)}` }
  }

  // Size check: rough estimate using JSON serialization
  const serialized = JSON.stringify(record)
  if (serialized.length > MAX_RECORD_SIZE) {
    return {
      success: false,
      error: `Record exceeds maximum size of ${String(MAX_RECORD_SIZE)} bytes`,
    }
  }

  const schema = schemaMap[collection]
  const result = schema.safeParse(record)
  if (!result.success) {
    return { success: false, error: `Validation failed for ${collection}` }
  }

  return { success: true, data: result.data as CollectionDataMap[C] }
}
