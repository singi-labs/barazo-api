import { pgTable, pgPolicy, text, timestamp, jsonb, serial, index } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { appRole } from './roles.js'

export const adminAuditLog = pgTable(
  'admin_audit_log',
  {
    id: serial('id').primaryKey(),
    communityDid: text('community_did').notNull(),
    actorDid: text('actor_did').notNull(),
    action: text('action').notNull(),
    changes: jsonb('changes').$type<string[]>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('admin_audit_log_community_did_idx').on(table.communityDid),
    index('admin_audit_log_actor_did_idx').on(table.actorDid),
    index('admin_audit_log_created_at_idx').on(table.createdAt),
    pgPolicy('tenant_isolation_select', {
      as: 'permissive',
      to: appRole,
      for: 'select',
      using: sql`community_did = current_setting('app.current_community_did', true)`,
    }),
    pgPolicy('tenant_isolation_insert', {
      as: 'permissive',
      to: appRole,
      for: 'insert',
      withCheck: sql`community_did = current_setting('app.current_community_did', true)`,
    }),
  ]
).enableRLS()
