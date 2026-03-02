import { z } from 'zod/v4'

// ---------------------------------------------------------------------------
// Self-label schemas (com.atproto.label.defs#selfLabels)
// ---------------------------------------------------------------------------

const selfLabelSchema = z.object({
  val: z.string().max(128),
})

const selfLabelsSchema = z.object({
  values: z.array(selfLabelSchema).max(10),
})

// ---------------------------------------------------------------------------
// Request schemas
// ---------------------------------------------------------------------------

/** Schema for creating a new topic. */
export const createTopicSchema = z.object({
  title: z
    .string()
    .trim()
    .min(1, 'Title is required')
    .max(200, 'Title must be at most 200 characters'),
  content: z
    .string()
    .min(1, 'Content is required')
    .max(100000, 'Content must be at most 100,000 characters'),
  category: z.string().trim().min(1, 'Category is required'),
  tags: z
    .array(z.string().trim().min(1).max(30, 'Tag must be at most 30 characters'))
    .max(5, 'At most 5 tags allowed')
    .optional(),
  labels: selfLabelsSchema.optional(),
})

export type CreateTopicInput = z.infer<typeof createTopicSchema>

/** Schema for updating an existing topic (all fields optional). */
export const updateTopicSchema = z.object({
  title: z
    .string()
    .trim()
    .min(1, 'Title must not be empty')
    .max(200, 'Title must be at most 200 characters')
    .optional(),
  content: z
    .string()
    .min(1, 'Content must not be empty')
    .max(100000, 'Content must be at most 100,000 characters')
    .optional(),
  category: z.string().trim().min(1, 'Category must not be empty').optional(),
  tags: z
    .array(z.string().trim().min(1).max(30, 'Tag must be at most 30 characters'))
    .max(5, 'At most 5 tags allowed')
    .optional(),
  labels: selfLabelsSchema.optional(),
})

export type UpdateTopicInput = z.infer<typeof updateTopicSchema>

// ---------------------------------------------------------------------------
// Query schemas
// ---------------------------------------------------------------------------

/** Schema for listing topics with pagination and optional filtering. */
export const topicQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z
    .string()
    .transform((val) => Number(val))
    .pipe(z.number().int().min(1).max(100))
    .optional()
    .default(25),
  category: z.string().optional(),
  tag: z.string().optional(),
  sort: z.enum(['latest', 'popular']).optional().default('latest'),
})

export type TopicQueryInput = z.infer<typeof topicQuerySchema>

// ---------------------------------------------------------------------------
// Response schemas (for OpenAPI documentation)
// ---------------------------------------------------------------------------

/** Schema describing a single topic in API responses. */
export const topicResponseSchema = z.object({
  uri: z.string(),
  rkey: z.string(),
  authorDid: z.string(),
  title: z.string(),
  content: z.string(),
  contentFormat: z.string().nullable(),
  category: z.string(),
  tags: z.array(z.string()).nullable(),
  labels: z.object({ values: z.array(z.object({ val: z.string() })) }).nullable(),
  communityDid: z.string(),
  cid: z.string(),
  replyCount: z.number(),
  reactionCount: z.number(),
  lastActivityAt: z.string(),
  createdAt: z.string(),
  indexedAt: z.string(),
})

export type TopicResponse = z.infer<typeof topicResponseSchema>

/** Schema for a paginated topic list response. */
export const topicListResponseSchema = z.object({
  topics: z.array(topicResponseSchema),
  cursor: z.string().nullable(),
})

export type TopicListResponse = z.infer<typeof topicListResponseSchema>
