import type { FastifyPluginCallback } from 'fastify'
import { sql } from 'drizzle-orm'

export const healthRoutes: FastifyPluginCallback = (fastify, _opts, done) => {
  fastify.get('/api/health', async (_request, reply) => {
    return reply.send({
      status: 'healthy',
      version: '0.1.0',
      uptime: process.uptime(),
    })
  })

  fastify.get('/api/health/ready', async (_request, reply) => {
    const checks: Record<string, { status: string; latency?: number }> = {}

    // Check database
    const dbStart = performance.now()
    try {
      await fastify.db.execute(sql`SELECT 1`)
      checks['database'] = {
        status: 'healthy',
        latency: Math.round(performance.now() - dbStart),
      }
    } catch {
      checks['database'] = { status: 'unhealthy' }
    }

    // Check cache
    const cacheStart = performance.now()
    try {
      await fastify.cache.ping()
      checks['cache'] = {
        status: 'healthy',
        latency: Math.round(performance.now() - cacheStart),
      }
    } catch {
      checks['cache'] = { status: 'unhealthy' }
    }

    // Check firehose
    // During startup (no events processed yet), treat as healthy.
    // Once events have been processed, require an active connection.
    const firehoseStatus = fastify.firehose.getStatus()
    const firehoseHealthy = firehoseStatus.connected || firehoseStatus.lastEventId === null
    checks['firehose'] = {
      status: firehoseHealthy ? 'healthy' : 'unhealthy',
      ...(firehoseStatus.lastEventId !== null ? { latency: firehoseStatus.lastEventId } : {}),
    }

    const allHealthy = Object.values(checks).every((c) => c.status === 'healthy')

    return reply.status(allHealthy ? 200 : 503).send({
      status: allHealthy ? 'ready' : 'degraded',
      checks,
    })
  })

  done()
}
