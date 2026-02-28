import { Agent } from '@atproto/api'
import { eq } from 'drizzle-orm'
import type { Logger } from '../lib/logger.js'
import type { Database } from '../db/index.js'
import { users } from '../db/schema/users.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Profile data fetched from the Bluesky public API. */
export interface ProfileData {
  displayName: string | null
  avatarUrl: string | null
  bannerUrl: string | null
  bio: string | null
  labels: Array<{ val: string; src: string; neg: boolean; cts: string }>
}

export interface ProfileSyncService {
  syncProfile(did: string): Promise<ProfileData>
}

/** Null profile returned on any failure. */
const NULL_PROFILE: ProfileData = {
  displayName: null,
  avatarUrl: null,
  bannerUrl: null,
  bio: null,
  labels: [],
}

// ---------------------------------------------------------------------------
// Public API agent factory (injectable for testing)
// ---------------------------------------------------------------------------

/** Bluesky public AppView API -- no auth required for profile reads. */
const BSKY_PUBLIC_API = 'https://public.api.bsky.app'

interface AgentLike {
  getProfile(params: { actor: string }): Promise<{
    data: {
      did?: string
      displayName?: string
      avatar?: string
      banner?: string
      description?: string
      labels?: Array<{ val: string; src: string; uri: string; neg?: boolean; cts: string }>
    }
  }>
}

interface AgentFactory {
  createAgent(): AgentLike
}

const defaultAgentFactory: AgentFactory = {
  createAgent(): AgentLike {
    return new Agent(new URL(BSKY_PUBLIC_API))
  },
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a profile sync service that fetches a user's AT Protocol profile
 * via the Bluesky public API at login time and updates the local users table.
 *
 * Uses the public AppView API (no auth required) so profile sync works
 * regardless of which OAuth scopes the user granted.
 *
 * @param db - Drizzle database instance
 * @param logger - Pino logger
 * @param agentFactory - Optional factory for creating Agent instances (testing)
 */
export function createProfileSyncService(
  db: Database,
  logger: Logger,
  agentFactory: AgentFactory = defaultAgentFactory
): ProfileSyncService {
  return {
    async syncProfile(did: string): Promise<ProfileData> {
      // 1. Fetch profile from Bluesky public API (no auth needed)
      let profileData: ProfileData
      try {
        const agent = agentFactory.createAgent()
        const response = await agent.getProfile({ actor: did })
        const rawLabels = response.data.labels ?? []
        const labels = rawLabels
          .filter((l) => !l.neg)
          .map((l) => ({ val: l.val, src: l.src, neg: false as const, cts: l.cts }))

        profileData = {
          displayName: response.data.displayName ?? null,
          avatarUrl: response.data.avatar ?? null,
          bannerUrl: response.data.banner ?? null,
          bio: response.data.description ?? null,
          labels,
        }
      } catch (err: unknown) {
        logger.debug({ did, err }, 'profile sync failed: could not fetch profile from public API')
        return NULL_PROFILE
      }

      // 2. Best-effort DB update
      try {
        await db
          .update(users)
          .set({
            displayName: profileData.displayName,
            avatarUrl: profileData.avatarUrl,
            bannerUrl: profileData.bannerUrl,
            bio: profileData.bio,
            atprotoLabels: profileData.labels,
            lastActiveAt: new Date(),
          })
          .where(eq(users.did, did))
      } catch (err: unknown) {
        logger.warn({ did, err }, 'profile DB update failed: could not persist profile data')
      }

      return profileData
    },
  }
}
