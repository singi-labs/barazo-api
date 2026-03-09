import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest'
import Fastify from 'fastify'
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import type { Env } from '../../../src/config/env.js'
import type { AuthMiddleware, RequestUser } from '../../../src/auth/middleware.js'
import type { SessionService } from '../../../src/auth/session.js'
import type { SetupService } from '../../../src/setup/service.js'
import { type DbChain, createChainableProxy, createMockDb } from '../../helpers/mock-db.js'

// ---------------------------------------------------------------------------
// Mock requireModerator module (must be before importing routes)
// ---------------------------------------------------------------------------

const mockRequireModerator =
  vi.fn<(request: FastifyRequest, reply: FastifyReply) => Promise<void>>()

vi.mock('../../../src/auth/require-moderator.js', () => ({
  createRequireModerator: () => mockRequireModerator,
}))

// Import routes AFTER mocking
import { modAnnotationRoutes } from '../../../src/routes/mod-annotations.js'

// ---------------------------------------------------------------------------
// Mock env
// ---------------------------------------------------------------------------

const mockEnv = {
  COMMUNITY_DID: 'did:plc:community123',
  RATE_LIMIT_WRITE: 10,
  RATE_LIMIT_READ_ANON: 100,
  RATE_LIMIT_READ_AUTH: 300,
} as Env

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const MOD_DID = 'did:plc:moderator1'
const MOD_HANDLE = 'mod.bsky.team'
const MOD_SID = 'b'.repeat(64)
const TARGET_DID = 'did:plc:targetuser1'
const COMMUNITY_DID = 'did:plc:community123'
const TEST_NOW = '2026-02-13T12:00:00.000Z'
const TEST_TOPIC_URI = `at://${TARGET_DID}/forum.barazo.topic.post/topic123`

// ---------------------------------------------------------------------------
// Mock user builders
// ---------------------------------------------------------------------------

function modUser(overrides?: Partial<RequestUser>): RequestUser {
  return {
    did: MOD_DID,
    handle: MOD_HANDLE,
    sid: MOD_SID,
    ...overrides,
  }
}

function targetUser(): RequestUser {
  return {
    did: TARGET_DID,
    handle: 'target.bsky.team',
    sid: 'c'.repeat(64),
  }
}

// ---------------------------------------------------------------------------
// Chainable mock DB
// ---------------------------------------------------------------------------

const mockDb = createMockDb()

let insertChain: DbChain
let selectChain: DbChain
let updateChain: DbChain
let deleteChain: DbChain

function resetAllDbMocks(): void {
  insertChain = createChainableProxy()
  selectChain = createChainableProxy([])
  updateChain = createChainableProxy([])
  deleteChain = createChainableProxy()
  mockDb.insert.mockReturnValue(insertChain)
  mockDb.select.mockReturnValue(selectChain)
  mockDb.update.mockReturnValue(updateChain)
  mockDb.delete.mockReturnValue(deleteChain)
  // eslint-disable-next-line @typescript-eslint/no-misused-promises -- Intentionally async mock for Drizzle transaction
  mockDb.transaction.mockImplementation(async (fn: (tx: typeof mockDb) => Promise<unknown>) => {
    return await fn(mockDb)
  })
}

// ---------------------------------------------------------------------------
// Auth middleware mocks
// ---------------------------------------------------------------------------

function createMockAuthMiddleware(user?: RequestUser): AuthMiddleware {
  return {
    requireAuth: async (request, reply) => {
      if (!user) {
        await reply.status(401).send({ error: 'Authentication required' })
        return
      }
      request.user = user
    },
    optionalAuth: (request, _reply) => {
      if (user) {
        request.user = user
      }
      return Promise.resolve()
    },
  }
}

// ---------------------------------------------------------------------------
// Sample data builders
// ---------------------------------------------------------------------------

