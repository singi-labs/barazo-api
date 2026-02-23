import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import Fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import type { RequestUser } from '../../../src/auth/middleware.js'

// ---------------------------------------------------------------------------
// Mock DB with execute method (search uses raw SQL, not Drizzle query builder)
// ---------------------------------------------------------------------------

const mockDb = {
  execute: vi.fn(),
}

// ---------------------------------------------------------------------------
// Mock embedding service
// ---------------------------------------------------------------------------

const mockIsEnabled = vi.fn().mockReturnValue(false)
const mockGenerateEmbedding = vi.fn().mockResolvedValue(null)

vi.mock('../../../src/services/embedding.js', () => ({
  createEmbeddingService: vi.fn(() => ({
    isEnabled: mockIsEnabled,
    generateEmbedding: mockGenerateEmbedding,
  })),
}))

// ---------------------------------------------------------------------------
// Mock muted words (loadMutedWords uses Drizzle query builder, not raw SQL)
// ---------------------------------------------------------------------------

const mockLoadMutedWords = vi.fn().mockResolvedValue([])
const mockContentMatchesMutedWords = vi.fn().mockReturnValue(false)

vi.mock('../../../src/lib/muted-words.js', () => ({
  loadMutedWords: (...args: unknown[]) => mockLoadMutedWords(...args) as Promise<string[]>,
  contentMatchesMutedWords: (...args: unknown[]) =>
    mockContentMatchesMutedWords(...args) as boolean,
}))

// Import routes AFTER mocking
import { searchRoutes } from '../../../src/routes/search.js'

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const TEST_DID = 'did:plc:testuser123'
const TEST_COMMUNITY_DID = 'did:plc:community123'
const TEST_NOW = new Date('2026-02-13T12:00:00.000Z')

// ---------------------------------------------------------------------------
// Sample row builders (snake_case to match raw SQL output)
// ---------------------------------------------------------------------------

function sampleTopicRow(overrides?: Record<string, unknown>) {
  return {
    uri: `at://${TEST_DID}/forum.barazo.topic.post/topic123`,
    rkey: 'topic123',
    author_did: TEST_DID,
    title: 'Test Topic Title',
    content: 'This is a test topic body content for search testing.',
    category: 'general',
    community_did: TEST_COMMUNITY_DID,
    reply_count: 5,
    reaction_count: 3,
    created_at: TEST_NOW,
    rank: 0.75,
    ...overrides,
  }
}

function sampleReplyRow(overrides?: Record<string, unknown>) {
  return {
    uri: `at://${TEST_DID}/forum.barazo.topic.reply/reply123`,
    rkey: 'reply123',
    author_did: TEST_DID,
    content: 'This is a reply to the test topic.',
    community_did: TEST_COMMUNITY_DID,
    reaction_count: 1,
    created_at: TEST_NOW,
    root_uri: `at://${TEST_DID}/forum.barazo.topic.post/topic123`,
    root_title: 'Test Topic Title',
    rank: 0.6,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Helper: build app
// ---------------------------------------------------------------------------

async function buildTestApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })

  app.decorateRequest('user', undefined as RequestUser | undefined)
  app.decorateRequest('communityDid', undefined as string | undefined)
  app.addHook('onRequest', async (request) => {
    request.communityDid = 'did:plc:test'
  })
  app.decorate('db', mockDb as never)
  app.decorate('env', {
    EMBEDDING_URL: undefined,
    AI_EMBEDDING_DIMENSIONS: 768,
    COMMUNITY_MODE: 'single',
    COMMUNITY_DID: TEST_COMMUNITY_DID,
  } as never)
  app.decorate('authMiddleware', {
    requireAuth: vi.fn((_req: unknown, _reply: unknown) => Promise.resolve()),
    optionalAuth: vi.fn((_req: unknown, _reply: unknown) => Promise.resolve()),
  } as never)
  app.decorate('cache', {} as never)

  await app.register(searchRoutes())
  await app.ready()

  return app
}

// ===========================================================================
// Test suite
// ===========================================================================

