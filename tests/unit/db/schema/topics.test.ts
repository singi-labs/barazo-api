import { describe, it, expect } from 'vitest'
import { getTableName, getTableColumns } from 'drizzle-orm'
import { topics } from '../../../../src/db/schema/topics.js'

describe('topics schema', () => {
  const columns = getTableColumns(topics)

  it('has the correct table name', () => {
    expect(getTableName(topics)).toBe('topics')
  })

  it('uses uri as primary key', () => {
    expect(columns.uri.primary).toBe(true)
  })

  it('has all required columns', () => {
    const columnNames = Object.keys(columns)

    const expected = [
      'uri',
      'rkey',
      'authorDid',
      'title',
      'content',
      'site',
      'category',
      'tags',
      'communityDid',
      'cid',
      'labels',
      'replyCount',
      'reactionCount',
      'lastActivityAt',
      'publishedAt',
      'indexedAt',
      // Note: search_vector (tsvector) and embedding (vector) columns exist
      // in the database but are managed outside Drizzle schema (migration 0010).
    ]

    for (const col of expected) {
      expect(columnNames).toContain(col)
    }
  })

  it('has non-nullable required columns', () => {
    expect(columns.uri.notNull).toBe(true)
    expect(columns.rkey.notNull).toBe(true)
    expect(columns.authorDid.notNull).toBe(true)
    expect(columns.title.notNull).toBe(true)
    expect(columns.content.notNull).toBe(true)
    expect(columns.category.notNull).toBe(true)
    expect(columns.communityDid.notNull).toBe(true)
    expect(columns.cid.notNull).toBe(true)
  })

  it('has nullable optional columns', () => {
    expect(columns.site.notNull).toBe(false)
    expect(columns.tags.notNull).toBe(false)
    expect(columns.labels.notNull).toBe(false)
  })

  it('has default values for counts', () => {
    expect(columns.replyCount.hasDefault).toBe(true)
    expect(columns.reactionCount.hasDefault).toBe(true)
  })

  it('has default values for timestamps', () => {
    expect(columns.indexedAt.hasDefault).toBe(true)
  })

  it('has moderation flag columns with defaults', () => {
    const columnNames = Object.keys(columns)
    expect(columnNames).toContain('isLocked')
    expect(columnNames).toContain('isPinned')
    expect(columnNames).toContain('isModDeleted')

    expect(columns.isLocked.notNull).toBe(true)
    expect(columns.isPinned.notNull).toBe(true)
    expect(columns.isModDeleted.notNull).toBe(true)

    expect(columns.isLocked.hasDefault).toBe(true)
    expect(columns.isPinned.hasDefault).toBe(true)
    expect(columns.isModDeleted.hasDefault).toBe(true)
  })

  it('has nullable pinnedAt timestamp column', () => {
    const columnNames = Object.keys(columns)
    expect(columnNames).toContain('pinnedAt')
    expect(columns.pinnedAt.notNull).toBe(false)
  })

  it('has nullable pinnedScope text column', () => {
    const columnNames = Object.keys(columns)
    expect(columnNames).toContain('pinnedScope')
    expect(columns.pinnedScope.notNull).toBe(false)
  })
})
