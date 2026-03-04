import { eq, sql } from 'drizzle-orm'
import { communitySettings } from '../db/schema/community-settings.js'
import { communityOnboardingFields } from '../db/schema/onboarding-fields.js'
import { users } from '../db/schema/users.js'
import type { Database } from '../db/index.js'
import { encrypt } from '../lib/encryption.js'
import type { Logger } from '../lib/logger.js'
import type { PlcDidService } from '../services/plc-did.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Result of getStatus(): either not initialized, or initialized with name. */
export type SetupStatus = { initialized: false } | { initialized: true; communityName: string }

/** Parameters for community initialization. */
export interface InitializeParams {
  /** Community DID (primary key for the settings row) */
  communityDid: string
  /** DID of the authenticated user who becomes admin */
  did: string
  /** Optional community name override */
  communityName?: string | undefined
  /** Community handle (e.g. "community.barazo.forum"). Required for PLC DID generation. */
  handle?: string | undefined
  /** Community service endpoint (e.g. "https://community.barazo.forum"). Required for PLC DID generation. */
  serviceEndpoint?: string | undefined
}

/** Result of initialize(): either success with details, or already initialized. */
export type InitializeResult =
  | {
      initialized: true
      adminDid: string
      communityName: string
      communityDid?: string | undefined
    }
  | { alreadyInitialized: true }

/** Setup service interface for dependency injection and testing. */
export interface SetupService {
  getStatus(communityDid: string): Promise<SetupStatus>
  initialize(params: InitializeParams): Promise<InitializeResult>
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_COMMUNITY_NAME = 'Barazo Community'

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a setup service for managing community initialization.
 *
 * The first authenticated user to call initialize() becomes the community admin.
 * When handle and serviceEndpoint are provided, a PLC DID is generated and
 * registered with plc.directory.
 *
 * @param db - Drizzle database instance
 * @param logger - Pino logger instance
 * @param encryptionKey - KEK for encrypting sensitive data (AI_ENCRYPTION_KEY)
 * @param plcDidService - Optional PLC DID service for DID generation
 * @returns SetupService with getStatus and initialize methods
 */
export function createSetupService(
  db: Database,
  logger: Logger,
  encryptionKey: string,
  plcDidService?: PlcDidService
): SetupService {
  /**
   * Check whether the community has been initialized.
   *
   * @param communityDid - The community DID to check status for
   * @returns SetupStatus indicating initialization state
   */
  async function getStatus(communityDid: string): Promise<SetupStatus> {
    try {
      const rows = await db
        .select({
          initialized: communitySettings.initialized,
          communityName: communitySettings.communityName,
        })
        .from(communitySettings)
        .where(eq(communitySettings.communityDid, communityDid))

      const row = rows[0]

      if (!row || !row.initialized) {
        return { initialized: false }
      }

      return { initialized: true, communityName: row.communityName }
    } catch (err: unknown) {
      logger.error({ err }, 'Failed to get setup status')
      throw err
    }
  }

  /**
   * Initialize the community with the first admin user.
   *
   * Uses an atomic upsert to prevent race conditions: INSERT new row, or
   * UPDATE existing if not yet initialized. The WHERE clause ensures an
   * already-initialized row is never overwritten.
   *
   * If handle and serviceEndpoint are provided and a PlcDidService is
   * available, generates a PLC DID with signing + rotation keys and
   * registers it with plc.directory.
   *
   * @param params - Initialization parameters
   * @returns InitializeResult with the new state or conflict indicator
   */
  async function initialize(params: InitializeParams): Promise<InitializeResult> {
    const { communityDid, did, communityName, handle, serviceEndpoint } = params

    try {
      // Generate PLC DID if handle and serviceEndpoint are provided
      let plcDid: string | undefined
      let signingKeyHex: string | undefined
      let rotationKeyHex: string | undefined

      if (handle && serviceEndpoint && plcDidService) {
        logger.info({ handle, serviceEndpoint }, 'Generating PLC DID during community setup')

        const didResult = await plcDidService.generateDid({
          handle,
          serviceEndpoint,
        })

        plcDid = didResult.did
        signingKeyHex = encrypt(didResult.signingKey, encryptionKey)
        rotationKeyHex = encrypt(didResult.rotationKey, encryptionKey)

        logger.info({ plcDid, handle }, 'PLC DID generated successfully')
      } else if (handle && serviceEndpoint && !plcDidService) {
        logger.warn(
          { handle, serviceEndpoint },
          'PLC DID generation requested but PlcDidService not available'
        )
      }

      // Atomic upsert: INSERT new row, or UPDATE existing if not yet initialized.
      // The WHERE clause ensures an already-initialized row is never overwritten.
      const rows = await db
        .insert(communitySettings)
        .values({
          communityDid,
          initialized: true,
          adminDid: did,
          communityName: communityName ?? DEFAULT_COMMUNITY_NAME,
          handle: handle ?? null,
          serviceEndpoint: serviceEndpoint ?? null,
          signingKey: signingKeyHex ?? null,
          rotationKey: rotationKeyHex ?? null,
        })
        .onConflictDoUpdate({
          target: communitySettings.communityDid,
          set: {
            initialized: true,
            adminDid: did,
            communityName: communityName ? communityName : sql`${communitySettings.communityName}`,
            handle: handle ?? sql`${communitySettings.handle}`,
            serviceEndpoint: serviceEndpoint ?? sql`${communitySettings.serviceEndpoint}`,
            signingKey: signingKeyHex ?? sql`${communitySettings.signingKey}`,
            rotationKey: rotationKeyHex ?? sql`${communitySettings.rotationKey}`,
            updatedAt: new Date(),
          },
          where: eq(communitySettings.initialized, false),
        })
        .returning({
          communityName: communitySettings.communityName,
          communityDid: communitySettings.communityDid,
        })

      const row = rows[0]
      if (!row) {
        logger.warn({ did }, 'Setup initialize attempted on already-initialized community')
        return { alreadyInitialized: true }
      }

      // Promote the initializing user to admin in the users table
      await db.update(users).set({ role: 'admin' }).where(eq(users.did, did))
      logger.info({ did }, 'User promoted to admin role')

      // Seed platform onboarding fields
      await db
        .insert(communityOnboardingFields)
        .values({
          id: 'platform:age_confirmation',
          communityDid,
          fieldType: 'age_confirmation',
          label: 'Age Declaration',
          description:
            'Please select your age bracket. This determines which content is available to you.',
          isMandatory: true,
          sortOrder: -1,
          source: 'platform',
          config: null,
        })
        .onConflictDoNothing()
      logger.info({ communityDid }, 'Platform onboarding fields seeded')

      const finalName = row.communityName
      logger.info({ did, communityName: finalName }, 'Community initialized')

      const result: InitializeResult = {
        initialized: true,
        adminDid: did,
        communityName: finalName,
      }

      if (plcDid) {
        result.communityDid = plcDid
      }

      return result
    } catch (err: unknown) {
      logger.error({ err, did }, 'Failed to initialize community')
      throw err
    }
  }

  return { getStatus, initialize }
}
