import {
  pgTable,
  pgPolicy,
  text,
  boolean,
  integer,
  timestamp,
  jsonb,
  primaryKey,
  index,
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { appRole } from './roles.js'

export const communityOnboardingFields = pgTable(
  'community_onboarding_fields',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    communityDid: text('community_did').notNull(),
    fieldType: text('field_type', {
      enum: [
        'age_confirmation',
        'tos_acceptance',
        'newsletter_email',
        'custom_text',
        'custom_select',
        'custom_checkbox',
      ],
    }).notNull(),
    label: text('label').notNull(),
    description: text('description'),
    isMandatory: boolean('is_mandatory').notNull().default(true),
    sortOrder: integer('sort_order').notNull().default(0),
    source: text('source', {
      enum: ['platform', 'admin'],
    })
      .notNull()
      .default('admin'),
    config: jsonb('config').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('onboarding_fields_community_idx').on(table.communityDid),
    pgPolicy('tenant_isolation', {
      as: 'permissive',
      to: appRole,
      for: 'all',
      using: sql`community_did = current_setting('app.current_community_did', true)`,
      withCheck: sql`community_did = current_setting('app.current_community_did', true)`,
    }),
  ]
).enableRLS()

export const userOnboardingResponses = pgTable(
  'user_onboarding_responses',
  {
    did: text('did').notNull(),
    communityDid: text('community_did').notNull(),
    fieldId: text('field_id').notNull(),
    response: jsonb('response').$type<unknown>().notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.did, table.communityDid, table.fieldId] }),
    index('onboarding_responses_did_community_idx').on(table.did, table.communityDid),
    pgPolicy('tenant_isolation', {
      as: 'permissive',
      to: appRole,
      for: 'all',
      using: sql`community_did = current_setting('app.current_community_did', true)`,
      withCheck: sql`community_did = current_setting('app.current_community_did', true)`,
    }),
  ]
).enableRLS()
