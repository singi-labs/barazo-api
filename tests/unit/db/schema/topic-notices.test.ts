import { describe, it, expect } from 'vitest'
import { topicNotices } from '../../../../src/db/schema/topic-notices.js'
import { getTableName, getTableColumns } from 'drizzle-orm'

describe('topicNotices schema', () => {
  it('should have the correct table name', () => {
    expect(getTableName(topicNotices)).toBe('topic_notices')
  })

  it('should have all required columns', () => {
    const columns = getTableColumns(topicNotices)
    const columnNames = Object.keys(columns)
    expect(columnNames).toContain('id')
    expect(columnNames).toContain('communityDid')
    expect(columnNames).toContain('topicUri')
    expect(columnNames).toContain('authorDid')
    expect(columnNames).toContain('noticeType')
    expect(columnNames).toContain('headline')
    expect(columnNames).toContain('body')
    expect(columnNames).toContain('createdAt')
    expect(columnNames).toContain('dismissedAt')
  })

  it('should have id as primary key', () => {
    const columns = getTableColumns(topicNotices)
    expect(columns.id.primary).toBe(true)
  })

  it('should mark required columns as not null', () => {
    const columns = getTableColumns(topicNotices)
    expect(columns.communityDid.notNull).toBe(true)
    expect(columns.topicUri.notNull).toBe(true)
    expect(columns.authorDid.notNull).toBe(true)
    expect(columns.noticeType.notNull).toBe(true)
    expect(columns.headline.notNull).toBe(true)
    expect(columns.createdAt.notNull).toBe(true)
  })

  it('should allow nullable body and dismissedAt', () => {
    const columns = getTableColumns(topicNotices)
    expect(columns.body.notNull).toBe(false)
    expect(columns.dismissedAt.notNull).toBe(false)
  })
})
