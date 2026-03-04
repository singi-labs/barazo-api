-- Seed platform age_confirmation field for all initialized communities
-- that don't already have an admin-created age_confirmation field.
-- NOTE: assumes single-community mode (P1/P2). Multi-community (P3)
-- will need per-community unique IDs.
INSERT INTO community_onboarding_fields (
  id, community_did, field_type, label, description,
  is_mandatory, sort_order, source, config, created_at, updated_at
)
SELECT
  'platform:age_confirmation',
  cs.community_did,
  'age_confirmation',
  'Age Declaration',
  'Please select your age bracket. This determines which content is available to you.',
  true,
  -1,
  'platform',
  NULL,
  NOW(),
  NOW()
FROM community_settings cs
WHERE cs.initialized = true
  AND NOT EXISTS (
    SELECT 1 FROM community_onboarding_fields cof
    WHERE cof.community_did = cs.community_did
      AND cof.field_type = 'age_confirmation'
  )
ON CONFLICT DO NOTHING;

-- Backfill user_onboarding_responses for users who already declared age
-- via the virtual system field (data lives in user_preferences.declared_age).
INSERT INTO user_onboarding_responses (did, community_did, field_id, response, completed_at)
SELECT
  up.did,
  cs.community_did,
  'platform:age_confirmation',
  to_jsonb(up.declared_age),
  COALESCE(up.updated_at, NOW())
FROM user_preferences up
CROSS JOIN community_settings cs
WHERE up.declared_age IS NOT NULL
  AND cs.initialized = true
  AND EXISTS (
    SELECT 1 FROM community_onboarding_fields cof
    WHERE cof.id = 'platform:age_confirmation'
      AND cof.community_did = cs.community_did
  )
ON CONFLICT DO NOTHING;
