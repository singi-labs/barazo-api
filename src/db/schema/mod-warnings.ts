import { pgTable, pgPolicy, text, timestamp, index, serial } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { appRole } from './roles.js'

export const modWarnings = pgTable(
  'mod_warnings',
  {
    id: serial('id').primaryKey(),
    communityDid: text('community_did').notNull(),
    targetDid: text('target_did').notNull(),
    moderatorDid: text('moderator_did').notNull(),
    warningType: text('warning_type', {
      enum: ['off_topic', 'harassment', 'rule_violation', 'other', 'custom'],
    }).notNull(),
    message: text('message').notNull(),
    modComment: text('mod_comment'),
    internalNote: text('internal_note'),
    acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('mod_warnings_community_did_idx').on(table.communityDid),
    index('mod_warnings_target_did_idx').on(table.targetDid),
    index('mod_warnings_moderator_did_idx').on(table.moderatorDid),
    index('mod_warnings_created_at_idx').on(table.createdAt),
    pgPolicy('tenant_isolation', {
      as: 'permissive',
      to: appRole,
      for: 'all',
      using: sql`community_did = current_setting('app.current_community_did', true)`,
      withCheck: sql`community_did = current_setting('app.current_community_did', true)`,
    }),
  ]
).enableRLS()
