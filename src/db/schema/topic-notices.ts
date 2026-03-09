import { pgTable, pgPolicy, text, timestamp, index, serial } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { appRole } from './roles.js'

export const topicNotices = pgTable(
  'topic_notices',
  {
    id: serial('id').primaryKey(),
    communityDid: text('community_did').notNull(),
    topicUri: text('topic_uri').notNull(),
    authorDid: text('author_did').notNull(),
    noticeType: text('notice_type', {
      enum: ['closed', 'moved', 'outdated', 'announcement', 'custom'],
    }).notNull(),
    headline: text('headline').notNull(),
    body: text('body'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    dismissedAt: timestamp('dismissed_at', { withTimezone: true }),
  },
  (table) => [
    index('topic_notices_community_did_idx').on(table.communityDid),
    index('topic_notices_topic_uri_idx').on(table.topicUri),
    index('topic_notices_created_at_idx').on(table.createdAt),
    pgPolicy('tenant_isolation', {
      as: 'permissive',
      to: appRole,
      for: 'all',
      using: sql`community_did = current_setting('app.current_community_did', true)`,
      withCheck: sql`community_did = current_setting('app.current_community_did', true)`,
    }),
  ]
).enableRLS()
