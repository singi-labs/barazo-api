import { eq, and, asc } from 'drizzle-orm'
import { requireCommunityDid } from '../middleware/community-resolver.js'
import type { FastifyPluginCallback } from 'fastify'
import { notFound, badRequest, forbidden, errorResponseSchema } from '../lib/api-errors.js'
import {
  createOnboardingFieldSchema,
  updateOnboardingFieldSchema,
  reorderFieldsSchema,
  submitOnboardingSchema,
  validateFieldResponse,
} from '../validation/onboarding.js'

import {
  communityOnboardingFields,
  userOnboardingResponses,
} from '../db/schema/onboarding-fields.js'
import { userPreferences } from '../db/schema/user-preferences.js'
import { users } from '../db/schema/users.js'
import { ageDeclarationSchema } from '../validation/profiles.js'

// ---------------------------------------------------------------------------
// OpenAPI JSON Schema definitions
// ---------------------------------------------------------------------------

const onboardingFieldJsonSchema = {
  type: 'object' as const,
  properties: {
    id: { type: 'string' as const },
    communityDid: { type: 'string' as const },
    fieldType: { type: 'string' as const },
    label: { type: 'string' as const },
    description: { type: ['string', 'null'] as const },
    isMandatory: { type: 'boolean' as const },
    sortOrder: { type: 'integer' as const },
    config: { type: ['object', 'null'] as const },
    createdAt: { type: 'string' as const, format: 'date-time' as const },
    updatedAt: { type: 'string' as const, format: 'date-time' as const },
  },
}

