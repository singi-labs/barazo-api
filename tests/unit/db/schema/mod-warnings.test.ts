import { describe, it, expect } from 'vitest'
import { modWarnings } from '../../../../src/db/schema/mod-warnings.js'
import { getTableName, getTableColumns } from 'drizzle-orm'

describe('modWarnings schema', () => {
  it('should have the correct table name', () => {
    expect(getTableName(modWarnings)).toBe('mod_warnings')
  })

  it('should have all required columns', () => {
    const columns = getTableColumns(modWarnings)
    const columnNames = Object.keys(columns)
    expect(columnNames).toContain('id')
    expect(columnNames).toContain('communityDid')
    expect(columnNames).toContain('targetDid')
    expect(columnNames).toContain('moderatorDid')
    expect(columnNames).toContain('warningType')
    expect(columnNames).toContain('message')
    expect(columnNames).toContain('modComment')
    expect(columnNames).toContain('internalNote')
    expect(columnNames).toContain('acknowledgedAt')
    expect(columnNames).toContain('createdAt')
  })

  it('should have id as primary key', () => {
    const columns = getTableColumns(modWarnings)
    expect(columns.id.primary).toBe(true)
  })

  it('should mark required columns as not null', () => {
    const columns = getTableColumns(modWarnings)
    expect(columns.communityDid.notNull).toBe(true)
    expect(columns.targetDid.notNull).toBe(true)
    expect(columns.moderatorDid.notNull).toBe(true)
    expect(columns.warningType.notNull).toBe(true)
    expect(columns.message.notNull).toBe(true)
    expect(columns.createdAt.notNull).toBe(true)
  })

  it('should allow nullable optional fields', () => {
    const columns = getTableColumns(modWarnings)
    expect(columns.modComment.notNull).toBe(false)
    expect(columns.internalNote.notNull).toBe(false)
    expect(columns.acknowledgedAt.notNull).toBe(false)
  })
})
