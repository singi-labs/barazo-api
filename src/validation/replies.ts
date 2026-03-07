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

/** Schema for creating a new reply to a topic. */
export const createReplySchema = z.object({
  content: z
    .string()
    .min(1, 'Content is required')
    .max(50000, 'Content must be at most 50,000 characters'),
  parentUri: z.string().min(1, 'Parent URI must not be empty').optional(),
  labels: selfLabelsSchema.optional(),
})

export type CreateReplyInput = z.infer<typeof createReplySchema>

/** Schema for updating an existing reply (content and optional labels). */
export const updateReplySchema = z.object({
  content: z
    .string()
    .min(1, 'Content must not be empty')
    .max(50000, 'Content must be at most 50,000 characters'),
  labels: selfLabelsSchema.optional(),
})

export type UpdateReplyInput = z.infer<typeof updateReplySchema>

// ---------------------------------------------------------------------------
// Query schemas
// ---------------------------------------------------------------------------

/** Schema for listing replies with pagination. */
export const replyQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z
    .string()
    .transform((val) => Number(val))
    .pipe(z.number().int().min(1).max(100))
    .optional()
    .default(25),
  depth: z
    .string()
    .transform((val) => Number(val))
    .pipe(z.number().int().min(1).max(100))
    .optional()
    .default(10),
})

export type ReplyQueryInput = z.infer<typeof replyQuerySchema>

// ---------------------------------------------------------------------------
// Response schemas (for OpenAPI documentation)
// ---------------------------------------------------------------------------

/** Schema describing a single reply in API responses. */
export const replyResponseSchema = z.object({
  uri: z.string(),
  rkey: z.string(),
  authorDid: z.string(),
  content: z.string(),
  rootUri: z.string(),
  rootCid: z.string(),
  parentUri: z.string(),
  parentCid: z.string(),
  labels: z.object({ values: z.array(z.object({ val: z.string() })) }).nullable(),
  communityDid: z.string(),
  cid: z.string(),
  reactionCount: z.number(),
  createdAt: z.string(),
  indexedAt: z.string(),
})

export type ReplyResponse = z.infer<typeof replyResponseSchema>

/** Schema for a paginated reply list response. */
export const replyListResponseSchema = z.object({
  replies: z.array(replyResponseSchema),
  cursor: z.string().nullable(),
})

export type ReplyListResponse = z.infer<typeof replyListResponseSchema>
