import { pgTable, pgPolicy, text, timestamp, index, serial, check } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { appRole } from './roles.js'

export const modNotes = pgTable(
  'mod_notes',
  {
    id: serial('id').primaryKey(),
    communityDid: text('community_did').notNull(),
    authorDid: text('author_did').notNull(),
    subjectDid: text('subject_did'),
    subjectUri: text('subject_uri'),
    content: text('content').notNull(),
    noteType: text('note_type', {
      enum: ['note', 'warning_context'],
    }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check('subject_check', sql`(subject_did IS NOT NULL AND subject_uri IS NULL) OR (subject_did IS NULL AND subject_uri IS NOT NULL)`),
    index('mod_notes_community_did_idx').on(table.communityDid),
    index('mod_notes_author_did_idx').on(table.authorDid),
    index('mod_notes_subject_did_idx').on(table.subjectDid),
    index('mod_notes_subject_uri_idx').on(table.subjectUri),
    index('mod_notes_created_at_idx').on(table.createdAt),
    pgPolicy('tenant_isolation', {
      as: 'permissive',
      to: appRole,
      for: 'all',
      using: sql`community_did = current_setting('app.current_community_did', true)`,
      withCheck: sql`community_did = current_setting('app.current_community_did', true)`,
    }),
  ]
).enableRLS()
