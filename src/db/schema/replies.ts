import {
  pgTable,
  pgPolicy,
  text,
  integer,
  timestamp,
  jsonb,
  boolean,
  index,
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { appRole } from './roles.js'

export const replies = pgTable(
  'replies',
  {
    uri: text('uri').primaryKey(),
    rkey: text('rkey').notNull(),
    authorDid: text('author_did').notNull(),
    content: text('content').notNull(),
    rootUri: text('root_uri').notNull(),
    rootCid: text('root_cid').notNull(),
    parentUri: text('parent_uri').notNull(),
    parentCid: text('parent_cid').notNull(),
    communityDid: text('community_did').notNull(),
    cid: text('cid').notNull(),
    labels: jsonb('labels').$type<{ values: { val: string }[] }>(),
    reactionCount: integer('reaction_count').notNull().default(0),
    voteCount: integer('vote_count').notNull().default(0),
    depth: integer('depth').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    indexedAt: timestamp('indexed_at', { withTimezone: true }).notNull().defaultNow(),
    isAuthorDeleted: boolean('is_author_deleted').notNull().default(false),
    isModDeleted: boolean('is_mod_deleted').notNull().default(false),
    moderationStatus: text('moderation_status', {
      enum: ['approved', 'held', 'rejected'],
    })
      .notNull()
      .default('approved'),
    /** Trust status based on account age at indexing time. 'new' for accounts < 24h old. */
    trustStatus: text('trust_status', {
      enum: ['trusted', 'new'],
    })
      .notNull()
      .default('trusted'),
    // Note: search_vector (tsvector) and embedding (vector) columns exist in the
    // database but are managed outside Drizzle schema (created by db:push custom SQL).
    // search_vector is maintained by a database trigger.
    // embedding is nullable vector(768) for optional semantic search.
  },
  (table) => [
    index('replies_author_did_idx').on(table.authorDid),
    index('replies_root_uri_idx').on(table.rootUri),
    index('replies_parent_uri_idx').on(table.parentUri),
    index('replies_created_at_idx').on(table.createdAt),
    index('replies_community_did_idx').on(table.communityDid),
    index('replies_moderation_status_idx').on(table.moderationStatus),
    index('replies_trust_status_idx').on(table.trustStatus),
    index('replies_root_uri_created_at_idx').on(table.rootUri, table.createdAt),
    index('replies_root_uri_depth_idx').on(table.rootUri, table.depth),
    index('replies_author_did_rkey_idx').on(table.authorDid, table.rkey),
    pgPolicy('tenant_isolation', {
      as: 'permissive',
      to: appRole,
      for: 'all',
      using: sql`community_did = current_setting('app.current_community_did', true)`,
      withCheck: sql`community_did = current_setting('app.current_community_did', true)`,
    }),
  ]
).enableRLS()
