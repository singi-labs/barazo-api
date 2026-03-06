import type { Logger } from 'pino'

import type { PluginContext, PluginSettings, ScopedCache, ScopedDatabase } from './types.js'

/** Adapter interface for the underlying cache (e.g. Valkey/ioredis). */
export interface CacheAdapter {
  get(key: string): Promise<string | null>
  set(key: string, value: string, ttlSeconds?: number): Promise<void>
  del(key: string): Promise<void>
}

export interface PluginContextOptions {
  pluginName: string
  pluginVersion: string
  permissions: string[]
  settings: Record<string, unknown>
  db: unknown
  cache: CacheAdapter | null
  logger: Logger
  communityDid: string
}

function createPluginSettings(values: Record<string, unknown>): PluginSettings {
  const copy = { ...values }
  return {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- matches PluginSettings interface
    get<T = unknown>(key: string): T | undefined {
      return copy[key] as T | undefined
    },
    getAll(): Record<string, unknown> {
      return { ...copy }
    },
  }
}

function createScopedCache(cache: CacheAdapter, pluginName: string): ScopedCache {
  const prefix = `plugin:${pluginName}:`
  return {
    get(key: string): Promise<string | null> {
      return cache.get(`${prefix}${key}`)
    },
    set(key: string, value: string, ttlSeconds?: number): Promise<void> {
      return cache.set(`${prefix}${key}`, value, ttlSeconds)
    },
    del(key: string): Promise<void> {
      return cache.del(`${prefix}${key}`)
    },
  }
}

function createScopedDatabase(db: unknown, _permissions: string[]): ScopedDatabase {
  return {
    execute(query: unknown): Promise<unknown> {
      return (db as { execute(q: unknown): Promise<unknown> }).execute(query)
    },
    query(_tableName: string): unknown {
      throw new Error('ScopedDatabase.query() is not yet implemented')
    },
  }
}

export function createPluginContext(options: PluginContextOptions): PluginContext {
  const { pluginName, pluginVersion, permissions, settings, db, cache, logger, communityDid } =
    options

  const hasCachePermission =
    permissions.includes('cache:read') || permissions.includes('cache:write')

  const scopedCache = hasCachePermission && cache ? createScopedCache(cache, pluginName) : undefined

  return {
    pluginName,
    pluginVersion,
    communityDid,
    db: createScopedDatabase(db, permissions),
    settings: createPluginSettings(settings),
    logger: logger.child({ plugin: pluginName }),
    ...(scopedCache ? { cache: scopedCache } : {}),
  } satisfies PluginContext
}
