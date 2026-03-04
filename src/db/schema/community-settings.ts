import { pgTable, pgPolicy, text, boolean, timestamp, jsonb, integer } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { appRole } from './roles.js'

export const communitySettings = pgTable(
  'community_settings',
  {
    communityDid: text('community_did').primaryKey(),
    domains: jsonb('domains').$type<string[]>().notNull().default([]),
    initialized: boolean('initialized').notNull().default(false),
    adminDid: text('admin_did'),
    communityName: text('community_name').notNull().default('Barazo Community'),
    maturityRating: text('maturity_rating', {
      enum: ['safe', 'mature', 'adult'],
    })
      .notNull()
      .default('safe'),
    reactionSet: jsonb('reaction_set').$type<string[]>().notNull().default(['like']),
    moderationThresholds: jsonb('moderation_thresholds')
      .$type<{
        autoBlockReportCount: number
        warnThreshold: number
        firstPostQueueCount: number
        newAccountDays: number
        newAccountWriteRatePerMin: number
        establishedWriteRatePerMin: number
        linkHoldEnabled: boolean
        topicCreationDelayEnabled: boolean
        burstPostCount: number
        burstWindowMinutes: number
        trustedPostThreshold: number
      }>()
      .notNull()
      .default({
        autoBlockReportCount: 5,
        warnThreshold: 3,
        firstPostQueueCount: 3,
        newAccountDays: 7,
        newAccountWriteRatePerMin: 3,
        establishedWriteRatePerMin: 10,
        linkHoldEnabled: true,
        topicCreationDelayEnabled: true,
        burstPostCount: 5,
        burstWindowMinutes: 10,
        trustedPostThreshold: 10,
      }),
    wordFilter: jsonb('word_filter').$type<string[]>().notNull().default([]),
    jurisdictionCountry: text('jurisdiction_country'),
    ageThreshold: integer('age_threshold').notNull().default(16),
    maxReplyDepth: integer('max_reply_depth').notNull().default(9999),
    requireLoginForMature: boolean('require_login_for_mature').notNull().default(true),
    communityDescription: text('community_description'),
    handle: text('handle'),
    serviceEndpoint: text('service_endpoint'),
    signingKey: text('signing_key'),
    rotationKey: text('rotation_key'),
    communityLogoUrl: text('community_logo_url'),
    faviconUrl: text('favicon_url'),
    primaryColor: text('primary_color'),
    accentColor: text('accent_color'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  () => [
    pgPolicy('tenant_isolation', {
      as: 'permissive',
      to: appRole,
      for: 'all',
      using: sql`community_did = current_setting('app.current_community_did', true)`,
      withCheck: sql`community_did = current_setting('app.current_community_did', true)`,
    }),
  ]
).enableRLS()