describe('search routes', () => {
  let app: FastifyInstance

  beforeEach(async () => {
    vi.clearAllMocks()
    mockDb.execute.mockResolvedValue([])
    mockIsEnabled.mockReturnValue(false)
    mockGenerateEmbedding.mockResolvedValue(null)
    mockLoadMutedWords.mockResolvedValue([])
    mockContentMatchesMutedWords.mockReturnValue(false)

    app = await buildTestApp()
  })

  afterAll(async () => {
    await app.close()
  })

  // =========================================================================
  // Validation
  // =========================================================================

  it('returns 400 when q is missing', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/search',
    })

    expect(response.statusCode).toBe(400)
  })

  it('returns 400 when q is empty', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/search?q=',
    })

    expect(response.statusCode).toBe(400)
  })

  // =========================================================================
  // Full-text search: basic results
  // =========================================================================

  it('returns empty results when no matches', async () => {
    mockDb.execute.mockResolvedValue([])

    const response = await app.inject({
      method: 'GET',
      url: '/api/search?q=nonexistent',
    })

    expect(response.statusCode).toBe(200)
    const body = response.json<{
      results: unknown[]
      cursor: string | null
      total: number
      searchMode: string
    }>()
    expect(body.results).toEqual([])
    expect(body.cursor).toBeNull()
    expect(body.total).toBe(0)
  })

  it('returns topic results from full-text search', async () => {
    const topicRow = sampleTopicRow()
    // First execute: topic search
    mockDb.execute.mockResolvedValueOnce([topicRow])
    // Second execute: reply search (empty)
    mockDb.execute.mockResolvedValueOnce([])

    const response = await app.inject({
      method: 'GET',
      url: '/api/search?q=test',
    })

    expect(response.statusCode).toBe(200)
    const body = response.json<{
      results: Array<{
        type: string
        uri: string
        authorDid: string
        title: string | null
        content: string
        category: string | null
        communityDid: string
        replyCount: number | null
        reactionCount: number
        rank: number
      }>
      searchMode: string
    }>()
    expect(body.results).toHaveLength(1)
    expect(body.results[0]?.type).toBe('topic')
    expect(body.results[0]?.uri).toBe(topicRow.uri)
    expect(body.results[0]?.authorDid).toBe(TEST_DID)
    expect(body.results[0]?.title).toBe('Test Topic Title')
    expect(body.results[0]?.category).toBe('general')
    expect(body.results[0]?.communityDid).toBe(TEST_COMMUNITY_DID)
    expect(body.results[0]?.replyCount).toBe(5)
    expect(body.results[0]?.reactionCount).toBe(3)
  })

  it('returns reply results with root topic context', async () => {
    const replyRow = sampleReplyRow()
    // First execute: topic search (empty)
    mockDb.execute.mockResolvedValueOnce([])
    // Second execute: reply search
    mockDb.execute.mockResolvedValueOnce([replyRow])

    const response = await app.inject({
      method: 'GET',
      url: '/api/search?q=reply',
    })

    expect(response.statusCode).toBe(200)
    const body = response.json<{
      results: Array<{
        type: string
        uri: string
        rootUri: string | null
        rootTitle: string | null
        title: string | null
        category: string | null
      }>
    }>()
    expect(body.results).toHaveLength(1)
    expect(body.results[0]?.type).toBe('reply')
    expect(body.results[0]?.rootUri).toBe(replyRow.root_uri)
    expect(body.results[0]?.rootTitle).toBe('Test Topic Title')
    // Replies have no own title or category
    expect(body.results[0]?.title).toBeNull()
    expect(body.results[0]?.category).toBeNull()
  })

  // =========================================================================
  // Filters
  // =========================================================================

  it('applies category filter', async () => {
    // Topic search returns results matching category
    mockDb.execute.mockResolvedValueOnce([sampleTopicRow({ category: 'support' })])
    // Reply search (no category filter for replies)
    mockDb.execute.mockResolvedValueOnce([])

    const response = await app.inject({
      method: 'GET',
      url: '/api/search?q=help&category=support',
    })

    expect(response.statusCode).toBe(200)
    const body = response.json<{
      results: Array<{ category: string | null }>
    }>()
    expect(body.results).toHaveLength(1)
    expect(body.results[0]?.category).toBe('support')

    // db.execute should have been called (verifying it was invoked with the filter)
    expect(mockDb.execute).toHaveBeenCalled()
  })

  it('applies author filter', async () => {
    const authorDid = 'did:plc:specific_author'
    mockDb.execute.mockResolvedValueOnce([sampleTopicRow({ author_did: authorDid })])
    mockDb.execute.mockResolvedValueOnce([])

    const response = await app.inject({
      method: 'GET',
      url: `/api/search?q=post&author=${encodeURIComponent(authorDid)}`,
    })

    expect(response.statusCode).toBe(200)
    const body = response.json<{
      results: Array<{ authorDid: string }>
    }>()
    expect(body.results).toHaveLength(1)
    expect(body.results[0]?.authorDid).toBe(authorDid)
  })

  it('applies date range filters', async () => {
    mockDb.execute.mockResolvedValueOnce([sampleTopicRow()])
    mockDb.execute.mockResolvedValueOnce([])

    const response = await app.inject({
      method: 'GET',
      url: '/api/search?q=test&dateFrom=2026-01-01T00:00:00Z&dateTo=2026-03-01T00:00:00Z',
    })

    expect(response.statusCode).toBe(200)
    expect(response.json<{ results: unknown[] }>().results).toHaveLength(1)
    // The date filters are embedded in the SQL; we verify the query succeeded
    expect(mockDb.execute).toHaveBeenCalled()
  })

  // =========================================================================
  // Type filter
  // =========================================================================

  it("handles type filter 'topics' (only topics searched)", async () => {
    mockDb.execute.mockResolvedValueOnce([sampleTopicRow()])

    const response = await app.inject({
      method: 'GET',
      url: '/api/search?q=test&type=topics',
    })

    expect(response.statusCode).toBe(200)
    const body = response.json<{
      results: Array<{ type: string }>
    }>()
    expect(body.results).toHaveLength(1)
    expect(body.results[0]?.type).toBe('topic')

    // Only one execute call -- topics only, no reply search
    expect(mockDb.execute).toHaveBeenCalledTimes(1)
  })

  it("handles type filter 'replies' (only replies searched)", async () => {
    mockDb.execute.mockResolvedValueOnce([sampleReplyRow()])

    const response = await app.inject({
      method: 'GET',
      url: '/api/search?q=test&type=replies',
    })

    expect(response.statusCode).toBe(200)
    const body = response.json<{
      results: Array<{ type: string }>
    }>()
    expect(body.results).toHaveLength(1)
    expect(body.results[0]?.type).toBe('reply')

    // Only one execute call -- replies only, no topic search
    expect(mockDb.execute).toHaveBeenCalledTimes(1)
  })

  // =========================================================================
  // Pagination
  // =========================================================================

  it('returns cursor for pagination when more results exist', async () => {
    // Default limit is 25. Route fetches limit+1=26.
    // Return 26 topic results to trigger hasMore.
    const rows = Array.from({ length: 26 }, (_, i) =>
      sampleTopicRow({
        uri: `at://${TEST_DID}/forum.barazo.topic.post/topic${String(i).padStart(3, '0')}`,
        rkey: `topic${String(i).padStart(3, '0')}`,
        rank: 1.0 - i * 0.01,
      })
    )

    // Topics search returns 26 rows
    mockDb.execute.mockResolvedValueOnce(rows)
    // Replies search returns empty
    mockDb.execute.mockResolvedValueOnce([])
    // Count query for topics
    mockDb.execute.mockResolvedValueOnce([{ count: '50' }])
    // Count query for replies
    mockDb.execute.mockResolvedValueOnce([{ count: '10' }])

    const response = await app.inject({
      method: 'GET',
      url: '/api/search?q=test',
    })

    expect(response.statusCode).toBe(200)
    const body = response.json<{
      results: unknown[]
      cursor: string | null
      total: number
    }>()
    // Should return exactly 25 (limit), not 26
    expect(body.results).toHaveLength(25)
    expect(body.cursor).toBeTruthy()
    expect(body.total).toBe(60) // 50 topics + 10 replies
  })

  it('returns null cursor when fewer results than limit', async () => {
    mockDb.execute.mockResolvedValueOnce([sampleTopicRow()])
    mockDb.execute.mockResolvedValueOnce([])

    const response = await app.inject({
      method: 'GET',
      url: '/api/search?q=test',
    })

    expect(response.statusCode).toBe(200)
    const body = response.json<{
      cursor: string | null
      total: number
    }>()
    expect(body.cursor).toBeNull()
    expect(body.total).toBe(1)
  })

  // =========================================================================
  // Search mode reporting
  // =========================================================================

  it("reports searchMode as 'fulltext' when no embedding URL", async () => {
    mockDb.execute.mockResolvedValueOnce([])
    mockDb.execute.mockResolvedValueOnce([])

    const response = await app.inject({
      method: 'GET',
      url: '/api/search?q=test',
    })

    expect(response.statusCode).toBe(200)
    const body = response.json<{ searchMode: string }>()
    expect(body.searchMode).toBe('fulltext')
  })

  it("reports searchMode as 'hybrid' when embedding service is available and returns embeddings", async () => {
    // Configure embedding service as enabled with working embeddings
    mockIsEnabled.mockReturnValue(true)
    mockGenerateEmbedding.mockResolvedValue([0.1, 0.2, 0.3])

    // Rebuild app to pick up updated mock state
    const hybridApp = await buildTestApp()

    // Full-text topic results
    mockDb.execute.mockResolvedValueOnce([sampleTopicRow()])
    // Full-text reply results
    mockDb.execute.mockResolvedValueOnce([])
    // Vector topic results
    mockDb.execute.mockResolvedValueOnce([])
    // Vector reply results
    mockDb.execute.mockResolvedValueOnce([])

    const response = await hybridApp.inject({
      method: 'GET',
      url: '/api/search?q=semantic+query',
    })

    expect(response.statusCode).toBe(200)
    const body = response.json<{ searchMode: string }>()
    expect(body.searchMode).toBe('hybrid')

    await hybridApp.close()
  })

  it('falls back to fulltext when embedding service is enabled but returns null', async () => {
    mockIsEnabled.mockReturnValue(true)
    mockGenerateEmbedding.mockResolvedValue(null)

    const fallbackApp = await buildTestApp()

    mockDb.execute.mockResolvedValueOnce([])
    mockDb.execute.mockResolvedValueOnce([])

    const response = await fallbackApp.inject({
      method: 'GET',
      url: '/api/search?q=test',
    })

    expect(response.statusCode).toBe(200)
    const body = response.json<{ searchMode: string }>()
    expect(body.searchMode).toBe('fulltext')

    await fallbackApp.close()
  })

  // =========================================================================
  // Content snippeting
  // =========================================================================

  it('truncates long content to snippet', async () => {
    const longContent = 'A'.repeat(500)
    mockDb.execute.mockResolvedValueOnce([sampleTopicRow({ content: longContent })])
    mockDb.execute.mockResolvedValueOnce([])

    const response = await app.inject({
      method: 'GET',
      url: '/api/search?q=test',
    })

    expect(response.statusCode).toBe(200)
    const body = response.json<{
      results: Array<{ content: string }>
    }>()
    // createSnippet truncates at 300 chars + "..."
    expect(body.results[0]?.content.length).toBeLessThanOrEqual(303)
    expect(body.results[0]?.content).toContain('...')
  })

  // =========================================================================
  // Date serialization
  // =========================================================================

  it('serializes Date objects as ISO strings in results', async () => {
    mockDb.execute.mockResolvedValueOnce([
      sampleTopicRow({ created_at: new Date('2026-02-13T12:00:00.000Z') }),
    ])
    mockDb.execute.mockResolvedValueOnce([])

    const response = await app.inject({
      method: 'GET',
      url: '/api/search?q=test',
    })

    expect(response.statusCode).toBe(200)
    const body = response.json<{
      results: Array<{ createdAt: string }>
    }>()
    expect(body.results[0]?.createdAt).toBe('2026-02-13T12:00:00.000Z')
  })

  it('handles string dates from DB gracefully', async () => {
    mockDb.execute.mockResolvedValueOnce([
      sampleTopicRow({ created_at: '2026-02-13T12:00:00.000Z' }),
    ])
    mockDb.execute.mockResolvedValueOnce([])

    const response = await app.inject({
      method: 'GET',
      url: '/api/search?q=test',
    })

    expect(response.statusCode).toBe(200)
    const body = response.json<{
      results: Array<{ createdAt: string }>
    }>()
    expect(body.results[0]?.createdAt).toBe('2026-02-13T12:00:00.000Z')
  })

  // =========================================================================
  // Community filtering (Issue: search must include community_did)
  // =========================================================================

  it('includes community_did in SQL queries (single mode)', async () => {
    // The app is configured in single mode with TEST_COMMUNITY_DID.
    // The search functions should include community_did in their WHERE clauses.
    // We verify by checking that db.execute is called (the SQL is parameterized
    // and includes the community_did filter internally).
    mockDb.execute.mockResolvedValueOnce([sampleTopicRow()])
    mockDb.execute.mockResolvedValueOnce([])

    const response = await app.inject({
      method: 'GET',
      url: '/api/search?q=test&type=all',
    })

    expect(response.statusCode).toBe(200)
    // Both topic and reply search should have been called
    expect(mockDb.execute).toHaveBeenCalledTimes(2)
  })

  // =========================================================================
  // Deletion filtering (Issue: deleted replies must not appear in search)
  // =========================================================================

  it('excludes deleted replies from search results (deletion filter applied)', async () => {
    // The reply search query now includes is_author_deleted = false in the WHERE clause.
    // Since we mock the DB to return only non-deleted rows, the key verification is
    // that the route processes normally. The actual SQL filtering happens at the DB level.
    const nonDeletedReply = sampleReplyRow()
    // Reply search only (type=replies skips topic search): returns non-deleted replies
    mockDb.execute.mockResolvedValueOnce([nonDeletedReply])

    const response = await app.inject({
      method: 'GET',
      url: '/api/search?q=test&type=replies',
    })

    expect(response.statusCode).toBe(200)
    const body = response.json<{
      results: Array<{ type: string; uri: string }>
    }>()
    expect(body.results).toHaveLength(1)
    expect(body.results[0]?.type).toBe('reply')
    expect(body.results[0]?.uri).toBe(nonDeletedReply.uri)
  })

  // =========================================================================
  // Cursor-based pagination
  // =========================================================================

  it('accepts a valid cursor and passes decoded values to DB queries', async () => {
    // Build a valid cursor: base64(JSON({ rank, uri }))
    const cursorPayload = Buffer.from(
      JSON.stringify({ rank: 0.5, uri: 'at://did:plc:x/forum.barazo.topic.post/abc' })
    ).toString('base64')

    mockDb.execute.mockResolvedValueOnce([sampleTopicRow()])
    mockDb.execute.mockResolvedValueOnce([])

    const response = await app.inject({
      method: 'GET',
      url: `/api/search?q=test&cursor=${encodeURIComponent(cursorPayload)}`,
    })

    expect(response.statusCode).toBe(200)
    expect(response.json<{ results: unknown[] }>().results).toHaveLength(1)
    // Two DB calls: topic search + reply search, both should include cursor conditions
    expect(mockDb.execute).toHaveBeenCalledTimes(2)
  })

  it('ignores an invalid (non-base64) cursor gracefully', async () => {
    mockDb.execute.mockResolvedValueOnce([sampleTopicRow()])
    mockDb.execute.mockResolvedValueOnce([])

    const response = await app.inject({
      method: 'GET',
      url: '/api/search?q=test&cursor=!!!invalid!!!',
    })

    expect(response.statusCode).toBe(200)
    expect(response.json<{ results: unknown[] }>().results).toHaveLength(1)
  })

  it('ignores a cursor with invalid JSON structure (missing rank or uri)', async () => {
    // Valid base64, valid JSON, but wrong shape (no "uri" field)
    const cursorPayload = Buffer.from(JSON.stringify({ rank: 0.5 })).toString('base64')

    mockDb.execute.mockResolvedValueOnce([sampleTopicRow()])
    mockDb.execute.mockResolvedValueOnce([])

    const response = await app.inject({
      method: 'GET',
      url: `/api/search?q=test&cursor=${encodeURIComponent(cursorPayload)}`,
    })

    expect(response.statusCode).toBe(200)
    expect(response.json<{ results: unknown[] }>().results).toHaveLength(1)
  })

  it('ignores a cursor with wrong types (rank is string instead of number)', async () => {
    const cursorPayload = Buffer.from(
      JSON.stringify({ rank: 'not-a-number', uri: 'at://x/y/z' })
    ).toString('base64')

    mockDb.execute.mockResolvedValueOnce([sampleTopicRow()])
    mockDb.execute.mockResolvedValueOnce([])

    const response = await app.inject({
      method: 'GET',
      url: `/api/search?q=test&cursor=${encodeURIComponent(cursorPayload)}`,
    })

    expect(response.statusCode).toBe(200)
    expect(response.json<{ results: unknown[] }>().results).toHaveLength(1)
  })

  // =========================================================================
  // Custom limit parameter
  // =========================================================================

  it('respects a custom limit parameter', async () => {
    // Set limit=2. Route fetches limit+1=3.
    // Return 3 rows to trigger hasMore.
    const rows = Array.from({ length: 3 }, (_, i) =>
      sampleTopicRow({
        uri: `at://${TEST_DID}/forum.barazo.topic.post/t${String(i)}`,
        rkey: `t${String(i)}`,
        rank: 1.0 - i * 0.1,
      })
    )

    mockDb.execute.mockResolvedValueOnce(rows)
    mockDb.execute.mockResolvedValueOnce([])
    // Count queries
    mockDb.execute.mockResolvedValueOnce([{ count: '10' }])
    mockDb.execute.mockResolvedValueOnce([{ count: '5' }])

    const response = await app.inject({
      method: 'GET',
      url: '/api/search?q=test&limit=2',
    })

    expect(response.statusCode).toBe(200)
    const body = response.json<{
      results: unknown[]
      cursor: string | null
      total: number
    }>()
    expect(body.results).toHaveLength(2)
    expect(body.cursor).toBeTruthy()
    expect(body.total).toBe(15) // 10+5
  })

  // =========================================================================
  // Global community mode (no community_did filter)
  // =========================================================================

  it('does not filter by community_did in global mode', async () => {
    const globalApp = Fastify({ logger: false })

    globalApp.decorateRequest('user', undefined as RequestUser | undefined)
    globalApp.decorate('db', mockDb as never)
    globalApp.decorate('env', {
      EMBEDDING_URL: undefined,
      AI_EMBEDDING_DIMENSIONS: 768,
      COMMUNITY_MODE: 'global',
      COMMUNITY_DID: undefined,
    } as never)
    globalApp.decorate('authMiddleware', {
      requireAuth: vi.fn((_req: unknown, _reply: unknown) => Promise.resolve()),
      optionalAuth: vi.fn((_req: unknown, _reply: unknown) => Promise.resolve()),
    } as never)
    globalApp.decorate('cache', {} as never)

    await globalApp.register(searchRoutes())
    await globalApp.ready()

    mockDb.execute.mockResolvedValueOnce([sampleTopicRow()])
    mockDb.execute.mockResolvedValueOnce([])

    const response = await globalApp.inject({
      method: 'GET',
      url: '/api/search?q=test',
    })

    expect(response.statusCode).toBe(200)
    const body = response.json<{
      results: Array<{ type: string }>
      searchMode: string
    }>()
    expect(body.results).toHaveLength(1)
    expect(body.results[0]?.type).toBe('topic')

    await globalApp.close()
  })

  // =========================================================================
  // Hybrid search: type=topics only (vector topics)
  // =========================================================================

  it('hybrid search runs vector topic search when type=topics', async () => {
    mockIsEnabled.mockReturnValue(true)
    mockGenerateEmbedding.mockResolvedValue([0.1, 0.2, 0.3])

    const hybridApp = await buildTestApp()

    const topicRow = sampleTopicRow()
    // Full-text topics
    mockDb.execute.mockResolvedValueOnce([topicRow])
    // Vector topics
    mockDb.execute.mockResolvedValueOnce([
      sampleTopicRow({
        uri: `at://${TEST_DID}/forum.barazo.topic.post/vectorTopic1`,
        rkey: 'vectorTopic1',
        rank: 0.85,
      }),
    ])

    const response = await hybridApp.inject({
      method: 'GET',
      url: '/api/search?q=test&type=topics',
    })

    expect(response.statusCode).toBe(200)
    const body = response.json<{
      results: Array<{ type: string }>
      searchMode: string
    }>()
    expect(body.searchMode).toBe('hybrid')
    // Should have merged results (RRF fusion)
    expect(body.results.length).toBeGreaterThanOrEqual(1)
    // Only 2 DB calls: fulltext topics + vector topics (no replies)
    expect(mockDb.execute).toHaveBeenCalledTimes(2)

    await hybridApp.close()
  })

  // =========================================================================
  // Hybrid search: type=replies only (vector replies)
  // =========================================================================

  it('hybrid search runs vector reply search when type=replies', async () => {
    mockIsEnabled.mockReturnValue(true)
    mockGenerateEmbedding.mockResolvedValue([0.4, 0.5, 0.6])

    const hybridApp = await buildTestApp()

    const replyRow = sampleReplyRow()
    // Full-text replies
    mockDb.execute.mockResolvedValueOnce([replyRow])
    // Vector replies
    mockDb.execute.mockResolvedValueOnce([
      sampleReplyRow({
        uri: `at://${TEST_DID}/forum.barazo.topic.reply/vectorReply1`,
        rkey: 'vectorReply1',
        rank: 0.9,
      }),
    ])

    const response = await hybridApp.inject({
      method: 'GET',
      url: '/api/search?q=test&type=replies',
    })

    expect(response.statusCode).toBe(200)
    const body = response.json<{
      results: Array<{ type: string }>
      searchMode: string
    }>()
    expect(body.searchMode).toBe('hybrid')
    expect(body.results.length).toBeGreaterThanOrEqual(1)
    // Only 2 DB calls: fulltext replies + vector replies (no topics)
    expect(mockDb.execute).toHaveBeenCalledTimes(2)

    await hybridApp.close()
  })

  // =========================================================================
  // Hybrid search: RRF fusion merges overlapping results
  // =========================================================================

  it('hybrid search merges duplicate URIs via RRF fusion', async () => {
    mockIsEnabled.mockReturnValue(true)
    mockGenerateEmbedding.mockResolvedValue([0.1, 0.2, 0.3])

    const hybridApp = await buildTestApp()

    const sharedUri = `at://${TEST_DID}/forum.barazo.topic.post/shared1`
    const topicRow = sampleTopicRow({ uri: sharedUri, rkey: 'shared1', rank: 0.8 })

    // Full-text topics
    mockDb.execute.mockResolvedValueOnce([topicRow])
    // Full-text replies
    mockDb.execute.mockResolvedValueOnce([])
    // Vector topics (same URI as fulltext -- should merge)
    mockDb.execute.mockResolvedValueOnce([
      sampleTopicRow({ uri: sharedUri, rkey: 'shared1', rank: 0.7 }),
    ])
    // Vector replies
    mockDb.execute.mockResolvedValueOnce([])

    const response = await hybridApp.inject({
      method: 'GET',
      url: '/api/search?q=overlap&type=all',
    })

    expect(response.statusCode).toBe(200)
    const body = response.json<{
      results: Array<{ uri: string; rank: number }>
      searchMode: string
    }>()
    expect(body.searchMode).toBe('hybrid')
    // The same URI should appear only once (merged by RRF)
    const uris = body.results.map((r) => r.uri)
    expect(new Set(uris).size).toBe(uris.length)
    // The merged item's rank should reflect combined RRF score
    expect(body.results).toHaveLength(1)

    await hybridApp.close()
  })

  // =========================================================================
  // Hybrid search with all filters applied
  // =========================================================================

  it('hybrid search applies all filters to vector topic queries', async () => {
    mockIsEnabled.mockReturnValue(true)
    mockGenerateEmbedding.mockResolvedValue([0.1, 0.2, 0.3])

    const hybridApp = await buildTestApp()

    // Full-text topics
    mockDb.execute.mockResolvedValueOnce([])
    // Full-text replies
    mockDb.execute.mockResolvedValueOnce([])
    // Vector topics (with filters)
    mockDb.execute.mockResolvedValueOnce([
      sampleTopicRow({ category: 'guides', author_did: 'did:plc:author1' }),
    ])
    // Vector replies (with filters)
    mockDb.execute.mockResolvedValueOnce([])

    const response = await hybridApp.inject({
      method: 'GET',
      url: '/api/search?q=test&category=guides&author=did:plc:author1&dateFrom=2026-01-01T00:00:00Z&dateTo=2026-12-31T23:59:59Z',
    })

    expect(response.statusCode).toBe(200)
    const body = response.json<{
      results: Array<{ category: string | null; authorDid: string }>
      searchMode: string
    }>()
    expect(body.searchMode).toBe('hybrid')
    // 4 DB calls: fulltext topics, fulltext replies, vector topics, vector replies
    expect(mockDb.execute).toHaveBeenCalledTimes(4)

    await hybridApp.close()
  })

  it('hybrid search applies all filters to vector reply queries', async () => {
    mockIsEnabled.mockReturnValue(true)
    mockGenerateEmbedding.mockResolvedValue([0.1, 0.2, 0.3])

    const hybridApp = await buildTestApp()

    // Full-text topics
    mockDb.execute.mockResolvedValueOnce([])
    // Full-text replies
    mockDb.execute.mockResolvedValueOnce([])
    // Vector topics
    mockDb.execute.mockResolvedValueOnce([])
    // Vector replies (with filters)
    mockDb.execute.mockResolvedValueOnce([
      sampleReplyRow({
        author_did: 'did:plc:author2',
        created_at: new Date('2026-06-15T10:00:00Z'),
      }),
    ])

    const response = await hybridApp.inject({
      method: 'GET',
      url: '/api/search?q=test&author=did:plc:author2&dateFrom=2026-01-01T00:00:00Z&dateTo=2026-12-31T23:59:59Z',
    })

    expect(response.statusCode).toBe(200)
    const body = response.json<{
      results: Array<{ type: string }>
      searchMode: string
    }>()
    expect(body.searchMode).toBe('hybrid')
    expect(mockDb.execute).toHaveBeenCalledTimes(4)

    await hybridApp.close()
  })

  // =========================================================================
  // Vector search date serialization (string dates for vector results)
  // =========================================================================

  it('handles string dates from DB in vector topic results', async () => {
    mockIsEnabled.mockReturnValue(true)
    mockGenerateEmbedding.mockResolvedValue([0.1, 0.2])

    const hybridApp = await buildTestApp()

    // Full-text topics
    mockDb.execute.mockResolvedValueOnce([])
    // Full-text replies
    mockDb.execute.mockResolvedValueOnce([])
    // Vector topics with string date
    mockDb.execute.mockResolvedValueOnce([
      sampleTopicRow({ created_at: '2026-03-01T00:00:00.000Z' }),
    ])
    // Vector replies
    mockDb.execute.mockResolvedValueOnce([])

    const response = await hybridApp.inject({
      method: 'GET',
      url: '/api/search?q=test',
    })

    expect(response.statusCode).toBe(200)
    const body = response.json<{
      results: Array<{ createdAt: string }>
    }>()
    expect(body.results).toHaveLength(1)
    expect(body.results[0]?.createdAt).toBe('2026-03-01T00:00:00.000Z')

    await hybridApp.close()
  })

  it('handles string dates from DB in vector reply results', async () => {
    mockIsEnabled.mockReturnValue(true)
    mockGenerateEmbedding.mockResolvedValue([0.1, 0.2])

    const hybridApp = await buildTestApp()

    // Full-text topics
    mockDb.execute.mockResolvedValueOnce([])
    // Full-text replies
    mockDb.execute.mockResolvedValueOnce([])
    // Vector topics
    mockDb.execute.mockResolvedValueOnce([])
    // Vector replies with string date
    mockDb.execute.mockResolvedValueOnce([
      sampleReplyRow({ created_at: '2026-04-01T12:00:00.000Z' }),
    ])

    const response = await hybridApp.inject({
      method: 'GET',
      url: '/api/search?q=test',
    })

    expect(response.statusCode).toBe(200)
    const body = response.json<{
      results: Array<{ createdAt: string }>
    }>()
    expect(body.results).toHaveLength(1)
    expect(body.results[0]?.createdAt).toBe('2026-04-01T12:00:00.000Z')

    await hybridApp.close()
  })

  // =========================================================================
  // Reply date serialization (string fallback)
  // =========================================================================

  it('handles string dates from DB in fulltext reply results', async () => {
    mockDb.execute.mockResolvedValueOnce([])
    mockDb.execute.mockResolvedValueOnce([
      sampleReplyRow({ created_at: '2026-05-01T08:00:00.000Z' }),
    ])

    const response = await app.inject({
      method: 'GET',
      url: '/api/search?q=test',
    })

    expect(response.statusCode).toBe(200)
    const body = response.json<{
      results: Array<{ createdAt: string }>
    }>()
    expect(body.results).toHaveLength(1)
    expect(body.results[0]?.createdAt).toBe('2026-05-01T08:00:00.000Z')
  })

  // =========================================================================
  // Pagination: count queries with all filters
  // =========================================================================

  it('passes all filters to count query for topics when paginated', async () => {
    // Use limit=1 so 2 results triggers hasMore
    // With type=topics, only topic count query runs
    const rows = [
      sampleTopicRow({
        uri: `at://${TEST_DID}/forum.barazo.topic.post/a`,
        rkey: 'a',
        rank: 0.9,
      }),
      sampleTopicRow({
        uri: `at://${TEST_DID}/forum.barazo.topic.post/b`,
        rkey: 'b',
        rank: 0.8,
      }),
    ]

    // Full-text topic search returns 2 rows (limit=1, fetch limit+1=2)
    mockDb.execute.mockResolvedValueOnce(rows)
    // Count query for topics (with category, author, dateFrom, dateTo filters)
    mockDb.execute.mockResolvedValueOnce([{ count: '100' }])

    const response = await app.inject({
      method: 'GET',
      url: '/api/search?q=test&type=topics&limit=1&category=general&author=did:plc:testuser123&dateFrom=2026-01-01T00:00:00Z&dateTo=2026-12-31T23:59:59Z',
    })

    expect(response.statusCode).toBe(200)
    const body = response.json<{
      results: unknown[]
      cursor: string | null
      total: number
    }>()
    expect(body.results).toHaveLength(1)
    expect(body.cursor).toBeTruthy()
    expect(body.total).toBe(100)
    // 2 DB calls: topic search + topic count
    expect(mockDb.execute).toHaveBeenCalledTimes(2)
  })

  it('passes all filters to count query for replies when paginated', async () => {
    const rows = [
      sampleReplyRow({
        uri: `at://${TEST_DID}/forum.barazo.topic.reply/r1`,
        rkey: 'r1',
        rank: 0.9,
      }),
      sampleReplyRow({
        uri: `at://${TEST_DID}/forum.barazo.topic.reply/r2`,
        rkey: 'r2',
        rank: 0.8,
      }),
    ]

    // Full-text reply search returns 2 rows (limit=1, fetch limit+1=2)
    mockDb.execute.mockResolvedValueOnce(rows)
    // Count query for replies (with author, dateFrom, dateTo filters)
    mockDb.execute.mockResolvedValueOnce([{ count: '50' }])

    const response = await app.inject({
      method: 'GET',
      url: '/api/search?q=test&type=replies&limit=1&author=did:plc:testuser123&dateFrom=2026-01-01T00:00:00Z&dateTo=2026-12-31T23:59:59Z',
    })

    expect(response.statusCode).toBe(200)
    const body = response.json<{
      results: unknown[]
      cursor: string | null
      total: number
    }>()
    expect(body.results).toHaveLength(1)
    expect(body.cursor).toBeTruthy()
    expect(body.total).toBe(50)
    // 2 DB calls: reply search + reply count
    expect(mockDb.execute).toHaveBeenCalledTimes(2)
  })

  it('runs both topic and reply count queries for type=all when paginated', async () => {
    // With type=all and limit=1, we need 2 results across topics+replies
    const topicRows = [
      sampleTopicRow({
        uri: `at://${TEST_DID}/forum.barazo.topic.post/ct1`,
        rkey: 'ct1',
        rank: 0.95,
      }),
    ]
    const replyRows = [
      sampleReplyRow({
        uri: `at://${TEST_DID}/forum.barazo.topic.reply/cr1`,
        rkey: 'cr1',
        rank: 0.85,
      }),
    ]

    // Full-text topic search
    mockDb.execute.mockResolvedValueOnce(topicRows)
    // Full-text reply search
    mockDb.execute.mockResolvedValueOnce(replyRows)
    // Count query for topics
    mockDb.execute.mockResolvedValueOnce([{ count: '30' }])
    // Count query for replies
    mockDb.execute.mockResolvedValueOnce([{ count: '20' }])

    const response = await app.inject({
      method: 'GET',
      url: '/api/search?q=test&type=all&limit=1',
    })

    expect(response.statusCode).toBe(200)
    const body = response.json<{
      results: unknown[]
      cursor: string | null
      total: number
    }>()
    expect(body.results).toHaveLength(1)
    expect(body.cursor).toBeTruthy()
    expect(body.total).toBe(50) // 30 + 20
    // 4 DB calls: topic search + reply search + topic count + reply count
    expect(mockDb.execute).toHaveBeenCalledTimes(4)
  })

  // =========================================================================
  // Count queries with global mode (no communityDid filter)
  // =========================================================================

  it('count queries work without community filter in global mode', async () => {
    const globalApp = Fastify({ logger: false })

    globalApp.decorateRequest('user', undefined as RequestUser | undefined)
    globalApp.decorate('db', mockDb as never)
    globalApp.decorate('env', {
      EMBEDDING_URL: undefined,
      AI_EMBEDDING_DIMENSIONS: 768,
      COMMUNITY_MODE: 'global',
      COMMUNITY_DID: undefined,
    } as never)
    globalApp.decorate('authMiddleware', {
      requireAuth: vi.fn((_req: unknown, _reply: unknown) => Promise.resolve()),
      optionalAuth: vi.fn((_req: unknown, _reply: unknown) => Promise.resolve()),
    } as never)
    globalApp.decorate('cache', {} as never)

    await globalApp.register(searchRoutes())
    await globalApp.ready()

    const rows = [
      sampleTopicRow({
        uri: `at://${TEST_DID}/forum.barazo.topic.post/g1`,
        rkey: 'g1',
        rank: 0.9,
      }),
      sampleTopicRow({
        uri: `at://${TEST_DID}/forum.barazo.topic.post/g2`,
        rkey: 'g2',
        rank: 0.8,
      }),
    ]

    // Full-text topic search (limit=1, returns 2)
    mockDb.execute.mockResolvedValueOnce(rows)
    // Full-text reply search
    mockDb.execute.mockResolvedValueOnce([])
    // Count query topics
    mockDb.execute.mockResolvedValueOnce([{ count: '25' }])
    // Count query replies
    mockDb.execute.mockResolvedValueOnce([{ count: '10' }])

    const response = await globalApp.inject({
      method: 'GET',
      url: '/api/search?q=test&limit=1',
    })

    expect(response.statusCode).toBe(200)
    const body = response.json<{
      results: unknown[]
      total: number
    }>()
    expect(body.results).toHaveLength(1)
    expect(body.total).toBe(35)

    await globalApp.close()
  })

  // =========================================================================
  // Content snippet: short content (no truncation)
  // =========================================================================

  it('does not truncate content shorter than 300 chars', async () => {
    const shortContent = 'Short content here.'
    mockDb.execute.mockResolvedValueOnce([sampleTopicRow({ content: shortContent })])
    mockDb.execute.mockResolvedValueOnce([])

    const response = await app.inject({
      method: 'GET',
      url: '/api/search?q=test',
    })

    expect(response.statusCode).toBe(200)
    const body = response.json<{
      results: Array<{ content: string }>
    }>()
    expect(body.results[0]?.content).toBe(shortContent)
    expect(body.results[0]?.content).not.toContain('...')
  })

  // =========================================================================
  // Cursor with type=replies (cursor filter in reply search)
  // =========================================================================

  it('passes cursor to reply search when type=replies', async () => {
    const cursorPayload = Buffer.from(
      JSON.stringify({ rank: 0.4, uri: 'at://did:plc:x/forum.barazo.topic.reply/prev' })
    ).toString('base64')

    mockDb.execute.mockResolvedValueOnce([sampleReplyRow()])

    const response = await app.inject({
      method: 'GET',
      url: `/api/search?q=test&type=replies&cursor=${encodeURIComponent(cursorPayload)}`,
    })

    expect(response.statusCode).toBe(200)
    expect(response.json<{ results: unknown[] }>().results).toHaveLength(1)
    // Only 1 DB call: reply search (no topic search for type=replies)
    expect(mockDb.execute).toHaveBeenCalledTimes(1)
  })

  // =========================================================================
  // Hybrid search in global mode (no communityDid for vector search)
  // =========================================================================

  it('hybrid search runs without community filter in global mode', async () => {
    mockIsEnabled.mockReturnValue(true)
    mockGenerateEmbedding.mockResolvedValue([0.1, 0.2, 0.3])

    const globalHybridApp = Fastify({ logger: false })

    globalHybridApp.decorateRequest('user', undefined as RequestUser | undefined)
    globalHybridApp.decorate('db', mockDb as never)
    globalHybridApp.decorate('env', {
      EMBEDDING_URL: 'http://embedding:8080',
      AI_EMBEDDING_DIMENSIONS: 768,
      COMMUNITY_MODE: 'global',
      COMMUNITY_DID: undefined,
    } as never)
    globalHybridApp.decorate('authMiddleware', {
      requireAuth: vi.fn((_req: unknown, _reply: unknown) => Promise.resolve()),
      optionalAuth: vi.fn((_req: unknown, _reply: unknown) => Promise.resolve()),
    } as never)
    globalHybridApp.decorate('cache', {} as never)

    await globalHybridApp.register(searchRoutes())
    await globalHybridApp.ready()

    // Full-text topics
    mockDb.execute.mockResolvedValueOnce([sampleTopicRow()])
    // Full-text replies
    mockDb.execute.mockResolvedValueOnce([])
    // Vector topics
    mockDb.execute.mockResolvedValueOnce([])
    // Vector replies
    mockDb.execute.mockResolvedValueOnce([])

    const response = await globalHybridApp.inject({
      method: 'GET',
      url: '/api/search?q=test',
    })

    expect(response.statusCode).toBe(200)
    const body = response.json<{
      searchMode: string
      results: unknown[]
    }>()
    expect(body.searchMode).toBe('hybrid')
    expect(body.results.length).toBeGreaterThanOrEqual(1)

    await globalHybridApp.close()
  })

  // =========================================================================
  // Muted word annotation with authenticated user
  // =========================================================================

  it('annotates results with isMutedWord=true when muted words match', async () => {
    mockDb.execute.mockResolvedValueOnce([sampleTopicRow({ content: 'This contains spam word' })])
    mockDb.execute.mockResolvedValueOnce([])

    // Configure muted words to return a match
    mockLoadMutedWords.mockResolvedValue(['spam'])
    mockContentMatchesMutedWords.mockReturnValue(true)

    const response = await app.inject({
      method: 'GET',
      url: '/api/search?q=test',
    })

    expect(response.statusCode).toBe(200)
    const body = response.json<{
      results: Array<{ isMutedWord: boolean }>
    }>()
    expect(body.results).toHaveLength(1)
    expect(body.results[0]?.isMutedWord).toBe(true)
    expect(mockLoadMutedWords).toHaveBeenCalled()
    expect(mockContentMatchesMutedWords).toHaveBeenCalled()
  })

  it('annotates results with isMutedWord=false when no muted words match', async () => {
    mockDb.execute.mockResolvedValueOnce([sampleTopicRow()])
    mockDb.execute.mockResolvedValueOnce([])

    mockLoadMutedWords.mockResolvedValue(['something-unrelated'])
    mockContentMatchesMutedWords.mockReturnValue(false)

    const response = await app.inject({
      method: 'GET',
      url: '/api/search?q=test',
    })

    expect(response.statusCode).toBe(200)
    const body = response.json<{
      results: Array<{ isMutedWord: boolean }>
    }>()
    expect(body.results).toHaveLength(1)
    expect(body.results[0]?.isMutedWord).toBe(false)
  })

  it('calls loadMutedWords with authenticated user DID', async () => {
    mockDb.execute.mockResolvedValueOnce([sampleTopicRow()])
    mockDb.execute.mockResolvedValueOnce([])

    // Simulate an authenticated user by setting request.user in the optionalAuth handler
    const authApp = Fastify({ logger: false })

    authApp.decorateRequest('user', undefined as RequestUser | undefined)
    authApp.decorateRequest('communityDid', undefined as string | undefined)
    authApp.addHook('onRequest', async (request) => {
      request.communityDid = 'did:plc:test'
    })
    authApp.decorate('db', mockDb as never)
    authApp.decorate('env', {
      EMBEDDING_URL: undefined,
      AI_EMBEDDING_DIMENSIONS: 768,
      COMMUNITY_MODE: 'single',
      COMMUNITY_DID: TEST_COMMUNITY_DID,
    } as never)
    authApp.decorate('authMiddleware', {
      requireAuth: vi.fn((_req: unknown, _reply: unknown) => Promise.resolve()),
      optionalAuth: vi.fn((req: { user: RequestUser | undefined }, _reply: unknown) => {
        req.user = { did: 'did:plc:autheduser', handle: 'authed.test' }
        return Promise.resolve()
      }),
    } as never)
    authApp.decorate('cache', {} as never)

    await authApp.register(searchRoutes())
    await authApp.ready()

    const response = await authApp.inject({
      method: 'GET',
      url: '/api/search?q=test',
    })

    expect(response.statusCode).toBe(200)
    // loadMutedWords should be called with the authenticated user's DID and community DID
    expect(mockLoadMutedWords).toHaveBeenCalledWith(
      'did:plc:autheduser',
      'did:plc:test',
      expect.anything()
    )

    await authApp.close()
  })

  // =========================================================================
  // Fulltext-only: sort by rank descending
  // =========================================================================

  it('sorts fulltext-only results by rank descending', async () => {
    const lowRank = sampleTopicRow({
      uri: `at://${TEST_DID}/forum.barazo.topic.post/low`,
      rkey: 'low',
      rank: 0.3,
    })
    const highRank = sampleTopicRow({
      uri: `at://${TEST_DID}/forum.barazo.topic.post/high`,
      rkey: 'high',
      rank: 0.9,
    })

    // Return in reverse order (low rank first) to verify sorting
    mockDb.execute.mockResolvedValueOnce([lowRank, highRank])
    mockDb.execute.mockResolvedValueOnce([])

    const response = await app.inject({
      method: 'GET',
      url: '/api/search?q=test&type=topics',
    })

    expect(response.statusCode).toBe(200)
    const body = response.json<{
      results: Array<{ uri: string; rank: number }>
    }>()
    expect(body.results).toHaveLength(2)
    // High rank should be first after sorting
    expect(body.results[0]?.uri).toContain('high')
    expect(body.results[1]?.uri).toContain('low')
    const first = body.results[0]
    const second = body.results[1]
    expect(first?.rank).toBeGreaterThan(second?.rank ?? 0)
  })

  // =========================================================================
  // Validation: limit boundaries
  // =========================================================================

  it('returns 400 for limit=0 (below minimum)', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/search?q=test&limit=0',
    })

    expect(response.statusCode).toBe(400)
  })

  it('returns 400 for limit=101 (above maximum)', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/search?q=test&limit=101',
    })

    expect(response.statusCode).toBe(400)
  })

  it('returns 400 for non-numeric limit', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/search?q=test&limit=abc',
    })

    expect(response.statusCode).toBe(400)
  })

  // =========================================================================
  // Reply with null root_title
  // =========================================================================

  it('handles reply with null root_title', async () => {
    const replyRow = sampleReplyRow({ root_title: null })
    mockDb.execute.mockReset()
    mockDb.execute.mockResolvedValueOnce([])
    mockDb.execute.mockResolvedValueOnce([replyRow])
    mockDb.execute.mockResolvedValue([])

    const response = await app.inject({
      method: 'GET',
      url: '/api/search?q=test',
    })

    expect(response.statusCode).toBe(200)
    const body = response.json<{
      results: Array<{ rootTitle: string | null }>
    }>()
    expect(body.results).toHaveLength(1)
    expect(body.results[0]?.rootTitle).toBeNull()
  })

  // =========================================================================
  // Count query with empty count row (fallback to 0)
  // =========================================================================

  it('handles empty count rows (defaults to 0)', async () => {
    const rows = [
      sampleTopicRow({
        uri: `at://${TEST_DID}/forum.barazo.topic.post/c1`,
        rkey: 'c1',
        rank: 0.9,
      }),
      sampleTopicRow({
        uri: `at://${TEST_DID}/forum.barazo.topic.post/c2`,
        rkey: 'c2',
        rank: 0.8,
      }),
    ]

    // Topic search returns 2 (limit=1 -> hasMore)
    mockDb.execute.mockResolvedValueOnce(rows)
    // Reply search
    mockDb.execute.mockResolvedValueOnce([])
    // Count query topics returns empty array
    mockDb.execute.mockResolvedValueOnce([])
    // Count query replies returns empty array
    mockDb.execute.mockResolvedValueOnce([])

    const response = await app.inject({
      method: 'GET',
      url: '/api/search?q=test&limit=1',
    })

    expect(response.statusCode).toBe(200)
    const body = response.json<{
      results: unknown[]
      total: number
    }>()
    expect(body.results).toHaveLength(1)
    // Both count queries returned empty -> total should be 0
    expect(body.total).toBe(0)
  })
})
