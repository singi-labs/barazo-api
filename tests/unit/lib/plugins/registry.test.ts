import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type { RegistryPlugin } from '../../../../src/lib/plugins/registry.js'
import {
  getRegistryIndex,
  searchRegistryPlugins,
  getFeaturedPlugins,
} from '../../../../src/lib/plugins/registry.js'

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function makePlugin(overrides: Partial<RegistryPlugin> = {}): RegistryPlugin {
  return {
    name: '@barazo/plugin-test',
    displayName: 'Test Plugin',
    description: 'A test plugin for unit tests',
    version: '1.0.0',
    source: 'official',
    category: 'moderation',
    barazoVersion: '^0.1.0',
    author: { name: 'Barazo Team' },
    license: 'MIT',
    npmUrl: 'https://www.npmjs.com/package/@barazo/plugin-test',
    approved: true,
    featured: false,
    downloads: 100,
    ...overrides,
  }
}

const samplePlugins: RegistryPlugin[] = [
  makePlugin({
    name: '@barazo/plugin-polls',
    displayName: 'Polls',
    description: 'Add polls to your forum topics',
    category: 'social',
    source: 'official',
    featured: true,
    downloads: 500,
  }),
  makePlugin({
    name: '@barazo/plugin-spam-filter',
    displayName: 'Spam Filter',
    description: 'AI-powered spam detection',
    category: 'moderation',
    source: 'official',
    featured: false,
    downloads: 1200,
  }),
  makePlugin({
    name: 'community-badges',
    displayName: 'Community Badges',
    description: 'Custom badge system for community members',
    category: 'social',
    source: 'community',
    featured: true,
    downloads: 80,
  }),
  makePlugin({
    name: '@barazo/plugin-analytics',
    displayName: 'Analytics Dashboard',
    description: 'Privacy-friendly forum analytics',
    category: 'admin',
    source: 'official',
    featured: false,
    downloads: 300,
  }),
]

// ---------------------------------------------------------------------------
// searchRegistryPlugins
// ---------------------------------------------------------------------------

describe('searchRegistryPlugins', () => {
  it('returns all plugins when no filters are provided', () => {
    const results = searchRegistryPlugins(samplePlugins, {})
    expect(results).toHaveLength(4)
  })

  it('filters by text query matching name', () => {
    const results = searchRegistryPlugins(samplePlugins, { q: 'polls' })
    expect(results).toHaveLength(1)
    expect(results[0]?.name).toBe('@barazo/plugin-polls')
  })

  it('filters by text query matching displayName', () => {
    const results = searchRegistryPlugins(samplePlugins, { q: 'Analytics Dashboard' })
    expect(results).toHaveLength(1)
    expect(results[0]?.name).toBe('@barazo/plugin-analytics')
  })

  it('filters by text query matching description', () => {
    const results = searchRegistryPlugins(samplePlugins, { q: 'spam detection' })
    expect(results).toHaveLength(1)
    expect(results[0]?.name).toBe('@barazo/plugin-spam-filter')
  })

  it('text query is case-insensitive', () => {
    const results = searchRegistryPlugins(samplePlugins, { q: 'POLLS' })
    expect(results).toHaveLength(1)
    expect(results[0]?.name).toBe('@barazo/plugin-polls')
  })

  it('filters by category', () => {
    const results = searchRegistryPlugins(samplePlugins, { category: 'social' })
    expect(results).toHaveLength(2)
    expect(results.map((p) => p.name)).toContain('@barazo/plugin-polls')
    expect(results.map((p) => p.name)).toContain('community-badges')
  })

  it('filters by source', () => {
    const results = searchRegistryPlugins(samplePlugins, { source: 'community' })
    expect(results).toHaveLength(1)
    expect(results[0]?.name).toBe('community-badges')
  })

  it('combines query and category filters', () => {
    const results = searchRegistryPlugins(samplePlugins, { q: 'badge', category: 'social' })
    expect(results).toHaveLength(1)
    expect(results[0]?.name).toBe('community-badges')
  })

  it('combines all three filters', () => {
    const results = searchRegistryPlugins(samplePlugins, {
      q: 'badge',
      category: 'social',
      source: 'community',
    })
    expect(results).toHaveLength(1)
    expect(results[0]?.name).toBe('community-badges')
  })

  it('returns empty array when no plugins match', () => {
    const results = searchRegistryPlugins(samplePlugins, { q: 'nonexistent-plugin-xyz' })
    expect(results).toHaveLength(0)
  })

  it('returns empty array when category filter has no match', () => {
    const results = searchRegistryPlugins(samplePlugins, { category: 'nonexistent' })
    expect(results).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// getFeaturedPlugins
// ---------------------------------------------------------------------------

describe('getFeaturedPlugins', () => {
  it('returns only featured plugins', () => {
    const results = getFeaturedPlugins(samplePlugins)
    expect(results).toHaveLength(2)
    expect(results.every((p) => p.featured)).toBe(true)
  })

  it('returns empty array when no plugins are featured', () => {
    const unfeatured = samplePlugins.map((p) => ({ ...p, featured: false }))
    const results = getFeaturedPlugins(unfeatured)
    expect(results).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// getRegistryIndex
// ---------------------------------------------------------------------------

describe('getRegistryIndex', () => {
  const registryData = {
    version: 1,
    updatedAt: '2026-03-06T00:00:00Z',
    plugins: samplePlugins,
  }

  function createMockApp(cacheValue: string | null = null): FastifyInstance {
    return {
      cache: {
        get: vi.fn().mockResolvedValue(cacheValue),
        set: vi.fn().mockResolvedValue('OK'),
      },
      log: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
        trace: vi.fn(),
        fatal: vi.fn(),
        child: vi.fn(),
      },
    } as unknown as FastifyInstance
  }

  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    vi.restoreAllMocks()
  })

  it('returns plugins from cache when available', async () => {
    const app = createMockApp(JSON.stringify(registryData))

    const result = await getRegistryIndex(app)

    expect(result).toHaveLength(4)
    expect(result[0]?.name).toBe('@barazo/plugin-polls')
    // Should not have called fetch
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(app.cache.get).toHaveBeenCalledWith('plugin:registry:index')
  })

  it('fetches from registry when cache is empty', async () => {
    const app = createMockApp(null)

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue(registryData),
    })

    const result = await getRegistryIndex(app)

    expect(result).toHaveLength(4)
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://registry.barazo.forum/index.json',
      expect.objectContaining({ signal: expect.any(AbortSignal) as AbortSignal })
    )
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(app.cache.set).toHaveBeenCalledWith(
      'plugin:registry:index',
      JSON.stringify(registryData),
      'EX',
      3600
    )
  })

  it('returns empty array when fetch fails', async () => {
    const app = createMockApp(null)

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
    })

    const result = await getRegistryIndex(app)

    expect(result).toHaveLength(0)
    expect(app.log.warn).toHaveBeenCalled()
  })

  it('returns empty array when fetch throws', async () => {
    const app = createMockApp(null)

    globalThis.fetch = vi.fn().mockRejectedValue(new Error('Network error'))

    const result = await getRegistryIndex(app)

    expect(result).toHaveLength(0)
    expect(app.log.warn).toHaveBeenCalled()
  })

  it('fetches fresh when cache contains invalid JSON', async () => {
    const app = createMockApp('not-valid-json')

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue(registryData),
    })

    const result = await getRegistryIndex(app)

    expect(result).toHaveLength(4)
    expect(globalThis.fetch).toHaveBeenCalled()
  })
})
