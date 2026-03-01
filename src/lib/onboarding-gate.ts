import { eq, and } from 'drizzle-orm'
import {
  communityOnboardingFields,
  userOnboardingResponses,
} from '../db/schema/onboarding-fields.js'
import { userPreferences } from '../db/schema/user-preferences.js'
import type { Database } from '../db/index.js'

const SYSTEM_AGE_FIELD_ID = 'system-age-confirmation'

export interface OnboardingCheckResult {
  complete: boolean
  missingFields: { id: string; label: string; fieldType: string }[]
}

/**
 * Check whether a user has completed all mandatory onboarding fields
 * for a community. Returns complete=true if no fields are configured
 * or all mandatory ones have responses.
 *
 * Also checks for the system-level age declaration: if no admin-configured
 * age_confirmation field exists and the user has no declaredAge, the system
 * age field is treated as a missing mandatory field.
 */
export async function checkOnboardingComplete(
  db: Database,
  did: string,
  communityDid: string
): Promise<OnboardingCheckResult> {
  // Get mandatory fields for this community
  const fields = await db
    .select()
    .from(communityOnboardingFields)
    .where(
      and(
        eq(communityOnboardingFields.communityDid, communityDid),
        eq(communityOnboardingFields.isMandatory, true)
      )
    )

  // Get user's responses for this community
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

  // Check for system-level age field: inject if no admin age field and user has no declaredAge
  const allCommunityFields = await db
    .select({ fieldType: communityOnboardingFields.fieldType })
    .from(communityOnboardingFields)
    .where(eq(communityOnboardingFields.communityDid, communityDid))

  const hasAdminAgeField = allCommunityFields.some((f) => f.fieldType === 'age_confirmation')

  if (!hasAdminAgeField) {
    const prefRows = await db
      .select({ declaredAge: userPreferences.declaredAge })
      .from(userPreferences)
      .where(eq(userPreferences.did, did))

    const declaredAge = prefRows[0]?.declaredAge ?? null
    if (declaredAge === null) {
      missingFields.unshift({
        id: SYSTEM_AGE_FIELD_ID,
        label: 'Age Declaration',
        fieldType: 'age_confirmation',
      })
    }
  }

  return {
    complete: missingFields.length === 0,
    missingFields,
  }
}
