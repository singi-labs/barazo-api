import { z } from 'zod/v4'
import { maturityRatingSchema } from './categories.js'
import { reactionSetSchema } from './reactions.js'

// ---------------------------------------------------------------------------
// Request schemas
// ---------------------------------------------------------------------------

/** Hex color code pattern: # followed by 3, 4, 6, or 8 hex digits. */
const hexColorPattern = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/

/** Schema for updating community settings (all fields optional). */
export const updateSettingsSchema = z.object({
  communityName: z
    .string()
    .trim()
    .min(1, 'Community name is required')
    .max(100, 'Community name must be at most 100 characters')
    .optional(),
  maturityRating: maturityRatingSchema.optional(),
  reactionSet: reactionSetSchema.optional(),
  communityDescription: z
    .string()
    .trim()
    .max(500, 'Community description must be at most 500 characters')
    .nullable()
    .optional(),
  communityLogoUrl: z.url('Community logo must be a valid URL').nullable().optional(),
  faviconUrl: z.url('Favicon must be a valid URL').nullable().optional(),
  primaryColor: z
    .string()
    .regex(hexColorPattern, 'Primary color must be a valid hex color (e.g., #ff0000)')
    .nullable()
    .optional(),
  accentColor: z
    .string()
    .regex(hexColorPattern, 'Accent color must be a valid hex color (e.g., #00ff00)')
    .nullable()
    .optional(),
  jurisdictionCountry: z
    .string()
    .length(2, 'Jurisdiction country must be a 2-letter ISO 3166-1 alpha-2 code')
    .regex(/^[A-Z]{2}$/, 'Jurisdiction country must be uppercase letters')
    .nullable()
    .optional(),
  ageThreshold: z
    .number()
    .int('Age threshold must be an integer')
    .min(13, 'Age threshold must be at least 13')
    .max(18, 'Age threshold must be at most 18')
    .optional(),
  requireLoginForMature: z.boolean().optional(),
  maxReplyDepth: z
    .number()
    .int('Max reply depth must be an integer')
    .min(1, 'Max reply depth must be at least 1')
    .max(9999, 'Max reply depth must be at most 9999')
    .optional(),
})

export type UpdateSettingsInput = z.infer<typeof updateSettingsSchema>

// ---------------------------------------------------------------------------
// Response schemas (for OpenAPI documentation)
// ---------------------------------------------------------------------------

/** Schema describing community settings in API responses. */
export const settingsResponseSchema = z.object({
  id: z.string(),
  initialized: z.boolean(),
  communityDid: z.string().nullable(),
  adminDid: z.string().nullable(),
  communityName: z.string(),
  maturityRating: maturityRatingSchema,
  reactionSet: z.array(z.string()),
  communityDescription: z.string().nullable(),
  communityLogoUrl: z.string().nullable(),
  faviconUrl: z.string().nullable(),
  primaryColor: z.string().nullable(),
  accentColor: z.string().nullable(),
  jurisdictionCountry: z.string().nullable(),
  ageThreshold: z.number(),
  maxReplyDepth: z.number(),
  requireLoginForMature: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

export type SettingsResponse = z.infer<typeof settingsResponseSchema>
