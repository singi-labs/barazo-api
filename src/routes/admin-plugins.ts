import { eq } from 'drizzle-orm'
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { promisify } from 'node:util'
import type { FastifyPluginCallback } from 'fastify'
import { notFound, badRequest, conflict, errorResponseSchema } from '../lib/api-errors.js'
import {
  getRegistryIndex,
  searchRegistryPlugins,
  getFeaturedPlugins,
} from '../lib/plugins/registry.js'
import { executeHook, buildLoadedPlugin } from '../lib/plugins/runtime.js'
import { createPluginContext } from '../lib/plugins/context.js'
import { updatePluginSettingsSchema, installPluginSchema } from '../validation/admin-plugins.js'
import { pluginManifestSchema } from '../validation/plugin-manifest.js'
import { plugins, pluginSettings } from '../db/schema/plugins.js'

const execFileAsync = promisify(execFile)

// ---------------------------------------------------------------------------
// OpenAPI JSON Schema definitions
// ---------------------------------------------------------------------------

const pluginJsonSchema = {
  type: 'object' as const,
  properties: {
    id: { type: 'string' as const },
    name: { type: 'string' as const },
    displayName: { type: 'string' as const },
    version: { type: 'string' as const },
    description: { type: 'string' as const },
    source: { type: 'string' as const },
    category: { type: 'string' as const },
    enabled: { type: 'boolean' as const },
    manifestJson: { type: 'object' as const },
    dependencies: { type: 'array' as const, items: { type: 'string' as const } },
    settingsSchema: { type: 'object' as const },
    settings: { type: 'object' as const },
    installedAt: { type: 'string' as const, format: 'date-time' as const },
    updatedAt: { type: 'string' as const, format: 'date-time' as const },
  },
}

