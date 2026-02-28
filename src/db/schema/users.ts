import { pgTable, text, timestamp, boolean, integer, index } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'

export const users = pgTable(
  'users',
  {
    did: text('did').primaryKey(),
    handle: text('handle').notNull(),
    displayName: text('display_name'),
    avatarUrl: text('avatar_url'),
    bannerUrl: text('banner_url'),
    bio: text('bio'),
    role: text('role', { enum: ['user', 'moderator', 'admin'] })
      .notNull()
      .default('user'),
    isBanned: boolean('is_banned').notNull().default(false),
    reputationScore: integer('reputation_score').notNull().default(0),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
    lastActiveAt: timestamp('last_active_at', { withTimezone: true }).notNull().defaultNow(),
    declaredAge: integer('declared_age'),
    maturityPref: text('maturity_pref', {
      enum: ['safe', 'mature', 'adult'],
    })
      .notNull()
      .default('safe'),
    /** Account creation date resolved from PLC directory on first encounter. */
    accountCreatedAt: timestamp('account_created_at', { withTimezone: true }),
    followersCount: integer('followers_count').notNull().default(0),
    followsCount: integer('follows_count').notNull().default(0),
    atprotoPostsCount: integer('atproto_posts_count').notNull().default(0),
    hasBlueskyProfile: boolean('has_bluesky_profile').notNull().default(false),
  },
  (table) => [
    index('users_role_elevated_idx')
      .on(table.role)
      .where(sql`role IN ('moderator', 'admin')`),
    index('users_handle_idx').on(table.handle),
    index('users_account_created_at_idx').on(table.accountCreatedAt),
  ]
)
