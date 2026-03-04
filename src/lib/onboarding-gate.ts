import { eq, and } from 'drizzle-orm'
import {
  communityOnboardingFields,
  userOnboardingResponses,
} from '../db/schema/onboarding-fields.js'
import type { Database } from '../db/index.js'

export interface OnboardingCheckResult {
  complete: boolean
  missingFields: { id: string; label: string; fieldType: string }[]
}

/**
 * Check whether a user has completed all mandatory onboarding fields
 * for a community. Returns complete=true if no mandatory fields are
 * configured or all have responses.
 *
 * All fields (platform and admin) live in the database -- no virtual
 * field injection needed.
 */
export async function checkOnboardingComplete(
  db: Database,
  did: string,
  communityDid: string
): Promise<OnboardingCheckResult> {
  const fields = await db
    .select()
    .from(communityOnboardingFields)
    .where(
      and(
        eq(communityOnboardingFields.communityDid, communityDid),
        eq(communityOnboardingFields.isMandatory, true)
      )
    )

  const responses = await db
    .select()
    .from(userOnboardingResponses)
    .where(
      and(
        eq(userOnboardingResponses.did, did),
        eq(userOnboardingResponses.communityDid, communityDid)
      )
    )

  const answeredFieldIds = new Set(responses.map((r) => r.fieldId))
  const missingFields = fields
    .filter((f) => !answeredFieldIds.has(f.id))
    .map((f) => ({ id: f.id, label: f.label, fieldType: f.fieldType }))

  return { complete: missingFields.length === 0, missingFields }
}
