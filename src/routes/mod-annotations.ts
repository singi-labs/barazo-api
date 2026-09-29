import { eq, and, desc, sql, isNull } from 'drizzle-orm'
import { requireCommunityDid } from '../middleware/community-resolver.js'
import type { FastifyPluginCallback } from 'fastify'
import { notFound, forbidden, badRequest, errorResponseSchema } from '../lib/api-errors.js'
import {
  createModNoteSchema,
  modNoteQuerySchema,
  deleteModNoteSchema,
  createTopicNoticeSchema,
  dismissTopicNoticeSchema,
  topicNoticeQuerySchema,
  createWarningSchema,
  warningQuerySchema,
  acknowledgeWarningSchema,
} from '../validation/mod-annotations.js'
import { modNotes } from '../db/schema/mod-notes.js'
import { topicNotices } from '../db/schema/topic-notices.js'
import { modWarnings } from '../db/schema/mod-warnings.js'
import { moderationActions } from '../db/schema/moderation-actions.js'
import { createRequireModerator } from '../auth/require-moderator.js'

// ---------------------------------------------------------------------------
// OpenAPI JSON Schema definitions
// ---------------------------------------------------------------------------

const modNoteJsonSchema = {
  type: 'object' as const,
  properties: {
    id: { type: 'number' as const },
    authorDid: { type: 'string' as const },
    subjectDid: { type: ['string', 'null'] as const },
    subjectUri: { type: ['string', 'null'] as const },
    content: { type: 'string' as const },
    noteType: { type: 'string' as const },
    createdAt: { type: 'string' as const, format: 'date-time' as const },
  },
}

const topicNoticeJsonSchema = {
  type: 'object' as const,
  properties: {
    id: { type: 'number' as const },
    topicUri: { type: 'string' as const },
    authorDid: { type: 'string' as const },
    noticeType: { type: 'string' as const },
    headline: { type: 'string' as const },
    body: { type: ['string', 'null'] as const },
    createdAt: { type: 'string' as const, format: 'date-time' as const },
    dismissedAt: { type: ['string', 'null'] as const },
  },
}

