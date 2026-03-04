import { eq, sql } from 'drizzle-orm'
import { requireCommunityDid } from '../middleware/community-resolver.js'
import type { FastifyPluginCallback } from 'fastify'
import { notFound, badRequest, errorResponseSchema } from '../lib/api-errors.js'
import { isMaturityLowerThan } from '../lib/maturity.js'
import { updateSettingsSchema } from '../validation/admin-settings.js'
import { communitySettings } from '../db/schema/community-settings.js'
import { categories } from '../db/schema/categories.js'

// ---------------------------------------------------------------------------
// OpenAPI JSON Schema definitions
// ---------------------------------------------------------------------------

const settingsJsonSchema = {
  type: 'object' as const,
  properties: {
    initialized: { type: 'boolean' as const },
    communityDid: { type: 'string' as const },
    adminDid: { type: ['string', 'null'] as const },
    communityName: { type: 'string' as const },
    maturityRating: { type: 'string' as const, enum: ['safe', 'mature', 'adult'] },
    reactionSet: { type: 'array' as const, items: { type: 'string' as const } },
    communityDescription: { type: ['string', 'null'] as const },
    communityLogoUrl: { type: ['string', 'null'] as const },
    faviconUrl: { type: ['string', 'null'] as const },
    primaryColor: { type: ['string', 'null'] as const },
    accentColor: { type: ['string', 'null'] as const },
    jurisdictionCountry: { type: ['string', 'null'] as const },
    ageThreshold: { type: 'integer' as const },
    maxReplyDepth: { type: 'integer' as const },
    requireLoginForMature: { type: 'boolean' as const },
    createdAt: { type: 'string' as const, format: 'date-time' as const },
    updatedAt: { type: 'string' as const, format: 'date-time' as const },
  },
}

const conflictJsonSchema = {
  type: 'object' as const,
  properties: {
    error: { type: 'string' as const },
    message: { type: 'string' as const },
    statusCode: { type: 'integer' as const },
    details: {
      type: 'object' as const,
      properties: {
        categories: {
          type: 'array' as const,
          items: {
            type: 'object' as const,
            properties: {
              id: { type: 'string' as const },
              slug: { type: 'string' as const },
              name: { type: 'string' as const },
              maturityRating: { type: 'string' as const },
            },
          },
        },
      },
    },
  },
}

