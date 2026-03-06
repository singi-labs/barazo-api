import { describe, it, expect } from 'vitest'
import { getTableName, getTableColumns } from 'drizzle-orm'
import { plugins, pluginSettings, pluginPermissions } from '../../../../src/db/schema/plugins.js'

describe('plugins schema', () => {
  const columns = getTableColumns(plugins)

  it('has the correct table name', () => {
    expect(getTableName(plugins)).toBe('plugins')
  })

  it('has all required columns', () => {
    const columnNames = Object.keys(columns)

    const expected = [
      'id',
      'name',
      'displayName',
      'version',
      'description',
      'source',
      'category',
      'enabled',
      'manifestJson',
      'installedAt',
      'updatedAt',
    ]

    for (const col of expected) {
      expect(columnNames).toContain(col)
    }
  })

  it('has non-nullable columns', () => {
    expect(columns.id.notNull).toBe(true)
    expect(columns.name.notNull).toBe(true)
    expect(columns.displayName.notNull).toBe(true)
    expect(columns.version.notNull).toBe(true)
    expect(columns.description.notNull).toBe(true)
    expect(columns.source.notNull).toBe(true)
    expect(columns.category.notNull).toBe(true)
    expect(columns.enabled.notNull).toBe(true)
    expect(columns.manifestJson.notNull).toBe(true)
    expect(columns.installedAt.notNull).toBe(true)
    expect(columns.updatedAt.notNull).toBe(true)
  })

  it('has default values for enabled and timestamps', () => {
    expect(columns.enabled.hasDefault).toBe(true)
    expect(columns.installedAt.hasDefault).toBe(true)
    expect(columns.updatedAt.hasDefault).toBe(true)
  })
})

describe('pluginSettings schema', () => {
  const columns = getTableColumns(pluginSettings)

  it('has the correct table name', () => {
    expect(getTableName(pluginSettings)).toBe('plugin_settings')
  })

  it('has all required columns', () => {
    const columnNames = Object.keys(columns)

    const expected = ['id', 'pluginId', 'key', 'value']

    for (const col of expected) {
      expect(columnNames).toContain(col)
    }
  })

  it('has non-nullable columns', () => {
    expect(columns.id.notNull).toBe(true)
    expect(columns.pluginId.notNull).toBe(true)
    expect(columns.key.notNull).toBe(true)
    expect(columns.value.notNull).toBe(true)
  })
})

describe('pluginPermissions schema', () => {
  const columns = getTableColumns(pluginPermissions)

  it('has the correct table name', () => {
    expect(getTableName(pluginPermissions)).toBe('plugin_permissions')
  })

  it('has all required columns', () => {
    const columnNames = Object.keys(columns)

    const expected = ['id', 'pluginId', 'permission', 'grantedAt']

    for (const col of expected) {
      expect(columnNames).toContain(col)
    }
  })

  it('has non-nullable columns', () => {
    expect(columns.id.notNull).toBe(true)
    expect(columns.pluginId.notNull).toBe(true)
    expect(columns.permission.notNull).toBe(true)
    expect(columns.grantedAt.notNull).toBe(true)
  })

  it('has default value for grantedAt', () => {
    expect(columns.grantedAt.hasDefault).toBe(true)
  })
})
