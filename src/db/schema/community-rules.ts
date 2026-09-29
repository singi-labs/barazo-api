import { pgTable, pgPolicy, text, timestamp, index, serial, integer } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { appRole } from './roles.js'

export const communityRules = pgTable(
  'community_rules',
  {
    id: serial('id').primaryKey(),
    communityDid: text('community_did').notNull(),
    title: text('title').notNull(),
    description: text('description').notNull(),
    displayOrder: integer('display_order').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
  },
  (table) => [
    index('community_rules_community_did_idx').on(table.communityDid),
    index('community_rules_display_order_idx').on(table.displayOrder),
    pgPolicy('tenant_isolation', {
      as: 'permissive',
      to: appRole,
      for: 'all',
      using: sql`community_did = current_setting('app.current_community_did', true)`,
      withCheck: sql`community_did = current_setting('app.current_community_did', true)`,
    }),
  ]
).enableRLS()