const statsJsonSchema = {
  type: 'object' as const,
  properties: {
    topicCount: { type: 'integer' as const },
    replyCount: { type: 'integer' as const },
    userCount: { type: 'integer' as const },
    categoryCount: { type: 'integer' as const },
    reportCount: { type: 'integer' as const },
    recentTopics: { type: 'integer' as const },
    recentReplies: { type: 'integer' as const },
    recentUsers: { type: 'integer' as const },
  },
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function serializeSettings(row: typeof communitySettings.$inferSelect) {
  return {
    initialized: row.initialized,
    communityDid: row.communityDid,
    adminDid: row.adminDid ?? null,
    communityName: row.communityName,
    maturityRating: row.maturityRating,
    reactionSet: row.reactionSet,
    communityDescription: row.communityDescription ?? null,
    communityLogoUrl: row.communityLogoUrl ?? null,
    faviconUrl: row.faviconUrl ?? null,
    primaryColor: row.primaryColor ?? null,
    accentColor: row.accentColor ?? null,
    jurisdictionCountry: row.jurisdictionCountry ?? null,
    ageThreshold: row.ageThreshold,
    maxReplyDepth: row.maxReplyDepth,
    requireLoginForMature: row.requireLoginForMature,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

// ---------------------------------------------------------------------------
// Admin settings routes plugin
// ---------------------------------------------------------------------------

/**
 * Admin settings routes for the Barazo forum.
 *
 * - GET  /api/admin/settings  -- Get community settings
 * - PUT  /api/admin/settings  -- Update community settings
 * - GET  /api/admin/stats     -- Get community statistics
 */
export function adminSettingsRoutes(): FastifyPluginCallback {
  return (app, _opts, done) => {
    const { db } = app
    const requireAdmin = app.requireAdmin

    // -------------------------------------------------------------------
    // GET /api/settings/public (no auth, public community info)
    // -------------------------------------------------------------------

    app.get(
      '/api/settings/public',
      {
        schema: {
          tags: ['Settings'],
          summary: 'Get public community settings (no auth required)',
          response: {
            200: {
              type: 'object' as const,
              properties: {
                communityDid: { type: ['string', 'null'] as const },
                communityName: { type: 'string' as const },
                maturityRating: { type: 'string' as const, enum: ['safe', 'mature', 'adult'] },
                communityDescription: { type: ['string', 'null'] as const },
                communityLogoUrl: { type: ['string', 'null'] as const },
                faviconUrl: { type: ['string', 'null'] as const },
                maxReplyDepth: { type: 'integer' as const },
              },
            },
            404: errorResponseSchema,
          },
        },
      },
      async (request, reply) => {
        const communityDid = requireCommunityDid(request)
        const rows = await db
          .select()
          .from(communitySettings)
          .where(eq(communitySettings.communityDid, communityDid))

        const row = rows[0]
        if (!row) {
          throw notFound('Community settings not found')
        }

        return reply.status(200).send({
          communityDid: row.communityDid,
          communityName: row.communityName,
          maturityRating: row.maturityRating,
          communityDescription: row.communityDescription ?? null,
          communityLogoUrl: row.communityLogoUrl ?? null,
          faviconUrl: row.faviconUrl ?? null,
          maxReplyDepth: row.maxReplyDepth,
        })
      }
    )

    // -------------------------------------------------------------------
    // GET /api/admin/settings (admin only)
    // -------------------------------------------------------------------

    app.get(
      '/api/admin/settings',
      {
        preHandler: [requireAdmin],
        schema: {
          tags: ['Admin'],
          summary: 'Get community settings',
          security: [{ bearerAuth: [] }],
          response: {
            200: settingsJsonSchema,
            401: errorResponseSchema,
            403: errorResponseSchema,
            404: errorResponseSchema,
          },
        },
      },
      async (request, reply) => {
        const communityDid = requireCommunityDid(request)
        const rows = await db
          .select()
          .from(communitySettings)
          .where(eq(communitySettings.communityDid, communityDid))

        const row = rows[0]
        if (!row) {
          throw notFound('Community settings not found')
        }

        return reply.status(200).send(serializeSettings(row))
      }
    )

    // -------------------------------------------------------------------
    // PUT /api/admin/settings (admin only)
    // -------------------------------------------------------------------

    app.put(
      '/api/admin/settings',
      {
        preHandler: [requireAdmin],
        schema: {
          tags: ['Admin'],
          summary: 'Update community settings',
          security: [{ bearerAuth: [] }],
          body: {
            type: 'object',
            properties: {
              communityName: { type: 'string', minLength: 1, maxLength: 100 },
              maturityRating: { type: 'string', enum: ['safe', 'mature', 'adult'] },
              reactionSet: {
                type: 'array',
                items: { type: 'string', minLength: 1, maxLength: 30 },
                minItems: 1,
              },
              communityDescription: { type: ['string', 'null'], maxLength: 500 },
              communityLogoUrl: { type: ['string', 'null'], format: 'uri' },
              faviconUrl: { type: ['string', 'null'], format: 'uri' },
              primaryColor: {
                type: ['string', 'null'],
                pattern: '^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$',
              },
              accentColor: {
                type: ['string', 'null'],
                pattern: '^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$',
              },
              jurisdictionCountry: { type: ['string', 'null'] },
              ageThreshold: { type: 'integer', minimum: 13, maximum: 18 },
              maxReplyDepth: { type: 'integer', minimum: 1, maximum: 9999 },
              requireLoginForMature: { type: 'boolean' },
            },
          },
          response: {
            200: settingsJsonSchema,
            400: errorResponseSchema,
            401: errorResponseSchema,
            403: errorResponseSchema,
            404: errorResponseSchema,
            409: conflictJsonSchema,
          },
        },
      },
      async (request, reply) => {
        const communityDid = requireCommunityDid(request)
        const parsed = updateSettingsSchema.safeParse(request.body)
        if (!parsed.success) {
          throw badRequest('Invalid settings data')
        }

        const updates = parsed.data

        // Require at least one field to update
        if (
          updates.communityName === undefined &&
          updates.maturityRating === undefined &&
          updates.reactionSet === undefined &&
          updates.communityDescription === undefined &&
          updates.communityLogoUrl === undefined &&
          updates.faviconUrl === undefined &&
          updates.primaryColor === undefined &&
          updates.accentColor === undefined &&
          updates.jurisdictionCountry === undefined &&
          updates.ageThreshold === undefined &&
          updates.maxReplyDepth === undefined &&
          updates.requireLoginForMature === undefined
        ) {
          throw badRequest('At least one field must be provided')
        }

        // Fetch current settings
        const rows = await db
          .select()
          .from(communitySettings)
          .where(eq(communitySettings.communityDid, communityDid))

        const current = rows[0]
        if (!current) {
          throw notFound('Community settings not found')
        }

        // If the community maturity floor is being raised, check for incompatible
        // categories. Lowering the floor (relaxing constraints) is always allowed
        // because existing categories remain above the new, lower threshold.
        if (
          updates.maturityRating !== undefined &&
          updates.maturityRating !== current.maturityRating
        ) {
          const newRating = updates.maturityRating
          const currentRating = current.maturityRating

          if (isMaturityLowerThan(currentRating, newRating)) {
            // Raising maturity: find categories below the new threshold
            const settingsCommunityDid = current.communityDid
            const allCategories = await db
              .select()
              .from(categories)
              .where(eq(categories.communityDid, settingsCommunityDid))

            // Filter in application code since maturity comparison is enum-based
            const belowThreshold = allCategories.filter((cat) =>
              isMaturityLowerThan(cat.maturityRating, newRating)
            )

            if (belowThreshold.length > 0) {
              return reply.status(409).send({
                error: 'Conflict',
                message: `Cannot raise community maturity to "${newRating}": ${String(belowThreshold.length)} categories have a lower maturity rating. Update these categories first.`,
                statusCode: 409,
                details: {
                  categories: belowThreshold.map((cat) => ({
                    id: cat.id,
                    slug: cat.slug,
                    name: cat.name,
                    maturityRating: cat.maturityRating,
                  })),
                },
              })
            }
          }
        }

        // Build update set
        const dbUpdates: Record<string, unknown> = {
          updatedAt: new Date(),
        }
        if (updates.communityName !== undefined) {
          dbUpdates.communityName = updates.communityName
        }
        if (updates.maturityRating !== undefined) {
          dbUpdates.maturityRating = updates.maturityRating
        }
        if (updates.reactionSet !== undefined) {
          dbUpdates.reactionSet = updates.reactionSet
        }
        if (updates.communityDescription !== undefined) {
          dbUpdates.communityDescription = updates.communityDescription
        }
        if (updates.communityLogoUrl !== undefined) {
          dbUpdates.communityLogoUrl = updates.communityLogoUrl
        }
        if (updates.faviconUrl !== undefined) {
          dbUpdates.faviconUrl = updates.faviconUrl
        }
        if (updates.primaryColor !== undefined) {
          dbUpdates.primaryColor = updates.primaryColor
        }
        if (updates.accentColor !== undefined) {
          dbUpdates.accentColor = updates.accentColor
        }
        if (updates.jurisdictionCountry !== undefined) {
          dbUpdates.jurisdictionCountry = updates.jurisdictionCountry
        }
        if (updates.ageThreshold !== undefined) {
          dbUpdates.ageThreshold = updates.ageThreshold
        }
        if (updates.maxReplyDepth !== undefined) {
          dbUpdates.maxReplyDepth = updates.maxReplyDepth
        }
        if (updates.requireLoginForMature !== undefined) {
          dbUpdates.requireLoginForMature = updates.requireLoginForMature
        }

        const updated = await db
          .update(communitySettings)
          .set(dbUpdates)
          .where(eq(communitySettings.communityDid, communityDid))
          .returning()

        const updatedRow = updated[0]
        if (!updatedRow) {
          throw notFound('Community settings not found after update')
        }

        // TODO: Write to admin_audit_log table when implemented (standards/backend.md audit logging) (#38)
        app.log.info(
          {
            event: 'settings_updated',
            did: request.user?.did,
            changes: Object.keys(parsed.data),
          },
          'Community settings updated'
        )

        return reply.status(200).send(serializeSettings(updatedRow))
      }
    )

    // -------------------------------------------------------------------
    // GET /api/admin/stats (admin only)
    // -------------------------------------------------------------------

    app.get(
      '/api/admin/stats',
      {
        preHandler: [requireAdmin],
        schema: {
          tags: ['Admin'],
          summary: 'Get community statistics',
          security: [{ bearerAuth: [] }],
          response: {
            200: statsJsonSchema,
            401: errorResponseSchema,
            403: errorResponseSchema,
          },
        },
      },
      async (_request, reply) => {
        const result = await db.execute(sql`
        SELECT
          (SELECT COUNT(*) FROM topics WHERE is_mod_deleted = false AND is_author_deleted = false) AS topic_count,
          (SELECT COUNT(*) FROM replies WHERE is_author_deleted = false AND is_mod_deleted = false) AS reply_count,
          (SELECT COUNT(*) FROM users) AS user_count,
          (SELECT COUNT(*) FROM categories) AS category_count,
          (SELECT COUNT(*) FROM reports WHERE status = 'pending') AS report_count,
          (SELECT COUNT(*) FROM topics WHERE is_mod_deleted = false AND is_author_deleted = false AND created_at > NOW() - INTERVAL '7 days') AS recent_topics,
          (SELECT COUNT(*) FROM replies WHERE is_author_deleted = false AND is_mod_deleted = false AND created_at > NOW() - INTERVAL '7 days') AS recent_replies,
          (SELECT COUNT(*) FROM users WHERE first_seen_at > NOW() - INTERVAL '7 days') AS recent_users
      `)

        interface StatsRow {
          topic_count: string
          reply_count: string
          user_count: string
          category_count: string
          report_count: string
          recent_topics: string
          recent_replies: string
          recent_users: string
        }

        // Drizzle execute() returns untyped rows — cast to expected shape
        const rows = result as unknown as StatsRow[]
        const row = rows[0]
        if (!row) {
          // Should never happen -- subquery always returns one row
          return reply.status(200).send({
            topicCount: 0,
            replyCount: 0,
            userCount: 0,
            categoryCount: 0,
            reportCount: 0,
            recentTopics: 0,
            recentReplies: 0,
            recentUsers: 0,
          })
        }

        return reply.status(200).send({
          topicCount: Number(row.topic_count),
          replyCount: Number(row.reply_count),
          userCount: Number(row.user_count),
          categoryCount: Number(row.category_count),
          reportCount: Number(row.report_count),
          recentTopics: Number(row.recent_topics),
          recentReplies: Number(row.recent_replies),
          recentUsers: Number(row.recent_users),
        })
      }
    )

    done()
  }
}
