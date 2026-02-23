import type { FastifyReply, FastifyRequest } from 'fastify'
import type { AuthMiddleware } from './middleware.js'
import type { Env } from '../config/env.js'
import type { Logger } from '../lib/logger.js'

/**
 * Create a requireOperator preHandler hook for Fastify routes.
 *
 * This middleware:
 * 1. Returns 404 if COMMUNITY_MODE is not "multi" (hides operator routes in single mode)
 * 2. Delegates to requireAuth to verify the user is authenticated
 * 3. Checks if the user's DID is in the OPERATOR_DIDS list
 * 4. Returns 403 if the user is not an operator
 *
 * Operators may not exist in the users table -- they are platform-level admins
 * identified solely by their DID in the environment config.
 */
export function createRequireOperator(
  env: Env,
  authMiddleware: AuthMiddleware,
  logger?: Logger
): (request: FastifyRequest, reply: FastifyReply) => Promise<void> {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    // Multi-mode-only routes return 404 in single-community mode
    if (env.COMMUNITY_MODE !== 'multi') {
      await reply.status(404).send({ error: 'Not found' })
      return
    }

    // Verify authentication
    await authMiddleware.requireAuth(request, reply)

    if (reply.sent) {
      return
    }

    if (!request.user) {
      logger?.warn(
        { url: request.url, method: request.method },
        'Operator access denied: no user after auth'
      )
      await reply.status(403).send({ error: 'Operator access required' })
      return
    }

    // Check if DID is in the operator list
    if (!env.OPERATOR_DIDS.includes(request.user.did)) {
      logger?.warn(
        { did: request.user.did, url: request.url, method: request.method },
        'Operator access denied: DID not in OPERATOR_DIDS'
      )
      await reply.status(403).send({ error: 'Operator access required' })
      return
    }

    logger?.info(
      { did: request.user.did, url: request.url, method: request.method },
      'Operator access granted'
    )
  }
}