const pluginListJsonSchema = {
  type: 'object' as const,
  properties: {
    plugins: {
      type: 'array' as const,
      items: pluginJsonSchema,
    },
  },
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function serializePlugin(row: typeof plugins.$inferSelect, settings?: Record<string, unknown>) {
  const manifest = row.manifestJson as ManifestJson | null
  return {
    id: row.id,
    name: row.name,
    displayName: row.displayName,
    version: row.version,
    description: row.description,
    source: row.source,
    category: row.category,
    enabled: row.enabled,
    manifestJson: row.manifestJson,
    dependencies: manifest?.dependencies ?? [],
    settingsSchema: manifest?.settings ?? {},
    settings: settings ?? {},
    installedAt: row.installedAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

// ---------------------------------------------------------------------------
// Manifest type for dependency checking
// ---------------------------------------------------------------------------

interface ManifestJson {
  name?: string
  dependencies?: string[]
  settings?: Record<string, unknown>
  [key: string]: unknown
}

// ---------------------------------------------------------------------------
// Admin plugin routes
// ---------------------------------------------------------------------------

/**
 * Admin plugin management routes for the Barazo forum.
 *
 * - GET    /api/plugins            -- List all plugins with settings
 * - GET    /api/plugins/:id        -- Get single plugin
 * - PATCH  /api/plugins/:id/enable -- Enable a plugin
 * - PATCH  /api/plugins/:id/disable -- Disable a plugin
 * - PATCH  /api/plugins/:id/settings -- Update plugin settings
 * - DELETE /api/plugins/:id        -- Uninstall a plugin
 * - POST   /api/plugins/install    -- Install from npm
 */
export function adminPluginRoutes(): FastifyPluginCallback {
  return (app, _opts, done) => {
    const { db } = app
    const requireAdmin = app.requireAdmin

    function buildCtxForPlugin(pluginRow: typeof plugins.$inferSelect) {
      const manifest = pluginRow.manifestJson as { permissions?: { backend?: string[] } }
      return createPluginContext({
        pluginName: pluginRow.name,
        pluginVersion: pluginRow.version,
        permissions: manifest.permissions?.backend ?? [],
        settings: {},
        db: app.db,
        cache: null,
        oauthClient: null,
        logger: app.log,
        communityDid: '',
      })
    }

    // -------------------------------------------------------------------
    // GET /api/plugins (admin only)
    // -------------------------------------------------------------------

    app.get(
      '/api/plugins',
      {
        preHandler: [requireAdmin],
        schema: {
          tags: ['Plugins'],
          summary: 'List all plugins with their settings',
          security: [{ bearerAuth: [] }],
          response: {
            200: pluginListJsonSchema,
            401: errorResponseSchema,
            403: errorResponseSchema,
          },
        },
      },
      async (_request, reply) => {
        const allPlugins = await db.select().from(plugins)
        const allSettings = await db.select().from(pluginSettings)

        // Group settings by pluginId
        const settingsMap = new Map<string, Record<string, unknown>>()
        for (const setting of allSettings) {
          let map = settingsMap.get(setting.pluginId)
          if (!map) {
            map = {}
            settingsMap.set(setting.pluginId, map)
          }
          map[setting.key] = setting.value
        }

        return reply.status(200).send({
          plugins: allPlugins.map((p) => serializePlugin(p, settingsMap.get(p.id))),
        })
      }
    )

    // -------------------------------------------------------------------
    // GET /api/plugins/:id (admin only)
    // -------------------------------------------------------------------

    app.get(
      '/api/plugins/:id',
      {
        preHandler: [requireAdmin],
        schema: {
          tags: ['Plugins'],
          summary: 'Get single plugin details',
          security: [{ bearerAuth: [] }],
          params: {
            type: 'object' as const,
            properties: {
              id: { type: 'string' as const },
            },
            required: ['id'],
          },
          response: {
            200: pluginJsonSchema,
            401: errorResponseSchema,
            403: errorResponseSchema,
            404: errorResponseSchema,
          },
        },
      },
      async (request, reply) => {
        const { id } = request.params as { id: string }

        const rows = await db.select().from(plugins).where(eq(plugins.id, id))

        const plugin = rows[0]
        if (!plugin) {
          throw notFound('Plugin not found')
        }

        const settings = await db
          .select()
          .from(pluginSettings)
          .where(eq(pluginSettings.pluginId, id))

        const settingsObj: Record<string, unknown> = {}
        for (const s of settings) {
          settingsObj[s.key] = s.value
        }

        return reply.status(200).send(serializePlugin(plugin, settingsObj))
      }
    )

    // -------------------------------------------------------------------
    // PATCH /api/plugins/:id/enable (admin only)
    // -------------------------------------------------------------------

    app.patch(
      '/api/plugins/:id/enable',
      {
        preHandler: [requireAdmin],
        schema: {
          tags: ['Plugins'],
          summary: 'Enable a plugin',
          security: [{ bearerAuth: [] }],
          params: {
            type: 'object' as const,
            properties: {
              id: { type: 'string' as const },
            },
            required: ['id'],
          },
          response: {
            200: pluginJsonSchema,
            400: errorResponseSchema,
            401: errorResponseSchema,
            403: errorResponseSchema,
            404: errorResponseSchema,
          },
        },
      },
      async (request, reply) => {
        const { id } = request.params as { id: string }

        const rows = await db.select().from(plugins).where(eq(plugins.id, id))

        const plugin = rows[0]
        if (!plugin) {
          throw notFound('Plugin not found')
        }

        if (plugin.enabled) {
          return reply.status(200).send(serializePlugin(plugin))
        }

        // Check dependencies: all declared deps must be enabled
        const manifest = plugin.manifestJson as ManifestJson
        const deps = manifest.dependencies ?? []

        if (deps.length > 0) {
          const allPlugins = await db.select().from(plugins)
          const enabledNames = new Set(allPlugins.filter((p) => p.enabled).map((p) => p.name))
          const missing = deps.filter((dep) => !enabledNames.has(dep))

          if (missing.length > 0) {
            throw badRequest(`Missing required dependencies: ${missing.join(', ')}`)
          }
        }

        const updated = await db
          .update(plugins)
          .set({ enabled: true, updatedAt: new Date() })
          .where(eq(plugins.id, id))
          .returning()

        const updatedPlugin = updated[0]
        if (!updatedPlugin) {
          throw notFound('Plugin not found after update')
        }

        // Execute onEnable hook
        const loaded = app.loadedPlugins.get(plugin.name)
        if (loaded?.hooks?.onEnable) {
          const ctx = buildCtxForPlugin(updatedPlugin)
          // eslint-disable-next-line @typescript-eslint/unbound-method -- plugin hooks are standalone functions
          const hookFn = loaded.hooks.onEnable as (...args: unknown[]) => Promise<void>
          await executeHook('onEnable', hookFn, ctx, app.log, plugin.name)
        }
        app.enabledPlugins.add(plugin.name)

        app.log.info(
          {
            event: 'plugin_enabled',
            pluginId: id,
            pluginName: plugin.name,
            did: request.user?.did,
          },
          'Plugin enabled'
        )

        return reply.status(200).send(serializePlugin(updatedPlugin))
      }
    )

    // -------------------------------------------------------------------
    // PATCH /api/plugins/:id/disable (admin only)
    // -------------------------------------------------------------------

    app.patch(
      '/api/plugins/:id/disable',
      {
        preHandler: [requireAdmin],
        schema: {
          tags: ['Plugins'],
          summary: 'Disable a plugin',
          security: [{ bearerAuth: [] }],
          params: {
            type: 'object' as const,
            properties: {
              id: { type: 'string' as const },
            },
            required: ['id'],
          },
          response: {
            200: pluginJsonSchema,
            401: errorResponseSchema,
            403: errorResponseSchema,
            404: errorResponseSchema,
            409: errorResponseSchema,
          },
        },
      },
      async (request, reply) => {
        const { id } = request.params as { id: string }

        const rows = await db.select().from(plugins).where(eq(plugins.id, id))

        const plugin = rows[0]
        if (!plugin) {
          throw notFound('Plugin not found')
        }

        if (!plugin.enabled) {
          return reply.status(200).send(serializePlugin(plugin))
        }

        // Check no enabled plugins depend on this one
        const allPlugins = await db.select().from(plugins)
        const dependents = allPlugins.filter((p) => {
          if (!p.enabled || p.id === id) return false
          const manifest = p.manifestJson as ManifestJson
          const deps = manifest.dependencies ?? []
          return deps.includes(plugin.name)
        })

        if (dependents.length > 0) {
          const names = dependents.map((d) => d.name).join(', ')
          throw conflict(
            `Cannot disable: the following enabled plugins depend on this one: ${names}`
          )
        }

        const updated = await db
          .update(plugins)
          .set({ enabled: false, updatedAt: new Date() })
          .where(eq(plugins.id, id))
          .returning()

        const updatedPlugin = updated[0]
        if (!updatedPlugin) {
          throw notFound('Plugin not found after update')
        }

        // Execute onDisable hook
        const loaded = app.loadedPlugins.get(plugin.name)
        if (loaded?.hooks?.onDisable) {
          const ctx = buildCtxForPlugin(updatedPlugin)
          // eslint-disable-next-line @typescript-eslint/unbound-method -- plugin hooks are standalone functions
          const hookFn = loaded.hooks.onDisable as (...args: unknown[]) => Promise<void>
          await executeHook('onDisable', hookFn, ctx, app.log, plugin.name)
        }
        app.enabledPlugins.delete(plugin.name)

        app.log.info(
          {
            event: 'plugin_disabled',
            pluginId: id,
            pluginName: plugin.name,
            did: request.user?.did,
          },
          'Plugin disabled'
        )

        return reply.status(200).send(serializePlugin(updatedPlugin))
      }
    )

    // -------------------------------------------------------------------
    // PATCH /api/plugins/:id/settings (admin only)
    // -------------------------------------------------------------------

    app.patch(
      '/api/plugins/:id/settings',
      {
        preHandler: [requireAdmin],
        schema: {
          tags: ['Plugins'],
          summary: 'Update plugin settings',
          security: [{ bearerAuth: [] }],
          params: {
            type: 'object' as const,
            properties: {
              id: { type: 'string' as const },
            },
            required: ['id'],
          },
          body: {
            type: 'object' as const,
            additionalProperties: true,
          },
          response: {
            200: {
              type: 'object' as const,
              properties: {
                success: { type: 'boolean' as const },
              },
            },
            400: errorResponseSchema,
            401: errorResponseSchema,
            403: errorResponseSchema,
            404: errorResponseSchema,
          },
        },
      },
      async (request, reply) => {
        const { id } = request.params as { id: string }

        const rows = await db.select().from(plugins).where(eq(plugins.id, id))

        const plugin = rows[0]
        if (!plugin) {
          throw notFound('Plugin not found')
        }

        const parsed = updatePluginSettingsSchema.safeParse(request.body)
        if (!parsed.success) {
          throw badRequest('Invalid settings data')
        }

        const entries = Object.entries(parsed.data)
        for (const [key, value] of entries) {
          await db
            .insert(pluginSettings)
            .values({ pluginId: id, key, value })
            .onConflictDoUpdate({
              target: [pluginSettings.pluginId, pluginSettings.key],
              set: { value },
            })
        }

        app.log.info(
          {
            event: 'plugin_settings_updated',
            pluginId: id,
            pluginName: plugin.name,
            keys: entries.map(([k]) => k),
            did: request.user?.did,
          },
          'Plugin settings updated'
        )

        return reply.status(200).send({ success: true })
      }
    )

    // -------------------------------------------------------------------
    // DELETE /api/plugins/:id (admin only)
    // -------------------------------------------------------------------

    app.delete(
      '/api/plugins/:id',
      {
        preHandler: [requireAdmin],
        schema: {
          tags: ['Plugins'],
          summary: 'Uninstall a plugin',
          security: [{ bearerAuth: [] }],
          params: {
            type: 'object' as const,
            properties: {
              id: { type: 'string' as const },
            },
            required: ['id'],
          },
          response: {
            204: {
              type: 'null' as const,
              description: 'Plugin uninstalled successfully',
            },
            401: errorResponseSchema,
            403: errorResponseSchema,
            404: errorResponseSchema,
            409: errorResponseSchema,
          },
        },
      },
      async (request, reply) => {
        const { id } = request.params as { id: string }

        const rows = await db.select().from(plugins).where(eq(plugins.id, id))

        const plugin = rows[0]
        if (!plugin) {
          throw notFound('Plugin not found')
        }

        // Core plugins cannot be uninstalled
        if (plugin.source === 'core') {
          throw conflict('Core plugins cannot be uninstalled')
        }

        // Check no enabled plugins depend on this one
        const allPlugins = await db.select().from(plugins)
        const dependents = allPlugins.filter((p) => {
          if (!p.enabled || p.id === id) return false
          const manifest = p.manifestJson as ManifestJson
          const deps = manifest.dependencies ?? []
          return deps.includes(plugin.name)
        })

        if (dependents.length > 0) {
          const names = dependents.map((d) => d.name).join(', ')
          throw conflict(
            `Cannot uninstall: the following enabled plugins depend on this one: ${names}`
          )
        }

        // Execute onUninstall hook before DB delete
        const loaded = app.loadedPlugins.get(plugin.name)
        if (loaded?.hooks?.onUninstall) {
          const ctx = buildCtxForPlugin(plugin)
          // eslint-disable-next-line @typescript-eslint/unbound-method -- plugin hooks are standalone functions
          const hookFn = loaded.hooks.onUninstall as (...args: unknown[]) => Promise<void>
          await executeHook('onUninstall', hookFn, ctx, app.log, plugin.name)
        }

        await db.delete(plugins).where(eq(plugins.id, id))

        app.enabledPlugins.delete(plugin.name)
        app.loadedPlugins.delete(plugin.name)

        app.log.info(
          {
            event: 'plugin_uninstalled',
            pluginId: id,
            pluginName: plugin.name,
            did: request.user?.did,
          },
          'Plugin uninstalled'
        )

        return reply.status(204).send()
      }
    )

    // -------------------------------------------------------------------
    // POST /api/plugins/install (admin only)
    // -------------------------------------------------------------------

    app.post(
      '/api/plugins/install',
      {
        preHandler: [requireAdmin],
        schema: {
          tags: ['Plugins'],
          summary: 'Install a plugin from npm',
          security: [{ bearerAuth: [] }],
          body: {
            type: 'object' as const,
            properties: {
              packageName: { type: 'string' as const },
            },
            required: ['packageName'],
          },
          response: {
            200: pluginJsonSchema,
            400: errorResponseSchema,
            401: errorResponseSchema,
            403: errorResponseSchema,
            409: errorResponseSchema,
          },
        },
      },
      async (request, reply) => {
        const parsed = installPluginSchema.safeParse(request.body)
        if (!parsed.success) {
          throw badRequest('Invalid package name')
        }

        const { packageName } = parsed.data

        // In SaaS mode, only @barazo scoped packages are allowed
        if (app.env.HOSTING_MODE === 'saas' && !packageName.startsWith('@barazo/')) {
          throw badRequest('Only @barazo scoped plugins are allowed in SaaS mode')
        }

        // Extract bare name (without version specifier) for duplicate check
        const bareName = packageName.replace(/@[\w.-]+$/, '')

        // Check not already installed
        const existing = await db.select().from(plugins).where(eq(plugins.name, bareName))

        if (existing.length > 0) {
          throw conflict(`Plugin "${bareName}" is already installed`)
        }

        // Install via npm
        await execFileAsync('npm', ['install', '--ignore-scripts', packageName])

        // Read plugin.json from installed package
        const require = createRequire(import.meta.url)
        const packageDir = require.resolve(`${bareName}/plugin.json`)
        const manifestRaw = await readFile(packageDir, 'utf-8')
        const manifestData: unknown = JSON.parse(manifestRaw)

        const manifestResult = pluginManifestSchema.safeParse(manifestData)
        if (!manifestResult.success) {
          throw badRequest('Invalid plugin manifest (plugin.json)')
        }

        const manifest = manifestResult.data

        // Insert into plugins table (disabled by default)
        const inserted = await db
          .insert(plugins)
          .values({
            name: manifest.name,
            displayName: manifest.displayName,
            version: manifest.version,
            description: manifest.description,
            source: manifest.source,
            category: manifest.category,
            enabled: false,
            manifestJson: manifest,
          })
          .returning()

        const newPlugin = inserted[0]
        if (!newPlugin) {
          throw badRequest('Failed to insert plugin')
        }

        // Load hooks for newly installed plugin and run onInstall
        const packageDirPath = packageDir.replace(/\/plugin\.json$/, '')
        const loadedPlugin = await buildLoadedPlugin(manifest, packageDirPath, app.log)
        app.loadedPlugins.set(manifest.name, loadedPlugin)

        if (loadedPlugin.hooks?.onInstall) {
          const ctx = buildCtxForPlugin(newPlugin)
          // eslint-disable-next-line @typescript-eslint/unbound-method -- plugin hooks are standalone functions
          const hookFn = loadedPlugin.hooks.onInstall as (...args: unknown[]) => Promise<void>
          await executeHook('onInstall', hookFn, ctx, app.log, manifest.name)
        }

        app.log.info(
          {
            event: 'plugin_installed',
            pluginId: newPlugin.id,
            pluginName: newPlugin.name,
            version: newPlugin.version,
            did: request.user?.did,
          },
          'Plugin installed'
        )

        return reply.status(200).send(serializePlugin(newPlugin))
      }
    )

    // -------------------------------------------------------------------
    // Registry routes (public -- no auth required)
    // -------------------------------------------------------------------

    const registryPluginJsonSchema = {
      type: 'object' as const,
      properties: {
        name: { type: 'string' as const },
        displayName: { type: 'string' as const },
        description: { type: 'string' as const },
        version: { type: 'string' as const },
        source: { type: 'string' as const },
        category: { type: 'string' as const },
        barazoVersion: { type: 'string' as const },
        author: {
          type: 'object' as const,
          properties: {
            name: { type: 'string' as const },
            url: { type: 'string' as const },
          },
        },
        license: { type: 'string' as const },
        npmUrl: { type: 'string' as const },
        repositoryUrl: { type: 'string' as const },
        approved: { type: 'boolean' as const },
        featured: { type: 'boolean' as const },
        downloads: { type: 'number' as const },
      },
    }

    const registryPluginListJsonSchema = {
      type: 'object' as const,
      properties: {
        plugins: {
          type: 'array' as const,
          items: registryPluginJsonSchema,
        },
      },
    }

    // -------------------------------------------------------------------
    // GET /api/plugins/registry/search (public)
    // -------------------------------------------------------------------

    app.get(
      '/api/plugins/registry/search',
      {
        schema: {
          tags: ['Plugins'],
          summary: 'Search the plugin registry',
          querystring: {
            type: 'object' as const,
            properties: {
              q: { type: 'string' as const },
              category: { type: 'string' as const },
              source: { type: 'string' as const },
            },
          },
          response: {
            200: registryPluginListJsonSchema,
          },
        },
      },
      async (request) => {
        const { q, category, source } = request.query as {
          q?: string
          category?: string
          source?: string
        }
        const registryPlugins = await getRegistryIndex(app)
        const results = searchRegistryPlugins(registryPlugins, { q, category, source })
        return { plugins: results }
      }
    )

    // -------------------------------------------------------------------
    // GET /api/plugins/registry/featured (public)
    // -------------------------------------------------------------------

    app.get(
      '/api/plugins/registry/featured',
      {
        schema: {
          tags: ['Plugins'],
          summary: 'Get featured plugins from the registry',
          response: {
            200: registryPluginListJsonSchema,
          },
        },
      },
      async () => {
        const registryPlugins = await getRegistryIndex(app)
        return { plugins: getFeaturedPlugins(registryPlugins) }
      }
    )

    done()
  }
}
