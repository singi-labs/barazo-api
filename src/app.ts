import { join } from 'node:path'
import Fastify from 'fastify'
import helmet from '@fastify/helmet'
import cors from '@fastify/cors'
import cookie from '@fastify/cookie'
import multipart from '@fastify/multipart'
import rateLimit from '@fastify/rate-limit'
import swagger from '@fastify/swagger'
import scalarApiReference from '@scalar/fastify-api-reference'
import * as Sentry from '@sentry/node'
import type { FastifyError, FastifyPluginCallback } from 'fastify'
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
import { pageRoutes } from './routes/pages.js'
import { adminSettingsRoutes } from './routes/admin-settings.js'
import { reactionRoutes } from './routes/reactions.js'
import { voteRoutes } from './routes/votes.js'
import { moderationRoutes } from './routes/moderation.js'
import { modAnnotationRoutes } from './routes/mod-annotations.js'
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
import { adminPluginRoutes } from './routes/admin-plugins.js'
import { communityRulesRoutes } from './routes/community-rules.js'
import { discoverPlugins, syncPluginsToDb, validateAndFilterPlugins } from './lib/plugins/loader.js'
import { buildLoadedPlugin, executeHook, getPluginShortName } from './lib/plugins/runtime.js'
import { createPluginContext, type CacheAdapter } from './lib/plugins/context.js'
import type { PluginContext } from './lib/plugins/types.js'
import type { LoadedPlugin } from './lib/plugins/types.js'
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
    loadedPlugins: Map<string, LoadedPlugin>
    enabledPlugins: Set<string>
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

  // Plugin discovery and DB sync
  const nodeModulesPath = new URL('../node_modules', import.meta.url).pathname
  const discovered = await discoverPlugins(nodeModulesPath, app.log)
  const loadedPlugins = new Map<string, LoadedPlugin>()
  const enabledPlugins = new Set<string>()

  if (discovered.length > 0) {
    const validManifests = validateAndFilterPlugins(
      discovered.map((d) => d.manifest),
      '0.1.0',
      app.log
    )
    app.log.info({ count: validManifests.length }, 'Plugins discovered')

    const syncResult = await syncPluginsToDb(discovered, db, app.log)

    // Build LoadedPlugin objects (resolve hooks, route paths)
    for (const { manifest, packagePath } of discovered) {
      const loaded = await buildLoadedPlugin(manifest, packagePath, app.log)
      loadedPlugins.set(manifest.name, loaded)
    }

    // Run onInstall for newly discovered plugins
    for (const newName of syncResult.newPlugins) {
      const loaded = loadedPlugins.get(newName)
      if (loaded?.hooks?.onInstall) {
        const ctx = createPluginContext({
          pluginName: loaded.name,
          pluginVersion: loaded.version,
          permissions: [],
          settings: {},
          db,
          cache: null,
          oauthClient: null,
          logger: app.log,
          communityDid: getCommunityDid(env),
        })
        // eslint-disable-next-line @typescript-eslint/unbound-method -- plugin hooks are standalone functions
        const hookFn = loaded.hooks.onInstall as (...args: unknown[]) => Promise<void>
        await executeHook('onInstall', hookFn, ctx, app.log, loaded.name)
      }
    }

    // Track enabled plugins
    const enabledRows = (await db.execute(
      sql`SELECT name FROM plugins WHERE enabled = true`
    )) as unknown as Array<{ name: string }>
    for (const row of enabledRows) {
      enabledPlugins.add(row.name)
    }
  } else {
    app.log.info('No plugins discovered')
  }

  app.decorate('loadedPlugins', loadedPlugins)
  app.decorate('enabledPlugins', enabledPlugins)

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
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
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

  // Wrap Valkey/ioredis client as CacheAdapter for plugin contexts
  const pluginCacheAdapter: CacheAdapter = {
    async get(key: string): Promise<string | null> {
      return cache.get(key)
    },
    async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
      if (ttlSeconds !== undefined) {
        await cache.set(key, value, 'EX', ttlSeconds)
      } else {
        await cache.set(key, value)
      }
    },
    async del(key: string): Promise<void> {
      await cache.del(key)
    },
  }

  // Profile sync (fetches AT Protocol profile from Bluesky public API at login)
  const profileSync = createProfileSyncService(db, app.log, {
    loadedPlugins,
    enabledPlugins,
    oauthClient,
    cache: pluginCacheAdapter,
    communityDid: getCommunityDid(env),
  })
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

  // Register plugin routes under /api/ext/<short-name>/
  for (const [, loaded] of loadedPlugins) {
    if (!loaded.routesPath) continue

    const shortName = getPluginShortName(loaded.name)
    const routesFullPath = join(loaded.packagePath, loaded.routesPath)

    try {
      const routeModule = (await import(routesFullPath)) as Record<string, unknown>

      // Find the exported Fastify plugin function (convention: first function export)
      const routeFn = Object.values(routeModule).find((v) => typeof v === 'function') as
        | FastifyPluginCallback<{ ctx: PluginContext }>
        | undefined

      if (!routeFn) {
        app.log.warn({ plugin: loaded.name }, 'No route function export found')
        continue
      }

      // Query settings for this plugin from DB
      const pluginRows = (await db.execute(
        sql`SELECT id FROM plugins WHERE name = ${loaded.name}`
      )) as unknown as Array<{ id: string }>
      const pluginId = pluginRows[0]?.id

      const settingsObj: Record<string, unknown> = {}
      if (pluginId) {
        const settingsRows = (await db.execute(
          sql`SELECT key, value FROM plugin_settings WHERE plugin_id = ${pluginId}`
        )) as unknown as Array<{ key: string; value: unknown }>
        for (const s of settingsRows) {
          settingsObj[s.key] = s.value
        }
      }

      // Get permissions from manifest
      const manifestData = loaded.manifest as { permissions?: { backend?: string[] } }
      const permissions = manifestData.permissions?.backend ?? []

      const ctx = createPluginContext({
        pluginName: loaded.name,
        pluginVersion: loaded.version,
        permissions,
        settings: settingsObj,
        db,
        cache: pluginCacheAdapter,
        oauthClient,
        logger: app.log,
        communityDid: getCommunityDid(env),
      })

      // Register in a scoped plugin with enabled-check preHandler
      await app.register(
        async function pluginRouteScope(scope) {
          scope.addHook('preHandler', async (_request, reply) => {
            if (!app.enabledPlugins.has(loaded.name)) {
              return reply.status(404).send({ error: 'Plugin not available' })
            }
          })
          await scope.register(routeFn, { ctx })
        },
        { prefix: `/api/ext/${shortName}` }
      )

      app.log.info(
        { plugin: loaded.name, prefix: `/api/ext/${shortName}` },
        'Plugin routes registered'
      )
    } catch (err: unknown) {
      app.log.error({ err, plugin: loaded.name }, 'Failed to register plugin routes')
    }
  }

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
  await app.register(pageRoutes())
  await app.register(adminSettingsRoutes())
  await app.register(reactionRoutes())
  await app.register(voteRoutes())
  await app.register(moderationRoutes())
  await app.register(modAnnotationRoutes())
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
  await app.register(adminPluginRoutes())
  await app.register(communityRulesRoutes())

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
