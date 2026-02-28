import { z } from 'zod/v4'
import { didRegex } from '@barazo-forum/lexicons'

// ---------------------------------------------------------------------------
// Param schemas for block/mute action endpoints
// ---------------------------------------------------------------------------

/** Schema for validating :did route parameter. */
export const didParamSchema = z.object({
  did: z.string().regex(didRegex, 'Invalid DID format'),
})

export type DidParam = z.infer<typeof didParamSchema>
