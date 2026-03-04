import Fastify from 'fastify'
import helmet from '@fastify/helmet'
import cors from '@fastify/cors'
import cookie from '@fastify/cookie'
import multipart from '@fastify/multipart'
import rateLimit from '@fastify/rate-limit'
import swagger from '@fastify/swagger'
import scalarApiReference from '@scalar/fastify-api-reference'
import * as Sentry from '@sentry/node'
import type { FastifyError } from 'fastify'
import type { NodeOAuthClient } from '@atproto/oauth-client-node'
import { sql } from 'drizzle-orm'
import type { Env } from './config/env.js'
import { getCommunityDid } from './config/env.js'
import { createSingleResolver, registerCommunityResolver } from './middleware/community-resolver.js'
import type { CommunityResolver } from './middleware/community-resolver.js'
import { createDb, runMigrations } from './db/index.js'
import { createCache } from './cache/index.js'
import { FirehoseService } from './firehose/service.js'
import { createOAuthClient } from './auth/oauth-client.js'
import { createSessionService } from './auth/session.js'
import type { SessionService } from './auth/session.js'
import { createAuthMiddleware } from './auth/middleware.js'
import type { AuthMiddleware, RequestUser } from './auth/middleware.js'
import { healthRoutes } from './routes/health.js'
import { oauthMetadataRoutes } from './routes/oauth-metadata.js'
import { authRoutes } from './routes/auth.js'
import { setupRoutes } from './routes/setup.js'
import { topicRoutes } from './routes/topics.js'
import { replyRoutes } from './routes/replies.js'
import { categoryRoutes } from './routes/categories.js'
import { adminSettingsRoutes } from './routes/admin-settings.js'
import { reactionRoutes } from './routes/reactions.js'
import { voteRoutes } from './routes/votes.js'
import { moderationRoutes } from './routes/moderation.js'
import { moderationQueueRoutes } from './routes/moderation-queue.js'
import { searchRoutes } from './routes/search.js'
import { notificationRoutes } from './routes/notifications.js'
import { profileRoutes } from './routes/profiles.js'
import { blockMuteRoutes } from './routes/block-mute.js'
import { onboardingRoutes } from './routes/onboarding.js'
import { globalFilterRoutes } from './routes/global-filters.js'
import { communityProfileRoutes } from './routes/community-profiles.js'
import { uploadRoutes } from './routes/uploads.js'
import { adminSybilRoutes } from './routes/admin-sybil.js'
import { adminDesignRoutes } from './routes/admin-design.js'
import { createRequireAdmin } from './auth/require-admin.js'
import { createRequireOperator } from './auth/require-operator.js'
import { OzoneService } from './services/ozone.js'
import { createSetupService } from './setup/service.js'
import type { SetupService } from './setup/service.js'
import { createPlcDidService } from './services/plc-did.js'
import { createHandleResolver } from './lib/handle-resolver.js'
import type { HandleResolver } from './lib/handle-resolver.js'
import { createDidDocumentVerifier } from './lib/did-document-verifier.js'
import { createProfileSyncService } from './services/profile-sync.js'
import type { ProfileSyncService } from './services/profile-sync.js'
import { createLocalStorage } from './lib/storage.js'
import type { StorageService } from './lib/storage.js'
import type { Database } from './db/index.js'
import type { Cache } from './cache/index.js'
import { createInteractionGraphService } from './services/interaction-graph.js'
import type { InteractionGraphService } from './services/interaction-graph.js'
import { createTrustGraphService } from './services/trust-graph.js'
import type { TrustGraphService } from './services/trust-graph.js'

// Extend Fastify types with decorated properties
declare module 'fastify' {
  interface FastifyInstance {
    db: Database
    cache: Cache
    env: Env
    firehose: FirehoseService
    oauthClient: NodeOAuthClient
    sessionService: SessionService
    authMiddleware: AuthMiddleware
    setupService: SetupService
    handleResolver: HandleResolver
    requireAdmin: ReturnType<typeof createRequireAdmin>
    requireOperator: ReturnType<typeof createRequireOperator>
    ozoneService: OzoneService | null
    profileSync: ProfileSyncService
    storage: StorageService
    interactionGraphService: InteractionGraphService
    trustGraphService: TrustGraphService
  }
}