function sampleModNote(overrides?: Record<string, unknown>) {
  return {
    id: 1,
    communityDid: COMMUNITY_DID,
    authorDid: MOD_DID,
    subjectDid: TARGET_DID,
    subjectUri: null,
    content: 'Repeated spam behavior',
    noteType: 'note',
    createdAt: new Date(TEST_NOW),
    ...overrides,
  }
}

function sampleTopicNotice(overrides?: Record<string, unknown>) {
  return {
    id: 1,
    communityDid: COMMUNITY_DID,
    topicUri: TEST_TOPIC_URI,
    authorDid: MOD_DID,
    noticeType: 'closed',
    headline: 'Topic closed',
    body: 'This topic has been closed for discussion.',
    createdAt: new Date(TEST_NOW),
    dismissedAt: null,
    ...overrides,
  }
}

function sampleWarning(overrides?: Record<string, unknown>) {
  return {
    id: 1,
    communityDid: COMMUNITY_DID,
    targetDid: TARGET_DID,
    moderatorDid: MOD_DID,
    warningType: 'rule_violation',
    message: 'Please follow the community guidelines.',
    modComment: null,
    internalNote: null,
    acknowledgedAt: null,
    createdAt: new Date(TEST_NOW),
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Helper: build app with mocked deps
// ---------------------------------------------------------------------------

async function buildTestApp(user?: RequestUser): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })

  const authMiddleware = createMockAuthMiddleware(user)

  app.decorate('db', mockDb as never)
  app.decorate('env', mockEnv)
  app.decorate('authMiddleware', authMiddleware)
  app.decorate('firehose', {} as never)
  app.decorate('oauthClient', {} as never)
  app.decorate('sessionService', {} as SessionService)
  app.decorate('setupService', {} as SetupService)
  app.decorate('cache', {} as never)
  app.decorateRequest('user', undefined as RequestUser | undefined)
  app.decorateRequest('communityDid', undefined as string | undefined)
  app.addHook('onRequest', (request, _reply, done) => {
    request.communityDid = 'did:plc:test'
    done()
  })

  await app.register(modAnnotationRoutes())
  await app.ready()

  return app
}

// ===========================================================================
// Test suite
// ===========================================================================