const warningJsonSchema = {
  type: 'object' as const,
  properties: {
    id: { type: 'number' as const },
    targetDid: { type: 'string' as const },
    moderatorDid: { type: 'string' as const },
    warningType: { type: 'string' as const },
    message: { type: 'string' as const },
    modComment: { type: ['string', 'null'] as const },
    acknowledgedAt: { type: ['string', 'null'] as const },
    createdAt: { type: 'string' as const, format: 'date-time' as const },
  },
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function serializeModNote(row: typeof modNotes.$inferSelect) {
  return {
    id: row.id,
    authorDid: row.authorDid,
    subjectDid: row.subjectDid,
    subjectUri: row.subjectUri,
    content: row.content,
    noteType: row.noteType,
    createdAt: row.createdAt.toISOString(),
  }
}

function serializeTopicNotice(row: typeof topicNotices.$inferSelect) {
  return {
    id: row.id,
    topicUri: row.topicUri,
    authorDid: row.authorDid,
    noticeType: row.noticeType,
    headline: row.headline,
    body: row.body,
    createdAt: row.createdAt.toISOString(),
    dismissedAt: row.dismissedAt?.toISOString() ?? null,
  }
}

function serializeWarning(row: typeof modWarnings.$inferSelect) {
  return {
    id: row.id,
    targetDid: row.targetDid,
    moderatorDid: row.moderatorDid,
    warningType: row.warningType,
    message: row.message,
    modComment: row.modComment,
    acknowledgedAt: row.acknowledgedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  }
}

function encodeCursor(createdAt: string, id: number): string {
  return Buffer.from(JSON.stringify({ createdAt, id })).toString('base64')
}

function decodeCursor(cursor: string): { createdAt: string; id: number } | null {
  try {
    const decoded = JSON.parse(Buffer.from(cursor, 'base64').toString('utf-8')) as Record<
      string,
      unknown
    >
    if (typeof decoded.createdAt === 'string' && typeof decoded.id === 'number') {
      return { createdAt: decoded.createdAt, id: decoded.id }
    }
    return null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Mod annotation routes plugin
// ---------------------------------------------------------------------------

export function modAnnotationRoutes(): FastifyPluginCallback {
  return (app, _opts, done) => {
    const { db, authMiddleware } = app
    const requireModerator = createRequireModerator(db, authMiddleware, app.log)

    // -------------------------------------------------------------------
    // POST /api/mod-notes (moderator+)
    // -------------------------------------------------------------------

    app.post(
      '/api/mod-notes',
      {
        preHandler: [requireModerator],
        schema: {
          tags: ['Mod Annotations'],
          summary: 'Create a moderator note on a user or post',
          security: [{ bearerAuth: [] }],
          body: {
            type: 'object',
            properties: {
              subjectDid: { type: 'string' },
              subjectUri: { type: 'string' },
              content: { type: 'string', minLength: 1, maxLength: 5000 },
            },
            required: ['content'],
          },
          response: {
            201: {
              type: 'object',
              properties: {
                note: modNoteJsonSchema,
              },
            },
            400: errorResponseSchema,
            401: errorResponseSchema,
            403: errorResponseSchema,
          },
        },
      },
      async (request, reply) => {
        const communityDid = requireCommunityDid(request)
        const user = request.user
        if (!user) {
          return reply.status(401).send({ error: 'Authentication required' })
        }

        const parsed = createModNoteSchema.safeParse(request.body)
        if (!parsed.success) {
          throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid request body')
        }

        const { subjectDid, subjectUri, content } = parsed.data

        const rows = await db
          .insert(modNotes)
          .values({
            communityDid,
            authorDid: user.did,
            subjectDid: subjectDid ?? null,
            subjectUri: subjectUri ?? null,
            content,
            noteType: 'note',
          })
          .returning()

        const note = rows[0]
        if (!note) {
          throw badRequest('Failed to create mod note')
        }

        // Audit trail
        await db.insert(moderationActions).values({
          action: 'note_created',
          targetUri: subjectUri ?? null,
          targetDid: subjectDid ?? null,
          moderatorDid: user.did,
          communityDid,
          reason: content.slice(0, 200),
        })

        app.log.info(
          { noteId: note.id, moderatorDid: user.did, subjectDid, subjectUri },
          'Mod note created'
        )

        return reply.status(201).send({ note: serializeModNote(note) })
      }
    )

    // -------------------------------------------------------------------
    // GET /api/mod-notes (moderator+)
    // -------------------------------------------------------------------

    app.get(
      '/api/mod-notes',
      {
        preHandler: [requireModerator],
        schema: {
          tags: ['Mod Annotations'],
          summary: 'List moderator notes (filter by subjectDid or subjectUri)',
          security: [{ bearerAuth: [] }],
          querystring: {
            type: 'object',
            properties: {
              subjectDid: { type: 'string' },
              subjectUri: { type: 'string' },
              cursor: { type: 'string' },
              limit: { type: 'string' },
            },
          },
          response: {
            200: {
              type: 'object',
              properties: {
                notes: { type: 'array', items: modNoteJsonSchema },
                cursor: { type: ['string', 'null'] },
              },
            },
            400: errorResponseSchema,
            401: errorResponseSchema,
          },
        },
      },
      async (request, reply) => {
        const communityDid = requireCommunityDid(request)

        const parsed = modNoteQuerySchema.safeParse(request.query)
        if (!parsed.success) {
          throw badRequest('Invalid query parameters')
        }

        const { subjectDid, subjectUri, cursor, limit } = parsed.data
        const conditions = [eq(modNotes.communityDid, communityDid)]

        if (subjectDid) {
          conditions.push(eq(modNotes.subjectDid, subjectDid))
        }
        if (subjectUri) {
          conditions.push(eq(modNotes.subjectUri, subjectUri))
        }

        if (cursor) {
          const decoded = decodeCursor(cursor)
          if (decoded) {
            conditions.push(
              sql`(${modNotes.createdAt}, ${modNotes.id}) < (${decoded.createdAt}::timestamptz, ${decoded.id})`
            )
          }
        }

        const whereClause = and(...conditions)
        const fetchLimit = limit + 1

        const rows = await db
          .select()
          .from(modNotes)
          .where(whereClause)
          .orderBy(desc(modNotes.createdAt))
          .limit(fetchLimit)

        const hasMore = rows.length > limit
        const resultRows = hasMore ? rows.slice(0, limit) : rows

        let nextCursor: string | null = null
        if (hasMore) {
          const lastRow = resultRows[resultRows.length - 1]
          if (lastRow) {
            nextCursor = encodeCursor(lastRow.createdAt.toISOString(), lastRow.id)
          }
        }

        return reply.status(200).send({
          notes: resultRows.map(serializeModNote),
          cursor: nextCursor,
        })
      }
    )

    // -------------------------------------------------------------------
    // DELETE /api/mod-notes/:id (moderator+)
    // -------------------------------------------------------------------

    app.delete(
      '/api/mod-notes/:id',
      {
        preHandler: [requireModerator],
        schema: {
          tags: ['Mod Annotations'],
          summary: 'Delete a moderator note',
          security: [{ bearerAuth: [] }],
          params: {
            type: 'object',
            required: ['id'],
            properties: { id: { type: 'string' } },
          },
          response: {
            200: {
              type: 'object',
              properties: {
                success: { type: 'boolean' },
              },
            },
            400: errorResponseSchema,
            401: errorResponseSchema,
            404: errorResponseSchema,
          },
        },
      },
      async (request, reply) => {
        const communityDid = requireCommunityDid(request)
        const user = request.user
        if (!user) {
          return reply.status(401).send({ error: 'Authentication required' })
        }

        const paramsParsed = deleteModNoteSchema.safeParse(request.params)
        if (!paramsParsed.success) {
          throw badRequest('Invalid note ID')
        }

        const { id } = paramsParsed.data

        const rows = await db
          .select()
          .from(modNotes)
          .where(and(eq(modNotes.id, id), eq(modNotes.communityDid, communityDid)))

        const note = rows[0]
        if (!note) {
          throw notFound('Mod note not found')
        }

        await db
          .delete(modNotes)
          .where(and(eq(modNotes.id, id), eq(modNotes.communityDid, communityDid)))

        await db.insert(moderationActions).values({
          action: 'note_deleted',
          targetUri: note.subjectUri,
          targetDid: note.subjectDid,
          moderatorDid: user.did,
          communityDid,
          reason: `Deleted mod note #${String(id)}`,
        })

        app.log.info({ noteId: id, moderatorDid: user.did }, 'Mod note deleted')

        return reply.status(200).send({ success: true })
      }
    )

    // -------------------------------------------------------------------
    // POST /api/topic-notices (moderator+)
    // -------------------------------------------------------------------

    app.post(
      '/api/topic-notices',
      {
        preHandler: [requireModerator],
        schema: {
          tags: ['Mod Annotations'],
          summary: 'Create a topic notice',
          security: [{ bearerAuth: [] }],
          body: {
            type: 'object',
            required: ['topicUri', 'noticeType', 'headline'],
            properties: {
              topicUri: { type: 'string' },
              noticeType: {
                type: 'string',
                enum: ['closed', 'moved', 'outdated', 'announcement', 'custom'],
              },
              headline: { type: 'string', minLength: 1, maxLength: 200 },
              body: { type: 'string', maxLength: 2000 },
            },
          },
          response: {
            201: {
              type: 'object',
              properties: {
                notice: topicNoticeJsonSchema,
              },
            },
            400: errorResponseSchema,
            401: errorResponseSchema,
            403: errorResponseSchema,
          },
        },
      },
      async (request, reply) => {
        const communityDid = requireCommunityDid(request)
        const user = request.user
        if (!user) {
          return reply.status(401).send({ error: 'Authentication required' })
        }

        const parsed = createTopicNoticeSchema.safeParse(request.body)
        if (!parsed.success) {
          throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid request body')
        }

        const { topicUri, noticeType, headline, body } = parsed.data

        const rows = await db
          .insert(topicNotices)
          .values({
            communityDid,
            topicUri,
            authorDid: user.did,
            noticeType,
            headline,
            body: body ?? null,
          })
          .returning()

        const notice = rows[0]
        if (!notice) {
          throw badRequest('Failed to create topic notice')
        }

        // Audit trail
        await db.insert(moderationActions).values({
          action: 'notice_added',
          targetUri: topicUri,
          moderatorDid: user.did,
          communityDid,
          reason: headline,
        })

        app.log.info(
          { noticeId: notice.id, moderatorDid: user.did, topicUri },
          'Topic notice created'
        )

        return reply.status(201).send({ notice: serializeTopicNotice(notice) })
      }
    )

    // -------------------------------------------------------------------
    // GET /api/topic-notices (public with topicUri, moderator+ without)
    // -------------------------------------------------------------------

    app.get(
      '/api/topic-notices',
      {
        schema: {
          tags: ['Mod Annotations'],
          summary:
            'List topic notices (public when filtered by topicUri, moderator-only otherwise)',
          querystring: {
            type: 'object',
            properties: {
              topicUri: { type: 'string' },
              cursor: { type: 'string' },
              limit: { type: 'string' },
            },
          },
          response: {
            200: {
              type: 'object',
              properties: {
                notices: { type: 'array', items: topicNoticeJsonSchema },
                cursor: { type: ['string', 'null'] },
              },
            },
            400: errorResponseSchema,
            401: errorResponseSchema,
          },
        },
      },
      async (request, reply) => {
        const communityDid = requireCommunityDid(request)

        const parsed = topicNoticeQuerySchema.safeParse(request.query)
        if (!parsed.success) {
          throw badRequest('Invalid query parameters')
        }

        const { topicUri, cursor, limit } = parsed.data

        // When no topicUri is provided, require moderator auth
        if (!topicUri) {
          await requireModerator(request, reply)
          if (reply.sent) return
        }

        const conditions = [eq(topicNotices.communityDid, communityDid)]

        if (topicUri) {
          conditions.push(eq(topicNotices.topicUri, topicUri))
          // Public view: only active (non-dismissed) notices
          conditions.push(isNull(topicNotices.dismissedAt))
        }

        if (cursor) {
          const decoded = decodeCursor(cursor)
          if (decoded) {
            conditions.push(
              sql`(${topicNotices.createdAt}, ${topicNotices.id}) < (${decoded.createdAt}::timestamptz, ${decoded.id})`
            )
          }
        }

        const whereClause = and(...conditions)
        const fetchLimit = limit + 1

        const rows = await db
          .select()
          .from(topicNotices)
          .where(whereClause)
          .orderBy(desc(topicNotices.createdAt))
          .limit(fetchLimit)

        const hasMore = rows.length > limit
        const resultRows = hasMore ? rows.slice(0, limit) : rows

        let nextCursor: string | null = null
        if (hasMore) {
          const lastRow = resultRows[resultRows.length - 1]
          if (lastRow) {
            nextCursor = encodeCursor(lastRow.createdAt.toISOString(), lastRow.id)
          }
        }

        return reply.status(200).send({
          notices: resultRows.map(serializeTopicNotice),
          cursor: nextCursor,
        })
      }
    )

    // -------------------------------------------------------------------
    // DELETE /api/topic-notices/:id (moderator+, soft delete)
    // -------------------------------------------------------------------

    app.delete(
      '/api/topic-notices/:id',
      {
        preHandler: [requireModerator],
        schema: {
          tags: ['Mod Annotations'],
          summary: 'Dismiss a topic notice (soft delete)',
          security: [{ bearerAuth: [] }],
          params: {
            type: 'object',
            required: ['id'],
            properties: { id: { type: 'string' } },
          },
          response: {
            200: {
              type: 'object',
              properties: {
                notice: topicNoticeJsonSchema,
              },
            },
            400: errorResponseSchema,
            401: errorResponseSchema,
            404: errorResponseSchema,
          },
        },
      },
      async (request, reply) => {
        const communityDid = requireCommunityDid(request)
        const user = request.user
        if (!user) {
          return reply.status(401).send({ error: 'Authentication required' })
        }

        const paramsParsed = dismissTopicNoticeSchema.safeParse(request.params)
        if (!paramsParsed.success) {
          throw badRequest('Invalid notice ID')
        }

        const { id } = paramsParsed.data

        const rows = await db
          .select()
          .from(topicNotices)
          .where(and(eq(topicNotices.id, id), eq(topicNotices.communityDid, communityDid)))

        const notice = rows[0]
        if (!notice) {
          throw notFound('Topic notice not found')
        }

        const updatedRows = await db
          .update(topicNotices)
          .set({ dismissedAt: sql`now()` })
          .where(and(eq(topicNotices.id, id), eq(topicNotices.communityDid, communityDid)))
          .returning()

        const updated = updatedRows[0]
        if (!updated) {
          throw notFound('Failed to dismiss topic notice')
        }

        // Audit trail
        await db.insert(moderationActions).values({
          action: 'notice_removed',
          targetUri: notice.topicUri,
          moderatorDid: user.did,
          communityDid,
          reason: `Dismissed notice: ${notice.headline}`,
        })

        app.log.info({ noticeId: id, moderatorDid: user.did }, 'Topic notice dismissed')

        return reply.status(200).send({ notice: serializeTopicNotice(updated) })
      }
    )

    // -------------------------------------------------------------------
    // POST /api/warnings (moderator+)
    // -------------------------------------------------------------------

    app.post(
      '/api/warnings',
      {
        preHandler: [requireModerator],
        schema: {
          tags: ['Mod Annotations'],
          summary: 'Issue a warning to a user',
          security: [{ bearerAuth: [] }],
          body: {
            type: 'object',
            required: ['targetDid', 'warningType', 'message'],
            properties: {
              targetDid: { type: 'string' },
              warningType: {
                type: 'string',
                enum: ['off_topic', 'harassment', 'rule_violation', 'other', 'custom'],
              },
              message: { type: 'string', minLength: 1, maxLength: 2000 },
              modComment: { type: 'string', maxLength: 300 },
              internalNote: { type: 'string', maxLength: 5000 },
            },
          },
          response: {
            201: {
              type: 'object',
              properties: {
                warning: warningJsonSchema,
              },
            },
            400: errorResponseSchema,
            401: errorResponseSchema,
            403: errorResponseSchema,
          },
        },
      },
      async (request, reply) => {
        const communityDid = requireCommunityDid(request)
        const user = request.user
        if (!user) {
          return reply.status(401).send({ error: 'Authentication required' })
        }

        const parsed = createWarningSchema.safeParse(request.body)
        if (!parsed.success) {
          throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid request body')
        }

        const { targetDid, warningType, message, modComment, internalNote } = parsed.data

        const rows = await db
          .insert(modWarnings)
          .values({
            communityDid,
            targetDid,
            moderatorDid: user.did,
            warningType,
            message,
            modComment: modComment ?? null,
            internalNote: internalNote ?? null,
          })
          .returning()

        const warning = rows[0]
        if (!warning) {
          throw badRequest('Failed to create warning')
        }

        // If internalNote provided, also create a mod note with warning_context type
        if (internalNote) {
          await db.insert(modNotes).values({
            communityDid,
            authorDid: user.did,
            subjectDid: targetDid,
            content: internalNote,
            noteType: 'warning_context',
          })
        }

        // Audit trail
        await db.insert(moderationActions).values({
          action: 'warning_issued',
          targetDid,
          moderatorDid: user.did,
          communityDid,
          reason: message.slice(0, 200),
        })

        app.log.info({ warningId: warning.id, moderatorDid: user.did, targetDid }, 'Warning issued')

        return reply.status(201).send({ warning: serializeWarning(warning) })
      }
    )

    // -------------------------------------------------------------------
    // GET /api/warnings (moderator+)
    // -------------------------------------------------------------------

    app.get(
      '/api/warnings',
      {
        preHandler: [requireModerator],
        schema: {
          tags: ['Mod Annotations'],
          summary: 'List warnings (filter by targetDid)',
          security: [{ bearerAuth: [] }],
          querystring: {
            type: 'object',
            properties: {
              targetDid: { type: 'string' },
              cursor: { type: 'string' },
              limit: { type: 'string' },
            },
          },
          response: {
            200: {
              type: 'object',
              properties: {
                warnings: { type: 'array', items: warningJsonSchema },
                cursor: { type: ['string', 'null'] },
              },
            },
            400: errorResponseSchema,
            401: errorResponseSchema,
          },
        },
      },
      async (request, reply) => {
        const communityDid = requireCommunityDid(request)

        const parsed = warningQuerySchema.safeParse(request.query)
        if (!parsed.success) {
          throw badRequest('Invalid query parameters')
        }

        const { targetDid, cursor, limit } = parsed.data
        const conditions = [eq(modWarnings.communityDid, communityDid)]

        if (targetDid) {
          conditions.push(eq(modWarnings.targetDid, targetDid))
        }

        if (cursor) {
          const decoded = decodeCursor(cursor)
          if (decoded) {
            conditions.push(
              sql`(${modWarnings.createdAt}, ${modWarnings.id}) < (${decoded.createdAt}::timestamptz, ${decoded.id})`
            )
          }
        }

        const whereClause = and(...conditions)
        const fetchLimit = limit + 1

        const rows = await db
          .select()
          .from(modWarnings)
          .where(whereClause)
          .orderBy(desc(modWarnings.createdAt))
          .limit(fetchLimit)

        const hasMore = rows.length > limit
        const resultRows = hasMore ? rows.slice(0, limit) : rows

        let nextCursor: string | null = null
        if (hasMore) {
          const lastRow = resultRows[resultRows.length - 1]
          if (lastRow) {
            nextCursor = encodeCursor(lastRow.createdAt.toISOString(), lastRow.id)
          }
        }

        return reply.status(200).send({
          warnings: resultRows.map(serializeWarning),
          cursor: nextCursor,
        })
      }
    )

    // -------------------------------------------------------------------
    // POST /api/warnings/:id/acknowledge (authenticated, target user only)
    // -------------------------------------------------------------------

    app.post(
      '/api/warnings/:id/acknowledge',
      {
        preHandler: [authMiddleware.requireAuth],
        schema: {
          tags: ['Mod Annotations'],
          summary: 'Acknowledge a warning (target user only)',
          security: [{ bearerAuth: [] }],
          params: {
            type: 'object',
            required: ['id'],
            properties: { id: { type: 'string' } },
          },
          response: {
            200: {
              type: 'object',
              properties: {
                warning: warningJsonSchema,
              },
            },
            400: errorResponseSchema,
            401: errorResponseSchema,
            403: errorResponseSchema,
            404: errorResponseSchema,
          },
        },
      },
      async (request, reply) => {
        const communityDid = requireCommunityDid(request)
        const user = request.user
        if (!user) {
          return reply.status(401).send({ error: 'Authentication required' })
        }

        const paramsParsed = acknowledgeWarningSchema.safeParse(request.params)
        if (!paramsParsed.success) {
          throw badRequest('Invalid warning ID')
        }

        const { id } = paramsParsed.data

        const rows = await db
          .select()
          .from(modWarnings)
          .where(and(eq(modWarnings.id, id), eq(modWarnings.communityDid, communityDid)))

        const warning = rows[0]
        if (!warning) {
          throw notFound('Warning not found')
        }

        if (warning.targetDid !== user.did) {
          throw forbidden('You can only acknowledge warnings directed at you')
        }

        if (warning.acknowledgedAt) {
          throw badRequest('Warning has already been acknowledged')
        }

        const updatedRows = await db
          .update(modWarnings)
          .set({ acknowledgedAt: sql`now()` })
          .where(and(eq(modWarnings.id, id), eq(modWarnings.communityDid, communityDid)))
          .returning()

        const updated = updatedRows[0]
        if (!updated) {
          throw notFound('Failed to acknowledge warning')
        }

        app.log.info({ warningId: id, userDid: user.did }, 'Warning acknowledged')

        return reply.status(200).send({ warning: serializeWarning(updated) })
      }
    )

    // -------------------------------------------------------------------
    // GET /api/my-warnings (authenticated)
    // -------------------------------------------------------------------

    app.get(
      '/api/my-warnings',
      {
        preHandler: [authMiddleware.requireAuth],
        schema: {
          tags: ['Mod Annotations'],
          summary: 'List own warnings in this community',
          security: [{ bearerAuth: [] }],
          querystring: {
            type: 'object',
            properties: {
              cursor: { type: 'string' },
              limit: { type: 'string' },
            },
          },
          response: {
            200: {
              type: 'object',
              properties: {
                warnings: { type: 'array', items: warningJsonSchema },
                cursor: { type: ['string', 'null'] },
              },
            },
            400: errorResponseSchema,
            401: errorResponseSchema,
          },
        },
      },
      async (request, reply) => {
        const communityDid = requireCommunityDid(request)
        const user = request.user
        if (!user) {
          return reply.status(401).send({ error: 'Authentication required' })
        }

        const parsed = warningQuerySchema.safeParse(request.query)
        if (!parsed.success) {
          throw badRequest('Invalid query parameters')
        }

        const { cursor, limit } = parsed.data
        const conditions = [
          eq(modWarnings.communityDid, communityDid),
          eq(modWarnings.targetDid, user.did),
        ]

        if (cursor) {
          const decoded = decodeCursor(cursor)
          if (decoded) {
            conditions.push(
              sql`(${modWarnings.createdAt}, ${modWarnings.id}) < (${decoded.createdAt}::timestamptz, ${decoded.id})`
            )
          }
        }

        const whereClause = and(...conditions)
        const fetchLimit = limit + 1

        const rows = await db
          .select()
          .from(modWarnings)
          .where(whereClause)
          .orderBy(desc(modWarnings.createdAt))
          .limit(fetchLimit)

        const hasMore = rows.length > limit
        const resultRows = hasMore ? rows.slice(0, limit) : rows

        let nextCursor: string | null = null
        if (hasMore) {
          const lastRow = resultRows[resultRows.length - 1]
          if (lastRow) {
            nextCursor = encodeCursor(lastRow.createdAt.toISOString(), lastRow.id)
          }
        }

        return reply.status(200).send({
          warnings: resultRows.map(serializeWarning),
          cursor: nextCursor,
        })
      }
    )

    done()
  }
}
