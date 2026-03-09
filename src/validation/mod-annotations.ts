import { z } from 'zod'

// ---------------------------------------------------------------------------
// Mod notes
// ---------------------------------------------------------------------------

export const createModNoteSchema = z
  .object({
    subjectDid: z.string().min(1).optional(),
    subjectUri: z.string().min(1).optional(),
    content: z.string().min(1).max(5000),
  })
  .refine(
    (data) => {
      const hasDid = data.subjectDid !== undefined
      const hasUri = data.subjectUri !== undefined
      return (hasDid && !hasUri) || (!hasDid && hasUri)
    },
    { message: 'Exactly one of subjectDid or subjectUri must be provided' },
  )

export const modNoteQuerySchema = z.object({
  subjectDid: z.string().optional(),
  subjectUri: z.string().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
})

export const deleteModNoteSchema = z.object({
  id: z.coerce.number().int().positive(),
})

// ---------------------------------------------------------------------------
// Topic notices
// ---------------------------------------------------------------------------

export const createTopicNoticeSchema = z.object({
  topicUri: z.string().min(1),
  noticeType: z.enum(['closed', 'moved', 'outdated', 'announcement', 'custom']),
  headline: z.string().min(1).max(200),
  body: z.string().max(2000).optional(),
})

export const dismissTopicNoticeSchema = z.object({
  id: z.coerce.number().int().positive(),
})

export const topicNoticeQuerySchema = z.object({
  topicUri: z.string().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
})

// ---------------------------------------------------------------------------
// Mod warnings
// ---------------------------------------------------------------------------

export const createWarningSchema = z.object({
  targetDid: z.string().min(1),
  warningType: z.enum(['off_topic', 'harassment', 'rule_violation', 'other', 'custom']),
  message: z.string().min(1).max(2000),
  modComment: z.string().max(300).optional(),
  internalNote: z.string().max(5000).optional(),
})

export const warningQuerySchema = z.object({
  targetDid: z.string().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
})

export const acknowledgeWarningSchema = z.object({
  id: z.coerce.number().int().positive(),
})
