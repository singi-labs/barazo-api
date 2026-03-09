import { describe, it, expect } from 'vitest'
import { modNotes } from '../../../../src/db/schema/mod-notes.js'
import { getTableName, getTableColumns } from 'drizzle-orm'

describe('modNotes schema', () => {
  it('should have the correct table name', () => {
    expect(getTableName(modNotes)).toBe('mod_notes')
  })

  it('should have all required columns', () => {
    const columns = getTableColumns(modNotes)
    const columnNames = Object.keys(columns)
    expect(columnNames).toContain('id')
    expect(columnNames).toContain('communityDid')
    expect(columnNames).toContain('authorDid')
    expect(columnNames).toContain('subjectDid')
    expect(columnNames).toContain('subjectUri')
    expect(columnNames).toContain('content')
    expect(columnNames).toContain('noteType')
    expect(columnNames).toContain('createdAt')
  })

  it('should have id as primary key', () => {
    const columns = getTableColumns(modNotes)
    expect(columns.id.primary).toBe(true)
  })

  it('should mark required columns as not null', () => {
    const columns = getTableColumns(modNotes)
    expect(columns.communityDid.notNull).toBe(true)
    expect(columns.authorDid.notNull).toBe(true)
    expect(columns.content.notNull).toBe(true)
    expect(columns.noteType.notNull).toBe(true)
    expect(columns.createdAt.notNull).toBe(true)
  })

  it('should allow nullable subject columns', () => {
    const columns = getTableColumns(modNotes)
    expect(columns.subjectDid.notNull).toBe(false)
    expect(columns.subjectUri.notNull).toBe(false)
  })
})
