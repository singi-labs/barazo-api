import { describe, expect, it, vi } from 'vitest'

import { createPluginContext } from '../../../../src/lib/plugins/context.js'
import type { PluginContextOptions } from '../../../../src/lib/plugins/context.js'

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn().mockReturnThis(),
    level: 'info',
  } as unknown as PluginContextOptions['logger']
}

function makeCacheAdapter() {
  return {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue(undefined),
    del: vi.fn().mockResolvedValue(undefined),
  }
}

const BASE_OPTIONS: PluginContextOptions = {
  pluginName: '@barazo/plugin-signatures',
  pluginVersion: '1.2.0',
  permissions: ['db:write:plugin_signatures'],
  settings: { maxLength: 200, prefix: '--' },
  db: {},
  cache: null,
  logger: makeLogger(),
  communityDid: 'did:plc:testcommunity123',
}

describe('createPluginContext', () => {
  it('creates context with correct pluginName, pluginVersion, and communityDid', () => {
    const ctx = createPluginContext({ ...BASE_OPTIONS, logger: makeLogger() })

    expect(ctx.pluginName).toBe('@barazo/plugin-signatures')
    expect(ctx.pluginVersion).toBe('1.2.0')
    expect(ctx.communityDid).toBe('did:plc:testcommunity123')
  })

  it('settings.get() returns values and undefined for missing keys', () => {
    const ctx = createPluginContext({ ...BASE_OPTIONS, logger: makeLogger() })

    expect(ctx.settings.get('maxLength')).toBe(200)
    expect(ctx.settings.get('prefix')).toBe('--')
    expect(ctx.settings.get('nonexistent')).toBeUndefined()
  })

  it('settings.getAll() returns a copy of settings', () => {
    const ctx = createPluginContext({ ...BASE_OPTIONS, logger: makeLogger() })
    const all = ctx.settings.getAll()

    expect(all).toEqual({ maxLength: 200, prefix: '--' })
    // Verify it is a copy, not the original reference
    all['maxLength'] = 999
    expect(ctx.settings.get('maxLength')).toBe(200)
  })

  it('scoped cache prefixes keys with plugin:<name>: for get/set/del', async () => {
    const adapter = makeCacheAdapter()
    const logger = makeLogger()
    const ctx = createPluginContext({
      ...BASE_OPTIONS,
      permissions: ['cache:read', 'cache:write'],
      cache: adapter,
      logger,
    })

    const cache = ctx.cache
    expect(cache).toBeDefined()
    if (!cache) throw new Error('Expected cache to be defined')

    await cache.get('mykey')
    expect(adapter.get).toHaveBeenCalledWith('plugin:@barazo/plugin-signatures:mykey')

    await cache.set('mykey', 'val', 60)
    expect(adapter.set).toHaveBeenCalledWith('plugin:@barazo/plugin-signatures:mykey', 'val', 60)

    await cache.del('mykey')
    expect(adapter.del).toHaveBeenCalledWith('plugin:@barazo/plugin-signatures:mykey')
  })

  it('does not provide cache when no cache permissions', () => {
    const adapter = makeCacheAdapter()
    const ctx = createPluginContext({
      ...BASE_OPTIONS,
      permissions: ['db:write:plugin_signatures'],
      cache: adapter,
      logger: makeLogger(),
    })

    expect(ctx.cache).toBeUndefined()
  })

  it('provides cache when cache:read is in permissions', () => {
    const adapter = makeCacheAdapter()
    const ctx = createPluginContext({
      ...BASE_OPTIONS,
      permissions: ['cache:read'],
      cache: adapter,
      logger: makeLogger(),
    })

    expect(ctx.cache).toBeDefined()
  })

  it('provides cache when cache:write is in permissions', () => {
    const adapter = makeCacheAdapter()
    const ctx = createPluginContext({
      ...BASE_OPTIONS,
      permissions: ['cache:write'],
      cache: adapter,
      logger: makeLogger(),
    })

    expect(ctx.cache).toBeDefined()
  })

  it('creates a child logger with plugin name', () => {
    const childFn = vi.fn().mockReturnThis()
    const logger = { ...makeLogger(), child: childFn } as unknown as PluginContextOptions['logger']
    createPluginContext({ ...BASE_OPTIONS, logger })

    expect(childFn).toHaveBeenCalledWith({ plugin: '@barazo/plugin-signatures' })
  })
})
