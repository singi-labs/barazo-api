import { z } from 'zod/v4'

// ---------------------------------------------------------------------------
// Body schemas
// ---------------------------------------------------------------------------

/** Schema for PUT /api/users/me/preferences body. */
export const userPreferencesSchema = z.object({
  maturityLevel: z.enum(['sfw', 'mature']).optional(),
  mutedWords: z.array(z.string().min(1).max(200)).max(500).optional(),
  blockedDids: z.array(z.string().min(1)).max(1000).optional(),
  mutedDids: z.array(z.string().min(1)).max(1000).optional(),
  crossPostBluesky: z.boolean().optional(),
  crossPostFrontpage: z.boolean().optional(),
})

export type UserPreferencesInput = z.infer<typeof userPreferencesSchema>

/** Schema for PUT /api/users/me/communities/:communityId/preferences body. */
export const communityPreferencesSchema = z.object({
  maturityOverride: z.enum(['sfw', 'mature']).nullable().optional(),
  mutedWords: z.array(z.string().min(1).max(200)).max(500).nullable().optional(),
  blockedDids: z.array(z.string().min(1)).max(1000).nullable().optional(),
  mutedDids: z.array(z.string().min(1)).max(1000).nullable().optional(),
  notificationPrefs: z
    .object({
      replies: z.boolean(),
      reactions: z.boolean(),
      mentions: z.boolean(),
      modActions: z.boolean(),
    })
    .nullable()
    .optional(),
})

export type CommunityPreferencesInput = z.infer<typeof communityPreferencesSchema>

/** Valid declared age values: 0 = "rather not say", then jurisdiction thresholds + 18 */
const VALID_DECLARED_AGES = [0, 13, 14, 15, 16, 18] as const

/** Schema for POST /api/users/me/age-declaration body. */
export const ageDeclarationSchema = z.object({
  declaredAge: z
    .number()
    .refine(
      (val): val is (typeof VALID_DECLARED_AGES)[number] =>
        (VALID_DECLARED_AGES as readonly number[]).includes(val),
      { message: 'declaredAge must be one of: 0, 13, 14, 15, 16, 18' }
    ),
})

export type AgeDeclarationInput = z.infer<typeof ageDeclarationSchema>

// ---------------------------------------------------------------------------
// Query schemas
// ---------------------------------------------------------------------------

/** Schema for GET /api/users/resolve-handles query string. */
export const resolveHandlesSchema = z.object({
  handles: z
    .string()
    .min(1)
    .transform((val) =>
      val
        .split(',')
        .map((h) => h.trim())
        .filter(Boolean)
    )
    .pipe(z.array(z.string().min(1)).min(1).max(25)),
})

export type ResolveHandlesInput = z.infer<typeof resolveHandlesSchema>
