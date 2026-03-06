import type { FastifyInstance } from 'fastify'

export interface RegistryPlugin {
  name: string
  displayName: string
  description: string
  version: string
  source: 'core' | 'official' | 'community' | 'experimental'
  category: string
  barazoVersion: string
  author: { name: string; url?: string }
  license: string
  npmUrl: string
  repositoryUrl?: string
  approved: boolean
  featured: boolean
  downloads: number
}

interface RegistryIndex {
  version: number
  updatedAt: string
  plugins: RegistryPlugin[]
}

const REGISTRY_URL = 'https://registry.barazo.forum/index.json'
const CACHE_KEY = 'plugin:registry:index'
const CACHE_TTL = 3600 // 1 hour

export async function getRegistryIndex(app: FastifyInstance): Promise<RegistryPlugin[]> {
  const { cache } = app

  const cached = await cache.get(CACHE_KEY)
  if (cached) {
    try {
      const parsed = JSON.parse(cached) as RegistryIndex
      return parsed.plugins
    } catch {
      // Invalid cache entry, fetch fresh
    }
  }

  try {
    const response = await fetch(REGISTRY_URL, {
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) {
      app.log.warn({ status: response.status }, 'Failed to fetch plugin registry')
      return []
    }
    const data = (await response.json()) as RegistryIndex
    await cache.set(CACHE_KEY, JSON.stringify(data), 'EX', CACHE_TTL)
    return data.plugins
  } catch (error) {
    app.log.warn({ error }, 'Failed to fetch plugin registry')
    return []
  }
}

export function searchRegistryPlugins(
  plugins: RegistryPlugin[],
  params: { q?: string | undefined; category?: string | undefined; source?: string | undefined }
): RegistryPlugin[] {
  let results = plugins

  if (params.q) {
    const query = params.q.toLowerCase()
    results = results.filter(
      (p) =>
        p.name.toLowerCase().includes(query) ||
        p.displayName.toLowerCase().includes(query) ||
        p.description.toLowerCase().includes(query)
    )
  }

  if (params.category) {
    results = results.filter((p) => p.category === params.category)
  }

  if (params.source) {
    results = results.filter((p) => p.source === params.source)
  }

  return results
}

export function getFeaturedPlugins(plugins: RegistryPlugin[]): RegistryPlugin[] {
  return plugins.filter((p) => p.featured)
}
