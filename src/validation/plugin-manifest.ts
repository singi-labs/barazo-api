import { z } from 'zod/v4'

// ---------------------------------------------------------------------------
// Plugin source enum
// ---------------------------------------------------------------------------

const pluginSourceSchema = z.enum(['core', 'official', 'community', 'experimental'])

export type PluginSource = z.infer<typeof pluginSourceSchema>

// ---------------------------------------------------------------------------
// Plugin setting schemas (discriminated union on `type`)
// ---------------------------------------------------------------------------

const booleanSettingSchema = z.object({
  type: z.literal('boolean'),
  label: z.string().min(1),
  description: z.string().optional(),
  default: z.boolean(),
})

const stringSettingSchema = z.object({
  type: z.literal('string'),
  label: z.string().min(1),
  description: z.string().optional(),
  default: z.string(),
  placeholder: z.string().optional(),
})

const numberSettingSchema = z.object({
  type: z.literal('number'),
  label: z.string().min(1),
  description: z.string().optional(),
  default: z.number(),
  min: z.number().optional(),
  max: z.number().optional(),
})

const selectSettingSchema = z.object({
  type: z.literal('select'),
  label: z.string().min(1),
  description: z.string().optional(),
  default: z.string(),
  options: z.array(z.string()).min(1),
})

const pluginSettingSchema = z.discriminatedUnion('type', [
  booleanSettingSchema,
  stringSettingSchema,
  numberSettingSchema,
  selectSettingSchema,
])

export type PluginSettingSchema = z.infer<typeof pluginSettingSchema>

// ---------------------------------------------------------------------------
// Plugin manifest schema
// ---------------------------------------------------------------------------

/** Name must be scoped @barazo/plugin-* or unscoped barazo-plugin-*. */
const pluginNamePattern = /^(@barazo\/plugin-[\w-]+|barazo-plugin-[\w-]+)$/

/** Strict semver: major.minor.patch with optional pre-release and build metadata. */
const semverPattern = /^\d+\.\d+\.\d+(-[\w.]+)?(\+[\w.]+)?$/

/** Semver range expression (^, ~, >=, <, ||, *, x, etc.). */
const semverRangePattern = /^[\^~>=<|*\s\d.x-]+$/

export const pluginManifestSchema = z.object({
  // Required fields
  name: z
    .string()
    .regex(pluginNamePattern, 'Plugin name must match @barazo/plugin-* or barazo-plugin-*'),
  displayName: z.string().min(1).max(100),
  version: z.string().regex(semverPattern, 'Version must be valid semver (e.g. 1.0.0)'),
  description: z.string().min(1).max(500),
  barazoVersion: z.string().regex(semverRangePattern, 'barazoVersion must be a valid semver range'),
  source: pluginSourceSchema,
  category: z.string().min(1).max(50),
  author: z.object({
    name: z.string().min(1),
    url: z.string().optional(),
  }),
  license: z.string().min(1),
  permissions: z.object({
    backend: z.array(z.string()),
    frontend: z.array(z.string()),
  }),

  // Optional fields
  lexicons: z.array(z.string()).optional(),
  dependencies: z.array(z.string()).optional(),
  settings: z.record(z.string(), pluginSettingSchema).optional(),
  hooks: z
    .object({
      onInstall: z.string().optional(),
      onUninstall: z.string().optional(),
      onEnable: z.string().optional(),
      onDisable: z.string().optional(),
      onProfileSync: z.string().optional(),
    })
    .optional(),
  backend: z
    .object({
      routes: z.string().optional(),
      migrations: z.string().optional(),
    })
    .optional(),
  frontend: z
    .object({
      register: z.string().optional(),
    })
    .optional(),
})

export type PluginManifest = z.infer<typeof pluginManifestSchema>
