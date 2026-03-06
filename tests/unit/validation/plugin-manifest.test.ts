import { describe, expect, it } from 'vitest'

import { pluginManifestSchema } from '../../../src/validation/plugin-manifest.js'

const VALID_MANIFEST = {
  name: '@barazo/plugin-signatures',
  displayName: 'User Signatures',
  version: '1.0.0',
  description: 'Portable user signatures with per-community overrides',
  barazoVersion: '^1.0.0',
  source: 'core',
  category: 'social',
  author: { name: 'Barazo', url: 'https://barazo.forum' },
  license: 'MIT',
  permissions: {
    backend: ['db:write:plugin_signatures', 'pds:read', 'pds:write'],
    frontend: ['ui:inject:settings-community', 'ui:inject:post-content'],
  },
}

describe('pluginManifestSchema', () => {
  it('validates a complete manifest with all fields', () => {
    const complete = {
      ...VALID_MANIFEST,
      lexicons: ['forum.barazo.plugin.signatures'],
      dependencies: ['@barazo/plugin-profiles'],
      settings: {
        maxLength: {
          type: 'number',
          label: 'Max signature length',
          description: 'Maximum character count for signatures',
          default: 200,
          min: 50,
          max: 1000,
        },
      },
      hooks: {
        onInstall: './hooks/install.js',
        onUninstall: './hooks/uninstall.js',
        onEnable: './hooks/enable.js',
        onDisable: './hooks/disable.js',
        onProfileSync: './hooks/profile-sync.js',
      },
      backend: {
        routes: './routes/index.js',
        migrations: './migrations/',
      },
      frontend: {
        register: './frontend/register.js',
      },
    }

    const result = pluginManifestSchema.safeParse(complete)
    expect(result.success).toBe(true)
  })

  it('validates a minimal manifest with only required fields', () => {
    const result = pluginManifestSchema.safeParse(VALID_MANIFEST)
    expect(result.success).toBe(true)
  })

  it('rejects an empty object', () => {
    const result = pluginManifestSchema.safeParse({})
    expect(result.success).toBe(false)
  })

  it('rejects an invalid source value', () => {
    const result = pluginManifestSchema.safeParse({
      ...VALID_MANIFEST,
      source: 'unknown',
    })
    expect(result.success).toBe(false)
  })

  it('rejects an invalid version (not semver)', () => {
    const result = pluginManifestSchema.safeParse({
      ...VALID_MANIFEST,
      version: 'v1.0',
    })
    expect(result.success).toBe(false)
  })

  it('accepts a manifest with all 4 settings types', () => {
    const result = pluginManifestSchema.safeParse({
      ...VALID_MANIFEST,
      settings: {
        enabled: {
          type: 'boolean',
          label: 'Enabled',
          default: true,
        },
        prefix: {
          type: 'string',
          label: 'Prefix',
          description: 'Text shown before the signature',
          default: '--',
          placeholder: 'Enter prefix...',
        },
        maxLength: {
          type: 'number',
          label: 'Max length',
          default: 200,
          min: 1,
          max: 5000,
        },
        position: {
          type: 'select',
          label: 'Display position',
          default: 'bottom',
          options: ['top', 'bottom'],
        },
      },
    })
    expect(result.success).toBe(true)
  })

  it('accepts a manifest with hooks', () => {
    const result = pluginManifestSchema.safeParse({
      ...VALID_MANIFEST,
      hooks: {
        onInstall: './hooks/install.js',
        onEnable: './hooks/enable.js',
      },
    })
    expect(result.success).toBe(true)
  })

  it('accepts a manifest with backend and frontend entry points', () => {
    const result = pluginManifestSchema.safeParse({
      ...VALID_MANIFEST,
      backend: { routes: './routes/index.js', migrations: './migrations/' },
      frontend: { register: './frontend/register.js' },
    })
    expect(result.success).toBe(true)
  })

  it('accepts a manifest with dependencies and lexicons', () => {
    const result = pluginManifestSchema.safeParse({
      ...VALID_MANIFEST,
      dependencies: ['@barazo/plugin-profiles'],
      lexicons: ['forum.barazo.plugin.signatures'],
    })
    expect(result.success).toBe(true)
  })

  it('rejects a name that does not match plugin naming convention', () => {
    const result = pluginManifestSchema.safeParse({
      ...VALID_MANIFEST,
      name: 'random-package',
    })
    expect(result.success).toBe(false)
  })
})
