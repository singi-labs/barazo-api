import {
  pgTable,
  pgPolicy,
  text,
  boolean,
  timestamp,
  jsonb,
  uuid,
  unique,
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { appRole } from './roles.js'

export const plugins = pgTable(
  'plugins',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').unique().notNull(),
    displayName: text('display_name').notNull(),
    version: text('version').notNull(),
    description: text('description').notNull(),
    source: text('source', {
      enum: ['core', 'official', 'community', 'experimental'],
    }).notNull(),
    category: text('category').notNull(),
    enabled: boolean('enabled').notNull().default(false),
    manifestJson: jsonb('manifest_json').notNull(),
    installedAt: timestamp('installed_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  () => [
    pgPolicy('plugins_instance_wide', {
      as: 'permissive',
      to: appRole,
      for: 'all',
      using: sql`true`,
    }),
  ]
).enableRLS()

export const pluginSettings = pgTable(
  'plugin_settings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    pluginId: uuid('plugin_id')
      .references(() => plugins.id, { onDelete: 'cascade' })
      .notNull(),
    key: text('key').notNull(),
    value: jsonb('value').notNull(),
  },
  (table) => [
    unique('plugin_settings_plugin_id_key_unique').on(table.pluginId, table.key),
    pgPolicy('plugin_settings_instance_wide', {
      as: 'permissive',
      to: appRole,
      for: 'all',
      using: sql`true`,
    }),
  ]
).enableRLS()

export const pluginPermissions = pgTable(
  'plugin_permissions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    pluginId: uuid('plugin_id')
      .references(() => plugins.id, { onDelete: 'cascade' })
      .notNull(),
    permission: text('permission').notNull(),
    grantedAt: timestamp('granted_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('plugin_permissions_plugin_id_permission_unique').on(table.pluginId, table.permission),
    pgPolicy('plugin_permissions_instance_wide', {
      as: 'permissive',
      to: appRole,
      for: 'all',
      using: sql`true`,
    }),
  ]
).enableRLS()