describe('mod annotation routes', () => {
  // =========================================================================
  // POST /api/mod-notes
  // =========================================================================

  describe('POST /api/mod-notes', () => {
    let app: FastifyInstance

    beforeAll(async () => {
      app = await buildTestApp(modUser())
    })

    afterAll(async () => {
      await app.close()
    })

    beforeEach(() => {
      vi.clearAllMocks()
      resetAllDbMocks()

      mockRequireModerator.mockImplementation((request) => {
        request.user = modUser()
        return Promise.resolve()
      })
    })

    it('creates a mod note for a user (subjectDid) and returns it', async () => {
      const note = sampleModNote()
      insertChain.returning.mockResolvedValueOnce([note])

      const response = await app.inject({
        method: 'POST',
        url: '/api/mod-notes',
        headers: { authorization: 'Bearer test-token' },
        payload: {
          subjectDid: TARGET_DID,
          content: 'Repeated spam behavior',
        },
      })

      expect(response.statusCode).toBe(201)
      const body = response.json<{ note: { id: number } }>()
      expect(body.note.id).toBe(1)
      expect(body.note).toHaveProperty('content', 'Repeated spam behavior')

      // Audit trail
      expect(mockDb.insert).toHaveBeenCalledTimes(2) // mod_note + moderation_action
    })

    it('creates a mod note for a post (subjectUri) and returns it', async () => {
      const note = sampleModNote({ subjectDid: null, subjectUri: TEST_TOPIC_URI })
      insertChain.returning.mockResolvedValueOnce([note])

      const response = await app.inject({
        method: 'POST',
        url: '/api/mod-notes',
        headers: { authorization: 'Bearer test-token' },
        payload: {
          subjectUri: TEST_TOPIC_URI,
          content: 'Off-topic content',
        },
      })

      expect(response.statusCode).toBe(201)
      const body = response.json<{ note: { subjectUri: string } }>()
      expect(body.note.subjectUri).toBe(TEST_TOPIC_URI)
    })

    it('returns 400 when both subjectDid and subjectUri are provided', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/mod-notes',
        headers: { authorization: 'Bearer test-token' },
        payload: {
          subjectDid: TARGET_DID,
          subjectUri: TEST_TOPIC_URI,
          content: 'Bad request',
        },
      })

      expect(response.statusCode).toBe(400)
    })

    it('returns 400 when neither subjectDid nor subjectUri is provided', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/mod-notes',
        headers: { authorization: 'Bearer test-token' },
        payload: {
          content: 'No subject',
        },
      })

      expect(response.statusCode).toBe(400)
    })

    it('returns 401 when not authenticated', async () => {
      mockRequireModerator.mockImplementation(async (_request, reply) => {
        await reply.status(401).send({ error: 'Authentication required' })
      })

      const response = await app.inject({
        method: 'POST',
        url: '/api/mod-notes',
        payload: {
          subjectDid: TARGET_DID,
          content: 'Should fail',
        },
      })

      expect(response.statusCode).toBe(401)
    })
  })

  // =========================================================================
  // GET /api/mod-notes
  // =========================================================================

  describe('GET /api/mod-notes', () => {
    let app: FastifyInstance

    beforeAll(async () => {
      app = await buildTestApp(modUser())
    })

    afterAll(async () => {
      await app.close()
    })

    beforeEach(() => {
      vi.clearAllMocks()
      resetAllDbMocks()

      mockRequireModerator.mockImplementation((request) => {
        request.user = modUser()
        return Promise.resolve()
      })
    })

    it('lists mod notes with default pagination', async () => {
      const notes = [sampleModNote(), sampleModNote({ id: 2 })]
      selectChain.limit.mockResolvedValueOnce(notes)

      const response = await app.inject({
        method: 'GET',
        url: '/api/mod-notes',
        headers: { authorization: 'Bearer test-token' },
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{ notes: unknown[]; cursor: string | null }>()
      expect(body.notes).toHaveLength(2)
      expect(body.cursor).toBeNull()
    })

    it('filters mod notes by subjectDid', async () => {
      selectChain.limit.mockResolvedValueOnce([sampleModNote()])

      const response = await app.inject({
        method: 'GET',
        url: `/api/mod-notes?subjectDid=${TARGET_DID}`,
        headers: { authorization: 'Bearer test-token' },
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{ notes: unknown[] }>()
      expect(body.notes).toHaveLength(1)
    })

    it('returns cursor when more results exist', async () => {
      // limit defaults to 25, so 26 results means hasMore=true
      const manyNotes = Array.from({ length: 26 }, (_, i) =>
        sampleModNote({ id: i + 1 })
      )
      selectChain.limit.mockResolvedValueOnce(manyNotes)

      const response = await app.inject({
        method: 'GET',
        url: '/api/mod-notes',
        headers: { authorization: 'Bearer test-token' },
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{ notes: unknown[]; cursor: string | null }>()
      expect(body.notes).toHaveLength(25)
      expect(body.cursor).toBeTruthy()
    })

    it('returns 401 when not authenticated', async () => {
      mockRequireModerator.mockImplementation(async (_request, reply) => {
        await reply.status(401).send({ error: 'Authentication required' })
      })

      const response = await app.inject({
        method: 'GET',
        url: '/api/mod-notes',
      })

      expect(response.statusCode).toBe(401)
    })
  })

  // =========================================================================
  // DELETE /api/mod-notes/:id
  // =========================================================================

  describe('DELETE /api/mod-notes/:id', () => {
    let app: FastifyInstance

    beforeAll(async () => {
      app = await buildTestApp(modUser())
    })

    afterAll(async () => {
      await app.close()
    })

    beforeEach(() => {
      vi.clearAllMocks()
      resetAllDbMocks()

      mockRequireModerator.mockImplementation((request) => {
        request.user = modUser()
        return Promise.resolve()
      })
    })

    it('deletes a mod note and returns success', async () => {
      // First select finds the note, then delete runs
      selectChain.where.mockResolvedValueOnce([sampleModNote()])

      const response = await app.inject({
        method: 'DELETE',
        url: '/api/mod-notes/1',
        headers: { authorization: 'Bearer test-token' },
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{ success: boolean }>()
      expect(body.success).toBe(true)
    })

    it('returns 404 when note does not exist', async () => {
      selectChain.where.mockResolvedValueOnce([])

      const response = await app.inject({
        method: 'DELETE',
        url: '/api/mod-notes/999',
        headers: { authorization: 'Bearer test-token' },
      })

      expect(response.statusCode).toBe(404)
    })

    it('returns 400 for invalid id', async () => {
      const response = await app.inject({
        method: 'DELETE',
        url: '/api/mod-notes/abc',
        headers: { authorization: 'Bearer test-token' },
      })

      expect(response.statusCode).toBe(400)
    })

    it('returns 401 when not authenticated', async () => {
      mockRequireModerator.mockImplementation(async (_request, reply) => {
        await reply.status(401).send({ error: 'Authentication required' })
      })

      const response = await app.inject({
        method: 'DELETE',
        url: '/api/mod-notes/1',
      })

      expect(response.statusCode).toBe(401)
    })
  })

  // =========================================================================
  // POST /api/topic-notices
  // =========================================================================

  describe('POST /api/topic-notices', () => {
    let app: FastifyInstance

    beforeAll(async () => {
      app = await buildTestApp(modUser())
    })

    afterAll(async () => {
      await app.close()
    })

    beforeEach(() => {
      vi.clearAllMocks()
      resetAllDbMocks()

      mockRequireModerator.mockImplementation((request) => {
        request.user = modUser()
        return Promise.resolve()
      })
    })

    it('creates a topic notice and returns it', async () => {
      const notice = sampleTopicNotice()
      insertChain.returning.mockResolvedValueOnce([notice])

      const response = await app.inject({
        method: 'POST',
        url: '/api/topic-notices',
        headers: { authorization: 'Bearer test-token' },
        payload: {
          topicUri: TEST_TOPIC_URI,
          noticeType: 'closed',
          headline: 'Topic closed',
          body: 'This topic has been closed for discussion.',
        },
      })

      expect(response.statusCode).toBe(201)
      const body = response.json<{ notice: { id: number } }>()
      expect(body.notice.id).toBe(1)
      expect(body.notice).toHaveProperty('noticeType', 'closed')
    })

    it('returns 400 when required fields are missing', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/topic-notices',
        headers: { authorization: 'Bearer test-token' },
        payload: {
          topicUri: TEST_TOPIC_URI,
          // missing noticeType and headline
        },
      })

      expect(response.statusCode).toBe(400)
    })

    it('returns 401 when not authenticated', async () => {
      mockRequireModerator.mockImplementation(async (_request, reply) => {
        await reply.status(401).send({ error: 'Authentication required' })
      })

      const response = await app.inject({
        method: 'POST',
        url: '/api/topic-notices',
        payload: {
          topicUri: TEST_TOPIC_URI,
          noticeType: 'closed',
          headline: 'Topic closed',
        },
      })

      expect(response.statusCode).toBe(401)
    })
  })

  // =========================================================================
  // GET /api/topic-notices
  // =========================================================================

  describe('GET /api/topic-notices', () => {
    let app: FastifyInstance

    beforeAll(async () => {
      app = await buildTestApp(modUser())
    })

    afterAll(async () => {
      await app.close()
    })

    beforeEach(() => {
      vi.clearAllMocks()
      resetAllDbMocks()

      mockRequireModerator.mockImplementation((request) => {
        request.user = modUser()
        return Promise.resolve()
      })
    })

    it('returns active notices for a specific topicUri (public, no auth needed)', async () => {
      // Even without auth, filtering by topicUri should work
      mockRequireModerator.mockImplementation(async (_request, reply) => {
        await reply.status(401).send({ error: 'Authentication required' })
      })

      const notices = [sampleTopicNotice()]
      selectChain.limit.mockResolvedValueOnce(notices)

      const response = await app.inject({
        method: 'GET',
        url: `/api/topic-notices?topicUri=${encodeURIComponent(TEST_TOPIC_URI)}`,
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{ notices: unknown[] }>()
      expect(body.notices).toHaveLength(1)
    })

    it('returns all notices (including dismissed) for moderators without topicUri filter', async () => {
      const notices = [
        sampleTopicNotice(),
        sampleTopicNotice({ id: 2, dismissedAt: new Date(TEST_NOW) }),
      ]
      selectChain.limit.mockResolvedValueOnce(notices)

      const response = await app.inject({
        method: 'GET',
        url: '/api/topic-notices',
        headers: { authorization: 'Bearer test-token' },
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{ notices: unknown[] }>()
      expect(body.notices).toHaveLength(2)
    })

    it('returns 401 when no topicUri and not authenticated as moderator', async () => {
      mockRequireModerator.mockImplementation(async (_request, reply) => {
        await reply.status(401).send({ error: 'Authentication required' })
      })

      const response = await app.inject({
        method: 'GET',
        url: '/api/topic-notices',
      })

      expect(response.statusCode).toBe(401)
    })
  })

  // =========================================================================
  // DELETE /api/topic-notices/:id (soft delete / dismiss)
  // =========================================================================

  describe('DELETE /api/topic-notices/:id', () => {
    let app: FastifyInstance

    beforeAll(async () => {
      app = await buildTestApp(modUser())
    })

    afterAll(async () => {
      await app.close()
    })

    beforeEach(() => {
      vi.clearAllMocks()
      resetAllDbMocks()

      mockRequireModerator.mockImplementation((request) => {
        request.user = modUser()
        return Promise.resolve()
      })
    })

    it('dismisses a topic notice (soft delete) and returns it', async () => {
      selectChain.where.mockResolvedValueOnce([sampleTopicNotice()])
      const dismissed = sampleTopicNotice({ dismissedAt: new Date(TEST_NOW) })
      updateChain.returning.mockResolvedValueOnce([dismissed])

      const response = await app.inject({
        method: 'DELETE',
        url: '/api/topic-notices/1',
        headers: { authorization: 'Bearer test-token' },
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{ notice: { dismissedAt: string | null } }>()
      expect(body.notice.dismissedAt).toBeTruthy()
    })

    it('returns 404 when notice does not exist', async () => {
      selectChain.where.mockResolvedValueOnce([])

      const response = await app.inject({
        method: 'DELETE',
        url: '/api/topic-notices/999',
        headers: { authorization: 'Bearer test-token' },
      })

      expect(response.statusCode).toBe(404)
    })

    it('returns 400 for invalid id', async () => {
      const response = await app.inject({
        method: 'DELETE',
        url: '/api/topic-notices/abc',
        headers: { authorization: 'Bearer test-token' },
      })

      expect(response.statusCode).toBe(400)
    })

    it('returns 401 when not authenticated', async () => {
      mockRequireModerator.mockImplementation(async (_request, reply) => {
        await reply.status(401).send({ error: 'Authentication required' })
      })

      const response = await app.inject({
        method: 'DELETE',
        url: '/api/topic-notices/1',
      })

      expect(response.statusCode).toBe(401)
    })
  })

  // =========================================================================
  // POST /api/warnings
  // =========================================================================

  describe('POST /api/warnings', () => {
    let app: FastifyInstance

    beforeAll(async () => {
      app = await buildTestApp(modUser())
    })

    afterAll(async () => {
      await app.close()
    })

    beforeEach(() => {
      vi.clearAllMocks()
      resetAllDbMocks()

      mockRequireModerator.mockImplementation((request) => {
        request.user = modUser()
        return Promise.resolve()
      })
    })

    it('creates a warning and returns it', async () => {
      const warning = sampleWarning()
      insertChain.returning.mockResolvedValueOnce([warning])

      const response = await app.inject({
        method: 'POST',
        url: '/api/warnings',
        headers: { authorization: 'Bearer test-token' },
        payload: {
          targetDid: TARGET_DID,
          warningType: 'rule_violation',
          message: 'Please follow the community guidelines.',
        },
      })

      expect(response.statusCode).toBe(201)
      const body = response.json<{ warning: { id: number } }>()
      expect(body.warning.id).toBe(1)
      expect(body.warning).toHaveProperty('warningType', 'rule_violation')
    })

    it('creates a warning with internalNote and also creates a mod note', async () => {
      const warning = sampleWarning({ internalNote: 'This user has history' })
      insertChain.returning.mockResolvedValueOnce([warning])

      const response = await app.inject({
        method: 'POST',
        url: '/api/warnings',
        headers: { authorization: 'Bearer test-token' },
        payload: {
          targetDid: TARGET_DID,
          warningType: 'rule_violation',
          message: 'Please follow the community guidelines.',
          internalNote: 'This user has history',
        },
      })

      expect(response.statusCode).toBe(201)
      // warning insert + mod_note insert + moderation_action insert = 3 inserts
      expect(mockDb.insert).toHaveBeenCalledTimes(3)
    })

    it('returns 400 when required fields are missing', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/warnings',
        headers: { authorization: 'Bearer test-token' },
        payload: {
          targetDid: TARGET_DID,
          // missing warningType and message
        },
      })

      expect(response.statusCode).toBe(400)
    })

    it('returns 401 when not authenticated', async () => {
      mockRequireModerator.mockImplementation(async (_request, reply) => {
        await reply.status(401).send({ error: 'Authentication required' })
      })

      const response = await app.inject({
        method: 'POST',
        url: '/api/warnings',
        payload: {
          targetDid: TARGET_DID,
          warningType: 'rule_violation',
          message: 'Should fail',
        },
      })

      expect(response.statusCode).toBe(401)
    })
  })

  // =========================================================================
  // GET /api/warnings
  // =========================================================================

  describe('GET /api/warnings', () => {
    let app: FastifyInstance

    beforeAll(async () => {
      app = await buildTestApp(modUser())
    })

    afterAll(async () => {
      await app.close()
    })

    beforeEach(() => {
      vi.clearAllMocks()
      resetAllDbMocks()

      mockRequireModerator.mockImplementation((request) => {
        request.user = modUser()
        return Promise.resolve()
      })
    })

    it('lists warnings with default pagination', async () => {
      const warnings = [sampleWarning(), sampleWarning({ id: 2 })]
      selectChain.limit.mockResolvedValueOnce(warnings)

      const response = await app.inject({
        method: 'GET',
        url: '/api/warnings',
        headers: { authorization: 'Bearer test-token' },
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{ warnings: unknown[]; cursor: string | null }>()
      expect(body.warnings).toHaveLength(2)
      expect(body.cursor).toBeNull()
    })

    it('filters warnings by targetDid', async () => {
      selectChain.limit.mockResolvedValueOnce([sampleWarning()])

      const response = await app.inject({
        method: 'GET',
        url: `/api/warnings?targetDid=${TARGET_DID}`,
        headers: { authorization: 'Bearer test-token' },
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{ warnings: unknown[] }>()
      expect(body.warnings).toHaveLength(1)
    })

    it('returns 401 when not authenticated', async () => {
      mockRequireModerator.mockImplementation(async (_request, reply) => {
        await reply.status(401).send({ error: 'Authentication required' })
      })

      const response = await app.inject({
        method: 'GET',
        url: '/api/warnings',
      })

      expect(response.statusCode).toBe(401)
    })
  })

  // =========================================================================
  // POST /api/warnings/:id/acknowledge
  // =========================================================================

  describe('POST /api/warnings/:id/acknowledge', () => {
    let app: FastifyInstance

    beforeAll(async () => {
      app = await buildTestApp(targetUser())
    })

    afterAll(async () => {
      await app.close()
    })

    beforeEach(() => {
      vi.clearAllMocks()
      resetAllDbMocks()
    })

    it('acknowledges a warning for the target user', async () => {
      selectChain.where.mockResolvedValueOnce([sampleWarning()])
      const acknowledged = sampleWarning({ acknowledgedAt: new Date(TEST_NOW) })
      updateChain.returning.mockResolvedValueOnce([acknowledged])

      const response = await app.inject({
        method: 'POST',
        url: '/api/warnings/1/acknowledge',
        headers: { authorization: 'Bearer test-token' },
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{ warning: { acknowledgedAt: string | null } }>()
      expect(body.warning.acknowledgedAt).toBeTruthy()
    })

    it('returns 403 when user is not the warning target', async () => {
      // The warning targets TARGET_DID but user is someone else
      const warningForOther = sampleWarning({ targetDid: 'did:plc:someoneelse' })
      selectChain.where.mockResolvedValueOnce([warningForOther])

      const response = await app.inject({
        method: 'POST',
        url: '/api/warnings/1/acknowledge',
        headers: { authorization: 'Bearer test-token' },
      })

      expect(response.statusCode).toBe(403)
    })

    it('returns 404 when warning does not exist', async () => {
      selectChain.where.mockResolvedValueOnce([])

      const response = await app.inject({
        method: 'POST',
        url: '/api/warnings/999/acknowledge',
        headers: { authorization: 'Bearer test-token' },
      })

      expect(response.statusCode).toBe(404)
    })

    it('returns 400 when warning is already acknowledged', async () => {
      selectChain.where.mockResolvedValueOnce([
        sampleWarning({ acknowledgedAt: new Date(TEST_NOW) }),
      ])

      const response = await app.inject({
        method: 'POST',
        url: '/api/warnings/1/acknowledge',
        headers: { authorization: 'Bearer test-token' },
      })

      expect(response.statusCode).toBe(400)
    })

    it('returns 400 for invalid id', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/warnings/abc/acknowledge',
        headers: { authorization: 'Bearer test-token' },
      })

      expect(response.statusCode).toBe(400)
    })

    it('returns 401 when not authenticated', async () => {
      const unauthApp = await buildTestApp()
      const response = await unauthApp.inject({
        method: 'POST',
        url: '/api/warnings/1/acknowledge',
      })

      expect(response.statusCode).toBe(401)
      await unauthApp.close()
    })
  })

  // =========================================================================
  // GET /api/my-warnings
  // =========================================================================

  describe('GET /api/my-warnings', () => {
    let app: FastifyInstance

    beforeAll(async () => {
      app = await buildTestApp(targetUser())
    })

    afterAll(async () => {
      await app.close()
    })

    beforeEach(() => {
      vi.clearAllMocks()
      resetAllDbMocks()
    })

    it('lists own warnings in the community', async () => {
      const warnings = [sampleWarning()]
      selectChain.limit.mockResolvedValueOnce(warnings)

      const response = await app.inject({
        method: 'GET',
        url: '/api/my-warnings',
        headers: { authorization: 'Bearer test-token' },
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{ warnings: unknown[]; cursor: string | null }>()
      expect(body.warnings).toHaveLength(1)
      expect(body.cursor).toBeNull()
    })

    it('returns cursor when more results exist', async () => {
      const manyWarnings = Array.from({ length: 26 }, (_, i) =>
        sampleWarning({ id: i + 1 })
      )
      selectChain.limit.mockResolvedValueOnce(manyWarnings)

      const response = await app.inject({
        method: 'GET',
        url: '/api/my-warnings',
        headers: { authorization: 'Bearer test-token' },
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{ warnings: unknown[]; cursor: string | null }>()
      expect(body.warnings).toHaveLength(25)
      expect(body.cursor).toBeTruthy()
    })

    it('returns 401 when not authenticated', async () => {
      const unauthApp = await buildTestApp()
      const response = await unauthApp.inject({
        method: 'GET',
        url: '/api/my-warnings',
      })

      expect(response.statusCode).toBe(401)
      await unauthApp.close()
    })
  })
})
