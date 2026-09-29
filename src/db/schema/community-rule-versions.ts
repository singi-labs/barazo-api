import { pgTable, pgPolicy, text, timestamp, index, serial, integer } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { appRole } from './roles.js'

export const communityRuleVersions = pgTable(
  'community_rule_versions',
  {
    id: serial('id').primaryKey(),
    ruleId: integer('rule_id').notNull(),
    title: text('title').notNull(),
    description: text('description').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('community_rule_versions_rule_id_idx').on(table.ruleId),
    pgPolicy('tenant_isolation', {
      as: 'permissive',
      to: appRole,
      for: 'all',
      using: sql`rule_id IN (SELECT id FROM community_rules WHERE community_did = current_setting('app.current_community_did', true))`,
      withCheck: sql`rule_id IN (SELECT id FROM community_rules WHERE community_did = current_setting('app.current_community_did', true))`,
    }),
  ]
).enableRLS()