const onboardingStatusJsonSchema = {
  type: 'object' as const,
  properties: {
    complete: { type: 'boolean' as const },
    fields: {
      type: 'array' as const,
      items: {
        type: 'object' as const,
        properties: {
          ...onboardingFieldJsonSchema.properties,
          completed: { type: 'boolean' as const },
          response: {},
        },
      },
    },
  },
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SYSTEM_AGE_FIELD_ID = 'system-age-confirmation'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function serializeField(row: typeof communityOnboardingFields.$inferSelect) {
  return {
    id: row.id,
    communityDid: row.communityDid,
    fieldType: row.fieldType,
    label: row.label,
    description: row.description ?? null,
    isMandatory: row.isMandatory,
    sortOrder: row.sortOrder,
    config: row.config ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

// ---------------------------------------------------------------------------
// Routes plugin
// ---------------------------------------------------------------------------

export function onboardingRoutes(): FastifyPluginCallback {
  return (app, _opts, done) => {
    const { db, authMiddleware } = app
    const requireAdmin = app.requireAdmin

    // =====================================================================
    // ADMIN ENDPOINTS
    // =====================================================================

    // -------------------------------------------------------------------
    // GET /api/admin/onboarding-fields
    // -------------------------------------------------------------------

    app.get(
      '/api/admin/onboarding-fields',
      {
        preHandler: [requireAdmin],
        schema: {
          tags: ['Admin'],
          summary: 'List onboarding fields for this community',
          security: [{ bearerAuth: [] }],
          response: {
            200: {
              type: 'array' as const,
              items: onboardingFieldJsonSchema,
            },
            401: errorResponseSchema,
            403: errorResponseSchema,
          },
        },
      },
      async (request, reply) => {
        const communityDid = requireCommunityDid(request)

        const fields = await db
          .select()
          .from(communityOnboardingFields)
          .where(eq(communityOnboardingFields.communityDid, communityDid))
          .orderBy(asc(communityOnboardingFields.sortOrder))

        return reply.status(200).send(fields.map(serializeField))
      }
    )

    // -------------------------------------------------------------------
    // POST /api/admin/onboarding-fields
    // -------------------------------------------------------------------

    app.post(
      '/api/admin/onboarding-fields',
      {
        preHandler: [requireAdmin],
        schema: {
          tags: ['Admin'],
          summary: 'Create a new onboarding field',
          security: [{ bearerAuth: [] }],
          body: {
            type: 'object' as const,
            properties: {
              fieldType: { type: 'string' as const },
              label: { type: 'string' as const },
              description: { type: ['string', 'null'] as const },
              isMandatory: { type: 'boolean' as const },
              sortOrder: { type: 'integer' as const },
              config: { type: ['object', 'null'] as const },
            },
            required: ['fieldType', 'label'],
          },
          response: {
            201: onboardingFieldJsonSchema,
            400: errorResponseSchema,
            401: errorResponseSchema,
            403: errorResponseSchema,
          },
        },
      },
      async (request, reply) => {
        const parsed = createOnboardingFieldSchema.safeParse(request.body)
        if (!parsed.success) {
          throw badRequest('Invalid onboarding field data')
        }

        const communityDid = requireCommunityDid(request)

        const inserted = await db
          .insert(communityOnboardingFields)
          .values({
            communityDid,
            fieldType: parsed.data.fieldType,
            label: parsed.data.label,
            description: parsed.data.description ?? null,
            isMandatory: parsed.data.isMandatory,
            sortOrder: parsed.data.sortOrder,
            config: parsed.data.config ?? null,
          })
          .returning()

        const row = inserted[0]
        if (!row) {
          throw badRequest('Failed to create onboarding field')
        }

        app.log.info(
          { event: 'onboarding_field_created', fieldId: row.id, fieldType: row.fieldType },
          'Onboarding field created'
        )

        return reply.status(201).send(serializeField(row))
      }
    )

    // -------------------------------------------------------------------
    // PUT /api/admin/onboarding-fields/:id
    // -------------------------------------------------------------------

    app.put<{ Params: { id: string } }>(
      '/api/admin/onboarding-fields/:id',
      {
        preHandler: [requireAdmin],
        schema: {
          tags: ['Admin'],
          summary: 'Update an onboarding field',
          security: [{ bearerAuth: [] }],
          params: {
            type: 'object' as const,
            properties: { id: { type: 'string' as const } },
            required: ['id'],
          },
          body: {
            type: 'object' as const,
            properties: {
              label: { type: 'string' as const },
              description: { type: ['string', 'null'] as const },
              isMandatory: { type: 'boolean' as const },
              sortOrder: { type: 'integer' as const },
              config: { type: ['object', 'null'] as const },
            },
          },
          response: {
            200: onboardingFieldJsonSchema,
            400: errorResponseSchema,
            401: errorResponseSchema,
            403: errorResponseSchema,
            404: errorResponseSchema,
          },
        },
      },
      async (request, reply) => {
        const parsed = updateOnboardingFieldSchema.safeParse(request.body)
        if (!parsed.success) {
          throw badRequest('Invalid update data')
        }

        const updates = parsed.data
        if (
          updates.label === undefined &&
          updates.description === undefined &&
          updates.isMandatory === undefined &&
          updates.sortOrder === undefined &&
          updates.config === undefined
        ) {
          throw badRequest('At least one field must be provided')
        }

        const communityDid = requireCommunityDid(request)

        const dbUpdates: Record<string, unknown> = { updatedAt: new Date() }
        if (updates.label !== undefined) dbUpdates.label = updates.label
        if (updates.description !== undefined) dbUpdates.description = updates.description
        if (updates.isMandatory !== undefined) dbUpdates.isMandatory = updates.isMandatory
        if (updates.sortOrder !== undefined) dbUpdates.sortOrder = updates.sortOrder
        if (updates.config !== undefined) dbUpdates.config = updates.config

        const updated = await db
          .update(communityOnboardingFields)
          .set(dbUpdates)
          .where(
            and(
              eq(communityOnboardingFields.id, request.params.id),
              eq(communityOnboardingFields.communityDid, communityDid)
            )
          )
          .returning()

        const row = updated[0]
        if (!row) {
          throw notFound('Onboarding field not found')
        }

        return reply.status(200).send(serializeField(row))
      }
    )

    // -------------------------------------------------------------------
    // DELETE /api/admin/onboarding-fields/:id
    // -------------------------------------------------------------------

    app.delete<{ Params: { id: string } }>(
      '/api/admin/onboarding-fields/:id',
      {
        preHandler: [requireAdmin],
        schema: {
          tags: ['Admin'],
          summary: 'Delete an onboarding field',
          security: [{ bearerAuth: [] }],
          params: {
            type: 'object' as const,
            properties: { id: { type: 'string' as const } },
            required: ['id'],
          },
          response: {
            200: {
              type: 'object' as const,
              properties: { success: { type: 'boolean' as const } },
            },
            401: errorResponseSchema,
            403: errorResponseSchema,
            404: errorResponseSchema,
          },
        },
      },
      async (request, reply) => {
        const communityDid = requireCommunityDid(request)

        const deleted = await db
          .delete(communityOnboardingFields)
          .where(
            and(
              eq(communityOnboardingFields.id, request.params.id),
              eq(communityOnboardingFields.communityDid, communityDid)
            )
          )
          .returning()

        if (deleted.length === 0) {
          throw notFound('Onboarding field not found')
        }

        // Also clean up user responses for this field
        await db
          .delete(userOnboardingResponses)
          .where(eq(userOnboardingResponses.fieldId, request.params.id))

        app.log.info(
          { event: 'onboarding_field_deleted', fieldId: request.params.id },
          'Onboarding field deleted'
        )

        return reply.status(200).send({ success: true })
      }
    )

    // -------------------------------------------------------------------
    // PUT /api/admin/onboarding-fields/reorder
    // -------------------------------------------------------------------

    app.put(
      '/api/admin/onboarding-fields/reorder',
      {
        preHandler: [requireAdmin],
        schema: {
          tags: ['Admin'],
          summary: 'Reorder onboarding fields',
          security: [{ bearerAuth: [] }],
          body: {
            type: 'array' as const,
            items: {
              type: 'object' as const,
              properties: {
                id: { type: 'string' as const },
                sortOrder: { type: 'integer' as const },
              },
              required: ['id', 'sortOrder'],
            },
          },
          response: {
            200: {
              type: 'array' as const,
              items: onboardingFieldJsonSchema,
            },
            400: errorResponseSchema,
            401: errorResponseSchema,
            403: errorResponseSchema,
          },
        },
      },
      async (request, reply) => {
        const parsed = reorderFieldsSchema.safeParse(request.body)
        if (!parsed.success) {
          throw badRequest('Invalid reorder data')
        }

        const communityDid = requireCommunityDid(request)

        // Update each field's sort order
        for (const item of parsed.data) {
          await db
            .update(communityOnboardingFields)
            .set({ sortOrder: item.sortOrder, updatedAt: new Date() })
            .where(
              and(
                eq(communityOnboardingFields.id, item.id),
                eq(communityOnboardingFields.communityDid, communityDid)
              )
            )
        }

        // Return updated list
        const fields = await db
          .select()
          .from(communityOnboardingFields)
          .where(eq(communityOnboardingFields.communityDid, communityDid))
          .orderBy(asc(communityOnboardingFields.sortOrder))

        return reply.status(200).send(fields.map(serializeField))
      }
    )

    // =====================================================================
    // USER ENDPOINTS
    // =====================================================================

    // -------------------------------------------------------------------
    // GET /api/onboarding/status
    // -------------------------------------------------------------------

    app.get(
      '/api/onboarding/status',
      {
        preHandler: [authMiddleware.requireAuth],
        schema: {
          tags: ['Onboarding'],
          summary: 'Get onboarding status for the current community',
          security: [{ bearerAuth: [] }],
          response: {
            200: onboardingStatusJsonSchema,
            401: errorResponseSchema,
          },
        },
      },
      async (request, reply) => {
        const user = request.user
        if (!user) {
          throw forbidden('Authentication required')
        }

        const communityDid = requireCommunityDid(request)

        // Get all fields for this community
        const fields = await db
          .select()
          .from(communityOnboardingFields)
          .where(eq(communityOnboardingFields.communityDid, communityDid))
          .orderBy(asc(communityOnboardingFields.sortOrder))

        // Get user's responses
        const responses = await db
          .select()
          .from(userOnboardingResponses)
          .where(
            and(
              eq(userOnboardingResponses.did, user.did),
              eq(userOnboardingResponses.communityDid, communityDid)
            )
          )

        const responseMap = new Map(responses.map((r) => [r.fieldId, r.response]))

        // Check if we need to inject a system-level age_confirmation field
        const hasAdminAgeField = fields.some((f) => f.fieldType === 'age_confirmation')

        // Look up user's declared age
        const prefRows = await db
          .select({ declaredAge: userPreferences.declaredAge })
          .from(userPreferences)
          .where(eq(userPreferences.did, user.did))

        const declaredAge = prefRows[0]?.declaredAge ?? null
        const needsSystemAgeField = !hasAdminAgeField && declaredAge === null

        type FieldWithStatus = {
          id: string
          communityDid: string
          fieldType: string
          label: string
          description: string | null
          isMandatory: boolean
          sortOrder: number
          config: Record<string, unknown> | null
          createdAt: string
          updatedAt: string
          completed: boolean
          response: unknown
        }

        const fieldsWithStatus: FieldWithStatus[] = fields.map((field) => ({
          ...serializeField(field),
          completed: responseMap.has(field.id),
          response: responseMap.get(field.id) ?? null,
        }))

        // Inject system age field at the beginning if needed
        if (needsSystemAgeField) {
          const now = new Date().toISOString()
          fieldsWithStatus.unshift({
            id: SYSTEM_AGE_FIELD_ID,
            communityDid,
            fieldType: 'age_confirmation',
            label: 'Age Declaration',
            description:
              'Please select your age bracket. This determines which content is available to you.',
            isMandatory: true,
            sortOrder: -1,
            config: null,
            createdAt: now,
            updatedAt: now,
            completed: false,
            response: null,
          })
        }

        // Check completeness: all mandatory fields (including system age field) must be answered
        const mandatoryFieldsComplete = fields
          .filter((f) => f.isMandatory)
          .every((f) => responseMap.has(f.id))
        const complete = mandatoryFieldsComplete && !needsSystemAgeField

        return reply.status(200).send({
          complete,
          fields: fieldsWithStatus,
        })
      }
    )

    // -------------------------------------------------------------------
    // POST /api/onboarding/submit
    // -------------------------------------------------------------------

    app.post(
      '/api/onboarding/submit',
      {
        preHandler: [authMiddleware.requireAuth],
        schema: {
          tags: ['Onboarding'],
          summary: 'Submit onboarding responses',
          security: [{ bearerAuth: [] }],
          body: {
            type: 'array' as const,
            items: {
              type: 'object' as const,
              properties: {
                fieldId: { type: 'string' as const },
                response: {},
              },
              required: ['fieldId', 'response'],
            },
          },
          response: {
            200: {
              type: 'object' as const,
              properties: {
                success: { type: 'boolean' as const },
                complete: { type: 'boolean' as const },
              },
            },
            400: errorResponseSchema,
            401: errorResponseSchema,
          },
        },
      },
      async (request, reply) => {
        const user = request.user
        if (!user) {
          throw forbidden('Authentication required')
        }

        const parsed = submitOnboardingSchema.safeParse(request.body)
        if (!parsed.success) {
          throw badRequest('Invalid submission data')
        }

        const communityDid = requireCommunityDid(request)

        // Fetch all community fields to validate against
        const fields = await db
          .select()
          .from(communityOnboardingFields)
          .where(eq(communityOnboardingFields.communityDid, communityDid))

        const fieldMap = new Map(fields.map((f) => [f.id, f]))

        // Separate system-level age submissions from admin-configured ones
        const systemAgeSubmission = parsed.data.find((s) => s.fieldId === SYSTEM_AGE_FIELD_ID)
        const adminSubmissions = parsed.data.filter((s) => s.fieldId !== SYSTEM_AGE_FIELD_ID)

        // Validate admin-configured field responses
        const errors: string[] = []
        for (const submission of adminSubmissions) {
          const field = fieldMap.get(submission.fieldId)
          if (!field) {
            errors.push(`Unknown field: ${submission.fieldId}`)
            continue
          }

          const error = validateFieldResponse(field.fieldType, submission.response, field.config)
          if (error) {
            errors.push(`${field.label}: ${error}`)
          }
        }

        // Validate system age submission
        if (systemAgeSubmission) {
          const ageParsed = ageDeclarationSchema.safeParse({
            declaredAge: systemAgeSubmission.response,
          })
          if (!ageParsed.success) {
            errors.push('Age Declaration: must be one of 0, 13, 14, 15, 16, 18')
          }
        }

        // Also validate admin-configured age_confirmation fields the same way
        for (const submission of adminSubmissions) {
          const field = fieldMap.get(submission.fieldId)
          if (field?.fieldType === 'age_confirmation') {
            const ageParsed = ageDeclarationSchema.safeParse({
              declaredAge: submission.response,
            })
            if (!ageParsed.success) {
              errors.push(`${field.label}: must be one of 0, 13, 14, 15, 16, 18`)
            }
          }
        }

        if (errors.length > 0) {
          throw badRequest(errors.join('; '))
        }

        // Upsert admin-field responses (idempotent)
        for (const submission of adminSubmissions) {
          await db
            .insert(userOnboardingResponses)
            .values({
              did: user.did,
              communityDid,
              fieldId: submission.fieldId,
              response: submission.response,
            })
            .onConflictDoUpdate({
              target: [
                userOnboardingResponses.did,
                userOnboardingResponses.communityDid,
                userOnboardingResponses.fieldId,
              ],
              set: {
                response: submission.response,
                completedAt: new Date(),
              },
            })

          // Sync age_confirmation to user preferences
          const field = fieldMap.get(submission.fieldId)
          if (field?.fieldType === 'age_confirmation' && typeof submission.response === 'number') {
            const now = new Date()
            await db
              .insert(userPreferences)
              .values({ did: user.did, declaredAge: submission.response, updatedAt: now })
              .onConflictDoUpdate({
                target: userPreferences.did,
                set: { declaredAge: submission.response, updatedAt: now },
              })
            await db
              .update(users)
              .set({ declaredAge: submission.response })
              .where(eq(users.did, user.did))
          }
        }

        // Handle system-level age submission (syncs to user_preferences + users)
        if (systemAgeSubmission && typeof systemAgeSubmission.response === 'number') {
          const declaredAge = systemAgeSubmission.response
          const now = new Date()

          await db
            .insert(userPreferences)
            .values({ did: user.did, declaredAge, updatedAt: now })
            .onConflictDoUpdate({
              target: userPreferences.did,
              set: { declaredAge, updatedAt: now },
            })

          await db.update(users).set({ declaredAge }).where(eq(users.did, user.did))
        }

        // Check completeness (all mandatory fields answered?)
        const existingResponses = await db
          .select()
          .from(userOnboardingResponses)
          .where(
            and(
              eq(userOnboardingResponses.did, user.did),
              eq(userOnboardingResponses.communityDid, communityDid)
            )
          )

        const answeredFieldIds = new Set(existingResponses.map((r) => r.fieldId))
        const adminFieldsComplete = fields
          .filter((f) => f.isMandatory)
          .every((f) => answeredFieldIds.has(f.id))

        // System age field counts as complete if user now has a declaredAge
        const systemAgeComplete = systemAgeSubmission
          ? typeof systemAgeSubmission.response === 'number'
          : true
        const complete = adminFieldsComplete && systemAgeComplete

        app.log.info(
          {
            event: 'onboarding_submitted',
            did: user.did,
            fieldCount: parsed.data.length,
            complete,
          },
          'Onboarding responses submitted'
        )

        return reply.status(200).send({ success: true, complete })
      }
    )

    done()
  }
}
