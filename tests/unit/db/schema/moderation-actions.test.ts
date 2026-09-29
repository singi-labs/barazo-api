import { describe, it, expect } from 'vitest'
import { moderationActions } from '../../../../src/db/schema/moderation-actions.js'
import { getTableName, getTableColumns } from 'drizzle-orm'

describe('moderationActions schema', () => {
  it('should have the correct table name', () => {
    expect(getTableName(moderationActions)).toBe('moderation_actions')
  })

  it('should have all required columns', () => {
    const columns = getTableColumns(moderationActions)
    const columnNames = Object.keys(columns)

    expect(columnNames).toContain('id')
    expect(columnNames).toContain('action')
    expect(columnNames).toContain('targetUri')
    expect(columnNames).toContain('targetDid')
    expect(columnNames).toContain('moderatorDid')
    expect(columnNames).toContain('communityDid')
    expect(columnNames).toContain('reason')
    expect(columnNames).toContain('createdAt')
  })

  it('should have id as primary key', () => {
    const columns = getTableColumns(moderationActions)
    expect(columns.id.primary).toBe(true)
  })

  it('should mark required columns as not null', () => {
    const columns = getTableColumns(moderationActions)
    expect(columns.action.notNull).toBe(true)
    expect(columns.moderatorDid.notNull).toBe(true)
    expect(columns.communityDid.notNull).toBe(true)
    expect(columns.createdAt.notNull).toBe(true)
  })

  it('should allow nullable reason and target fields', () => {
    const columns = getTableColumns(moderationActions)
    expect(columns.reason.notNull).toBe(false)
    expect(columns.targetUri.notNull).toBe(false)
    expect(columns.targetDid.notNull).toBe(false)
  })

  it('should include annotation action types in enum', () => {
    const columns = getTableColumns(moderationActions)
    const actionCol = columns.action as unknown as { enumValues: string[] }
    expect(actionCol.enumValues).toContain('note_created')
    expect(actionCol.enumValues).toContain('note_deleted')
    expect(actionCol.enumValues).toContain('warning_issued')
    expect(actionCol.enumValues).toContain('notice_added')
    expect(actionCol.enumValues).toContain('notice_removed')
  })
})
