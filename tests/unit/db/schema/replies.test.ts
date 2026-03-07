import { describe, it, expect } from 'vitest'
import { getTableName, getTableColumns } from 'drizzle-orm'
import { replies } from '../../../../src/db/schema/replies.js'

describe('replies schema', () => {
  const columns = getTableColumns(replies)

  it('has the correct table name', () => {
    expect(getTableName(replies)).toBe('replies')
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
      'content',
      'rootUri',
      'rootCid',
      'parentUri',
      'parentCid',
      'communityDid',
      'cid',
      'labels',
      'reactionCount',
      'depth',
      'createdAt',
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
    expect(columns.content.notNull).toBe(true)
    expect(columns.rootUri.notNull).toBe(true)
    expect(columns.rootCid.notNull).toBe(true)
    expect(columns.parentUri.notNull).toBe(true)
    expect(columns.parentCid.notNull).toBe(true)
    expect(columns.communityDid.notNull).toBe(true)
    expect(columns.cid.notNull).toBe(true)
  })

  it('has nullable optional columns', () => {
    expect(columns.labels.notNull).toBe(false)
  })

  it('has default value for reaction count', () => {
    expect(columns.reactionCount.hasDefault).toBe(true)
  })

  it('has depth column with notNull and default value', () => {
    expect(columns.depth.notNull).toBe(true)
    expect(columns.depth.hasDefault).toBe(true)
  })

  it('has default value for indexed_at', () => {
    expect(columns.indexedAt.hasDefault).toBe(true)
  })
})
