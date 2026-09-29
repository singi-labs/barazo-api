import { eq, and, desc, isNull, sql } from 'drizzle-orm'
import { requireCommunityDid } from '../middleware/community-resolver.js'
import type { FastifyPluginCallback } from 'fastify'
import { notFound, badRequest, errorResponseSchema } from '../lib/api-errors.js'
import {
  createRuleSchema,
  updateRuleSchema,
  reorderRulesSchema,
  ruleVersionsQuerySchema,
} from '../validation/community-rules.js'
import { communityRules } from '../db/schema/community-rules.js'
import { communityRuleVersions } from '../db/schema/community-rule-versions.js'
import { createRequireAdmin } from '../auth/require-admin.js'

// ---------------------------------------------------------------------------
// OpenAPI JSON Schema definitions
// ---------------------------------------------------------------------------

const ruleJsonSchema = {
  type: 'object' as const,
  properties: {
    id: { type: 'number' as const },
    title: { type: 'string' as const },
    description: { type: 'string' as const },
    displayOrder: { type: 'number' as const },
    createdAt: { type: 'string' as const, format: 'date-time' as const },
    updatedAt: { type: 'string' as const, format: 'date-time' as const },
    archivedAt: { type: ['string', 'null'] as const },
  },
}

const ruleVersionJsonSchema = {
  type: 'object' as const,
  properties: {
    id: { type: 'number' as const },
    ruleId: { type: 'number' as const },
    title: { type: 'string' as const },
    description: { type: 'string' as const },
    createdAt: { type: 'string' as const, format: 'date-time' as const },
  },
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function serializeRule(row: typeof communityRules.$inferSelect) {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    displayOrder: row.displayOrder,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    archivedAt: row.archivedAt?.toISOString() ?? null,
  }
}

