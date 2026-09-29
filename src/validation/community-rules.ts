import { z } from 'zod'

// ---------------------------------------------------------------------------
// Community rules schemas
// ---------------------------------------------------------------------------

export const createRuleSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().min(1),
})

export const updateRuleSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().min(1),
})

export const reorderRulesSchema = z.object({
  order: z
    .array(
      z.object({
        id: z.number().int().positive(),
        displayOrder: z.number().int().min(0),
      })
    )
    .min(1),
})

export const ruleVersionsQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
})