export async function buildApp(env: Env) {
  // Initialize GlitchTip/Sentry if DSN provided
  if (env.GLITCHTIP_DSN) {
    Sentry.init({
      dsn: env.GLITCHTIP_DSN,
      environment:
        env.LOG_LEVEL === 'debug' || env.LOG_LEVEL === 'trace' ? 'development' : 'production',
    })
  }

  const app = Fastify({
    logger: {
      level: env.LOG_LEVEL,
      ...(process.env.NODE_ENV === 'development' &&
      (env.LOG_LEVEL === 'debug' || env.LOG_LEVEL === 'trace')
        ? { transport: { target: 'pino-pretty' } }
        : {}),
    },
    trustProxy: true,
  })

  // Database -- run migrations before creating the main connection pool
  const migrationsFolder = new URL('../drizzle', import.meta.url).pathname
  await runMigrations(env.DATABASE_URL, migrationsFolder)
  app.log.info('Database migrations applied')

  const { db, client: dbClient } = createDb(env.DATABASE_URL)
  app.decorate('db', db)
  app.decorate('env', env)

  // Cache
  const cache = createCache(env.VALKEY_URL, app.log)
  app.decorate('cache', cache)

  // Firehose
  const firehose = new FirehoseService(db, app.log, env)
  app.decorate('firehose', firehose)

  // Security headers -- strict CSP for all routes (no unsafe-inline).
  // The /docs scope overrides this with a permissive CSP for Scalar UI.
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'data:', 'https:'],
        connectSrc: ["'self'"],
        fontSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
      },
    },
    hsts: {
      maxAge: 31536000,
      includeSubDomains: true,
      preload: true,
    },
  })

  // CORS
  await app.register(cors, {
    origin: env.CORS_ORIGINS.split(',').map((o) => o.trim()),
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  })

  // Rate limiting
  await app.register(rateLimit, {
    max: env.RATE_LIMIT_READ_ANON,
    timeWindow: '1 minute',
  })

  // Cookies (must be registered before auth routes)
  await app.register(cookie, { secret: env.SESSION_SECRET })

  // Multipart file uploads
  await app.register(multipart, {
    limits: { fileSize: env.UPLOAD_MAX_SIZE_BYTES },
  })

  // Community resolver (must run before auth middleware)
  let resolver: CommunityResolver
  if (env.COMMUNITY_MODE === 'multi') {
    try {
      const mod = await import('@barazo/multi-tenant')
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      resolver = mod.createMultiResolver(db, cache)
    } catch {
      throw new Error(
        'COMMUNITY_MODE is "multi" but @barazo/multi-tenant package is not installed. ' +
          'Install it or switch to COMMUNITY_MODE="single".'
      )
    }
  } else {
    resolver = createSingleResolver(getCommunityDid(env))
  }
  registerCommunityResolver(app, resolver, env.COMMUNITY_MODE)

  // Set RLS session variable per request
  app.addHook('onRequest', async (request) => {
    if (request.communityDid) {
      await db.execute(
        sql`SELECT set_config('app.current_community_did', ${request.communityDid}, true)`
      )
    }
  })

  // OAuth client
  const oauthClient = createOAuthClient(env, cache, app.log)
  app.decorate('oauthClient', oauthClient)

  // Session service
  const sessionService = createSessionService(cache, app.log, {
    sessionTtl: env.OAUTH_SESSION_TTL,
    accessTokenTtl: env.OAUTH_ACCESS_TOKEN_TTL,
  })
  app.decorate('sessionService', sessionService)

  // DID document verifier (checks DID is still active via PLC directory, cached in Valkey)
  const didVerifier = createDidDocumentVerifier(cache, app.log)

  // Auth middleware (request decoration must happen before hooks can set the property)
  app.decorateRequest('user', undefined as RequestUser | undefined)
  const authMiddleware = createAuthMiddleware(sessionService, didVerifier, app.log)
  app.decorate('authMiddleware', authMiddleware)

  // Handle resolver (DID -> handle, with cache)
  const handleResolver = createHandleResolver(cache, db, app.log)
  app.decorate('handleResolver', handleResolver)

  // Profile sync (fetches AT Protocol profile from Bluesky public API at login)
  const profileSync = createProfileSyncService(db, app.log)
  app.decorate('profileSync', profileSync)

  // PLC DID service + Setup service
  const plcDidService = createPlcDidService(app.log)
  const setupService = createSetupService(db, app.log, env.AI_ENCRYPTION_KEY, plcDidService)
  app.decorate('setupService', setupService)

  // Admin middleware
  const requireAdmin = createRequireAdmin(db, authMiddleware, app.log)
  app.decorate('requireAdmin', requireAdmin)

  // Operator middleware (multi mode only)
  const requireOperator = createRequireOperator(env, authMiddleware, app.log)
  app.decorate('requireOperator', requireOperator)

  // Local file storage for uploads
  const uploadBaseUrl =
    env.UPLOAD_BASE_URL ?? env.CORS_ORIGINS.split(',')[0]?.trim() ?? 'http://localhost:3000'
  const storage = createLocalStorage(env.UPLOAD_DIR, uploadBaseUrl, app.log)
  app.decorate('storage', storage)

  // Interaction graph service (records reply/reaction/co-participation edges)
  const interactionGraphService = createInteractionGraphService(db, app.log)
  app.decorate('interactionGraphService', interactionGraphService)

  // Trust graph service (EigenTrust computation + score lookup)
  const trustGraphService = createTrustGraphService(db, app.log)
  app.decorate('trustGraphService', trustGraphService)

  // Ozone labeler service (opt-in, only if URL is configured)
  let ozoneService: OzoneService | null = null
  if (env.OZONE_LABELER_URL) {
    ozoneService = new OzoneService(db, cache, app.log, env.OZONE_LABELER_URL)
  }
  app.decorate('ozoneService', ozoneService)

  // OpenAPI documentation (register before routes so schemas are collected)
  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'Barazo Forum API',
        description: 'AT Protocol forum AppView -- portable identity, federated communities.',
        version: '0.1.0',
      },
      servers: [
        {
          url: env.CORS_ORIGINS.split(',')[0]?.trim() ?? 'http://localhost:3000',
          description: 'Primary server',
        },
      ],
      components: {
        securitySchemes: {
          bearerAuth: {
            type: 'http',
            scheme: 'bearer',
            description: 'Access token from /api/auth/callback or /api/auth/refresh',
          },
        },
      },
    },
  })

  // Scalar API docs UI requires inline scripts/styles and CDN assets.
  // Register in a scoped plugin to override the strict global CSP.
  await app.register(async function docsPlugin(scope) {
    const docsCsp = [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net",
      "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net",
      "img-src 'self' data: https:",
      "connect-src 'self'",
      "font-src 'self' https://cdn.jsdelivr.net",
      "object-src 'none'",
      "frame-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join('; ')

    scope.addHook('onRequest', async (_request, reply) => {
      reply.header('content-security-policy', docsCsp)
    })

    await scope.register(scalarApiReference, {
      routePrefix: '/docs',
      configuration: {
        theme: 'kepler',
      },
    })
  })

  // Routes
  await app.register(healthRoutes)
  await app.register(oauthMetadataRoutes(oauthClient))
  await app.register(authRoutes(oauthClient))
  await app.register(setupRoutes())
  await app.register(topicRoutes())
  await app.register(replyRoutes())
  await app.register(categoryRoutes())
  await app.register(adminSettingsRoutes())
  await app.register(reactionRoutes())
  await app.register(voteRoutes())
  await app.register(moderationRoutes())
  await app.register(moderationQueueRoutes())
  await app.register(searchRoutes())
  await app.register(notificationRoutes())
  await app.register(profileRoutes())
  await app.register(blockMuteRoutes())
  await app.register(onboardingRoutes())
  await app.register(globalFilterRoutes())
  await app.register(communityProfileRoutes())
  await app.register(uploadRoutes())
  await app.register(adminSybilRoutes())
  await app.register(adminDesignRoutes())

  // OpenAPI spec endpoint (after routes so all schemas are registered)
  app.get('/api/openapi.json', { schema: { hide: true } }, async (_request, reply) => {
    return reply.header('Content-Type', 'application/json').send(app.swagger())
  })

  // Start firehose and optional services when app is ready
  app.addHook('onReady', async () => {
    await firehose.start()
    if (ozoneService) {
      ozoneService.start()
    }
  })

  // Graceful shutdown: stop services before closing DB
  app.addHook('onClose', async () => {
    app.log.info('Shutting down...')
    if (ozoneService) {
      ozoneService.stop()
    }
    await firehose.stop()
    await cache.quit()
    await dbClient.end()
    app.log.info('Connections closed')
  })

  // GlitchTip error handler
  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (env.GLITCHTIP_DSN) {
      Sentry.captureException(error)
    }
    app.log.error({ err: error, requestId: request.id }, 'Unhandled error')
    const statusCode = error.statusCode ?? 500
    return reply.status(statusCode).send({
      error: 'Internal Server Error',
      message:
        env.LOG_LEVEL === 'debug' || env.LOG_LEVEL === 'trace'
          ? error.message
          : 'An unexpected error occurred',
      statusCode,
    })
  })

  return app
}