function serializeRuleVersion(row: typeof communityRuleVersions.$inferSelect) {
  return {
    id: row.id,
    ruleId: row.ruleId,
    title: row.title,
    description: row.description,
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
// Community rules routes plugin
// ---------------------------------------------------------------------------

export function communityRulesRoutes(): FastifyPluginCallback {
  return (app, _opts, done) => {
    const { db, authMiddleware } = app
    const requireAdmin = createRequireAdmin(db, authMiddleware, app.log)

    // -------------------------------------------------------------------
    // GET /api/communities/:did/rules (public)
    // -------------------------------------------------------------------
    app.get(
      '/api/communities/:did/rules',
      {
        schema: {
          tags: ['Community Rules'],
          summary: 'List active community rules',
          params: {
            type: 'object',
            required: ['did'],
            properties: { did: { type: 'string' } },
          },
          response: {
            200: {
              type: 'object',
              properties: {
                data: {
                  type: 'array',
                  items: ruleJsonSchema,
                },
              },
            },
          },
        },
      },
      async (request, reply) => {
        const { did } = request.params as { did: string }

        const rows = await db
          .select()
          .from(communityRules)
          .where(and(eq(communityRules.communityDid, did), isNull(communityRules.archivedAt)))
          .orderBy(communityRules.displayOrder)

        return reply.status(200).send({
          data: rows.map(serializeRule),
        })
      }
    )

    // -------------------------------------------------------------------
    // POST /api/communities/:did/rules (admin only)
    // -------------------------------------------------------------------
    app.post(
      '/api/communities/:did/rules',
      {
        preHandler: [requireAdmin],
        schema: {
          tags: ['Community Rules'],
          summary: 'Create a community rule',
          security: [{ bearerAuth: [] }],
          params: {
            type: 'object',
            required: ['did'],
            properties: { did: { type: 'string' } },
          },
          body: {
            type: 'object',
            required: ['title', 'description'],
            properties: {
              title: { type: 'string', maxLength: 200 },
              description: { type: 'string' },
            },
          },
          response: {
            201: ruleJsonSchema,
            400: errorResponseSchema,
            401: errorResponseSchema,
            403: errorResponseSchema,
          },
        },
      },
      async (request, reply) => {
        const communityDid = requireCommunityDid(request)
        const parsed = createRuleSchema.safeParse(request.body)
        if (!parsed.success) {
          throw badRequest('Invalid input: title and description are required')
        }

        const { title, description } = parsed.data

        // Determine next display order
        const maxOrderRows = await db
          .select({ maxOrder: sql<number>`COALESCE(MAX(${communityRules.displayOrder}), -1)` })
          .from(communityRules)
          .where(eq(communityRules.communityDid, communityDid))

        const nextOrder = (maxOrderRows[0]?.maxOrder ?? -1) + 1

        const created = await db.transaction(async (tx) => {
          const ruleRows = await tx
            .insert(communityRules)
            .values({
              communityDid,
              title,
              description,
              displayOrder: nextOrder,
            })
            .returning()

          const rule = ruleRows[0]
          if (!rule) {
            throw badRequest('Failed to create rule')
          }

          // Create initial version
          await tx.insert(communityRuleVersions).values({
            ruleId: rule.id,
            title,
            description,
          })

          return rule
        })

        app.log.info({ ruleId: created.id, communityDid }, 'Community rule created')

        return reply.status(201).send(serializeRule(created))
      }
    )

    // -------------------------------------------------------------------
    // PUT /api/communities/:did/rules/:id (admin only)
    // -------------------------------------------------------------------
    app.put(
      '/api/communities/:did/rules/:id',
      {
        preHandler: [requireAdmin],
        schema: {
          tags: ['Community Rules'],
          summary: 'Update a community rule (creates a new version)',
          security: [{ bearerAuth: [] }],
          params: {
            type: 'object',
            required: ['did', 'id'],
            properties: {
              did: { type: 'string' },
              id: { type: 'string' },
            },
          },
          body: {
            type: 'object',
            required: ['title', 'description'],
            properties: {
              title: { type: 'string', maxLength: 200 },
              description: { type: 'string' },
            },
          },
          response: {
            200: ruleJsonSchema,
            400: errorResponseSchema,
            401: errorResponseSchema,
            403: errorResponseSchema,
            404: errorResponseSchema,
          },
        },
      },
      async (request, reply) => {
        const communityDid = requireCommunityDid(request)
        const { id: idStr } = request.params as { id: string }
        const ruleId = parseInt(idStr, 10)
        if (Number.isNaN(ruleId)) {
          throw badRequest('Invalid rule ID')
        }

        const parsed = updateRuleSchema.safeParse(request.body)
        if (!parsed.success) {
          throw badRequest('Invalid input: title and description are required')
        }

        const { title, description } = parsed.data

        // Verify rule exists and belongs to this community
        const existingRows = await db
          .select()
          .from(communityRules)
          .where(
            and(
              eq(communityRules.id, ruleId),
              eq(communityRules.communityDid, communityDid),
              isNull(communityRules.archivedAt)
            )
          )

        const existing = existingRows[0]
        if (!existing) {
          throw notFound('Rule not found')
        }

        const updated = await db.transaction(async (tx) => {
          const updatedRows = await tx
            .update(communityRules)
            .set({
              title,
              description,
              updatedAt: new Date(),
            })
            .where(eq(communityRules.id, ruleId))
            .returning()

          // Create new version snapshot
          await tx.insert(communityRuleVersions).values({
            ruleId,
            title,
            description,
          })

          return updatedRows[0]
        })

        if (!updated) {
          throw notFound('Rule not found')
        }

        app.log.info({ ruleId, communityDid }, 'Community rule updated (new version created)')

        return reply.status(200).send(serializeRule(updated))
      }
    )

    // -------------------------------------------------------------------
    // DELETE /api/communities/:did/rules/:id (admin only, soft-delete)
    // -------------------------------------------------------------------
    app.delete(
      '/api/communities/:did/rules/:id',
      {
        preHandler: [requireAdmin],
        schema: {
          tags: ['Community Rules'],
          summary: 'Archive a community rule (soft-delete)',
          security: [{ bearerAuth: [] }],
          params: {
            type: 'object',
            required: ['did', 'id'],
            properties: {
              did: { type: 'string' },
              id: { type: 'string' },
            },
          },
          response: {
            200: {
              type: 'object',
              properties: {
                success: { type: 'boolean' as const },
              },
            },
            401: errorResponseSchema,
            403: errorResponseSchema,
            404: errorResponseSchema,
          },
        },
      },
      async (request, reply) => {
        const communityDid = requireCommunityDid(request)
        const { id: idStr } = request.params as { id: string }
        const ruleId = parseInt(idStr, 10)
        if (Number.isNaN(ruleId)) {
          throw badRequest('Invalid rule ID')
        }

        // Verify rule exists and is not already archived
        const existingRows = await db
          .select()
          .from(communityRules)
          .where(
            and(
              eq(communityRules.id, ruleId),
              eq(communityRules.communityDid, communityDid),
              isNull(communityRules.archivedAt)
            )
          )

        if (!existingRows[0]) {
          throw notFound('Rule not found')
        }

        await db
          .update(communityRules)
          .set({ archivedAt: new Date() })
          .where(eq(communityRules.id, ruleId))

        app.log.info({ ruleId, communityDid }, 'Community rule archived')

        return reply.status(200).send({ success: true })
      }
    )

    // -------------------------------------------------------------------
    // PUT /api/communities/:did/rules/reorder (admin only)
    // -------------------------------------------------------------------
    app.put(
      '/api/communities/:did/rules/reorder',
      {
        preHandler: [requireAdmin],
        schema: {
          tags: ['Community Rules'],
          summary: 'Reorder community rules',
          security: [{ bearerAuth: [] }],
          params: {
            type: 'object',
            required: ['did'],
            properties: { did: { type: 'string' } },
          },
          body: {
            type: 'object',
            required: ['order'],
            properties: {
              order: {
                type: 'array',
                items: {
                  type: 'object',
                  required: ['id', 'displayOrder'],
                  properties: {
                    id: { type: 'number' },
                    displayOrder: { type: 'number' },
                  },
                },
              },
            },
          },
          response: {
            200: {
              type: 'object',
              properties: {
                success: { type: 'boolean' as const },
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
        const parsed = reorderRulesSchema.safeParse(request.body)
        if (!parsed.success) {
          throw badRequest('Invalid input: order array is required')
        }

        const { order } = parsed.data

        await db.transaction(async (tx) => {
          for (const item of order) {
            await tx
              .update(communityRules)
              .set({ displayOrder: item.displayOrder })
              .where(
                and(eq(communityRules.id, item.id), eq(communityRules.communityDid, communityDid))
              )
          }
        })

        app.log.info({ communityDid, ruleCount: order.length }, 'Community rules reordered')

        return reply.status(200).send({ success: true })
      }
    )

    // -------------------------------------------------------------------
    // GET /api/communities/:did/rules/:id/versions (admin only)
    // -------------------------------------------------------------------
    app.get(
      '/api/communities/:did/rules/:id/versions',
      {
        preHandler: [requireAdmin],
        schema: {
          tags: ['Community Rules'],
          summary: 'Get version history for a community rule',
          security: [{ bearerAuth: [] }],
          params: {
            type: 'object',
            required: ['did', 'id'],
            properties: {
              did: { type: 'string' },
              id: { type: 'string' },
            },
          },
          querystring: {
            type: 'object',
            properties: {
              cursor: { type: 'string' },
              limit: { type: 'number', default: 25 },
            },
          },
          response: {
            200: {
              type: 'object',
              properties: {
                data: {
                  type: 'array',
                  items: ruleVersionJsonSchema,
                },
                cursor: { type: ['string', 'null'] as const },
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
        const { id: idStr } = request.params as { id: string }
        const ruleId = parseInt(idStr, 10)
        if (Number.isNaN(ruleId)) {
          throw badRequest('Invalid rule ID')
        }

        const queryParsed = ruleVersionsQuerySchema.safeParse(request.query)
        if (!queryParsed.success) {
          throw badRequest('Invalid query parameters')
        }
        const { cursor, limit } = queryParsed.data

        // Verify rule exists and belongs to this community
        const ruleRows = await db
          .select()
          .from(communityRules)
          .where(and(eq(communityRules.id, ruleId), eq(communityRules.communityDid, communityDid)))

        if (!ruleRows[0]) {
          throw notFound('Rule not found')
        }

        const conditions = [eq(communityRuleVersions.ruleId, ruleId)]
        if (cursor) {
          const decoded = decodeCursor(cursor)
          if (decoded) {
            conditions.push(
              sql`(${communityRuleVersions.createdAt}, ${communityRuleVersions.id}) < (${decoded.createdAt}::timestamptz, ${decoded.id})`
            )
          }
        }

        const fetchLimit = limit + 1
        const rows = await db
          .select()
          .from(communityRuleVersions)
          .where(and(...conditions))
          .orderBy(desc(communityRuleVersions.createdAt))
          .limit(fetchLimit)

        const hasMore = rows.length > limit
        const data = rows.slice(0, limit)
        const lastItem = data[data.length - 1]
        const nextCursor =
          hasMore && lastItem ? encodeCursor(lastItem.createdAt.toISOString(), lastItem.id) : null

        return reply.status(200).send({
          data: data.map(serializeRuleVersion),
          cursor: nextCursor,
        })
      }
    )

    done()
  }
}
