import type { FastifyPluginCallback } from 'fastify'
import { eq } from 'drizzle-orm'
import sharp from 'sharp'
import { badRequest, errorResponseSchema } from '../lib/api-errors.js'
import { requireCommunityDid } from '../middleware/community-resolver.js'
import { communitySettings } from '../db/schema/community-settings.js'

const ALLOWED_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif'])

const LOGO_SIZE = { width: 512, height: 512 }
const FAVICON_SIZE = { width: 256, height: 256 }

// ---------------------------------------------------------------------------
// OpenAPI JSON Schema definitions
// ---------------------------------------------------------------------------

const uploadResponseJsonSchema = {
  type: 'object' as const,
  properties: {
    url: { type: 'string' as const },
  },
}

// ---------------------------------------------------------------------------
// Admin design routes plugin
// ---------------------------------------------------------------------------

/**
 * Logo and favicon upload endpoints for community design.
 *
 * - POST /api/admin/design/logo    -- Upload community logo
 * - POST /api/admin/design/favicon -- Upload community favicon
 */
export function adminDesignRoutes(): FastifyPluginCallback {
  return (app, _opts, done) => {
    const { db, storage, env } = app
    const requireAdmin = app.requireAdmin
    const maxSize = env.UPLOAD_MAX_SIZE_BYTES

    // -----------------------------------------------------------------
    // POST /api/admin/design/logo
    // -----------------------------------------------------------------

    app.post(
      '/api/admin/design/logo',
      {
        preHandler: [requireAdmin],
        schema: {
          tags: ['Admin', 'Design'],
          summary: 'Upload community logo',
          security: [{ bearerAuth: [] }],
          consumes: ['multipart/form-data'],
          response: {
            200: uploadResponseJsonSchema,
            400: errorResponseSchema,
            401: errorResponseSchema,
            403: errorResponseSchema,
          },
        },
      },
      async (request, reply) => {
        const communityDid = requireCommunityDid(request)

        const file = await request.file()
        if (!file) throw badRequest('No file uploaded')
        if (!ALLOWED_MIMES.has(file.mimetype)) {
          throw badRequest('File must be JPEG, PNG, WebP, or GIF')
        }

        const buffer = await file.toBuffer()
        if (buffer.length > maxSize) {
          throw badRequest(`File too large (max ${String(Math.round(maxSize / 1024 / 1024))}MB)`)
        }

        const processed = await sharp(buffer)
          .resize(LOGO_SIZE.width, LOGO_SIZE.height, { fit: 'cover' })
          .webp({ quality: 85 })
          .toBuffer()

        const url = await storage.store(processed, 'image/webp', 'logos')

        await db
          .update(communitySettings)
          .set({ communityLogoUrl: url, updatedAt: new Date() })
          .where(eq(communitySettings.communityDid, communityDid))

        return reply.status(200).send({ url })
      }
    )

    // -----------------------------------------------------------------
    // POST /api/admin/design/favicon
    // -----------------------------------------------------------------

    app.post(
      '/api/admin/design/favicon',
      {
        preHandler: [requireAdmin],
        schema: {
          tags: ['Admin', 'Design'],
          summary: 'Upload community favicon',
          security: [{ bearerAuth: [] }],
          consumes: ['multipart/form-data'],
          response: {
            200: uploadResponseJsonSchema,
            400: errorResponseSchema,
            401: errorResponseSchema,
            403: errorResponseSchema,
          },
        },
      },
      async (request, reply) => {
        const communityDid = requireCommunityDid(request)

        const file = await request.file()
        if (!file) throw badRequest('No file uploaded')
        if (!ALLOWED_MIMES.has(file.mimetype)) {
          throw badRequest('File must be JPEG, PNG, WebP, or GIF')
        }

        const buffer = await file.toBuffer()
        if (buffer.length > maxSize) {
          throw badRequest(`File too large (max ${String(Math.round(maxSize / 1024 / 1024))}MB)`)
        }

        const processed = await sharp(buffer)
          .resize(FAVICON_SIZE.width, FAVICON_SIZE.height, { fit: 'cover' })
          .webp({ quality: 90 })
          .toBuffer()

        const url = await storage.store(processed, 'image/webp', 'favicons')

        await db
          .update(communitySettings)
          .set({ faviconUrl: url, updatedAt: new Date() })
          .where(eq(communitySettings.communityDid, communityDid))

        return reply.status(200).send({ url })
      }
    )

    done()
  }
}
