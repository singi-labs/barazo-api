import { pgTable, pgPolicy, text, index, serial, integer, check } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { appRole } from './roles.js'

export const moderationActionRules = pgTable(
  'moderation_action_rules',
  {
    id: serial('id').primaryKey(),
    warningId: integer('warning_id'),
    moderationActionId: integer('moderation_action_id'),
    ruleVersionId: integer('rule_version_id').notNull(),
    communityDid: text('community_did').notNull(),
  },
  (table) => [
    index('mod_action_rules_warning_id_idx').on(table.warningId),
    index('mod_action_rules_moderation_action_id_idx').on(table.moderationActionId),
    index('mod_action_rules_rule_version_id_idx').on(table.ruleVersionId),
    index('mod_action_rules_community_did_idx').on(table.communityDid),
    check(
      'exactly_one_parent',
      sql`(warning_id IS NOT NULL AND moderation_action_id IS NULL) OR (warning_id IS NULL AND moderation_action_id IS NOT NULL)`
    ),
    pgPolicy('tenant_isolation', {
      as: 'permissive',
      to: appRole,
      for: 'all',
      using: sql`community_did = current_setting('app.current_community_did', true)`,
      withCheck: sql`community_did = current_setting('app.current_community_did', true)`,
    }),
  ]
).enableRLS()
