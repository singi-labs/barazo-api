import { eq, and, isNull, like } from 'drizzle-orm'
import pino from 'pino'
import { createDb } from '../src/db/index.js'
import type { Database } from '../src/db/index.js'
import { users } from '../src/db/schema/index.js'
import { createAccountAgeService } from '../src/services/account-age.js'
import type { AccountAgeService } from '../src/services/account-age.js'
import type { Logger } from '../src/lib/logger.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BackfillDeps {
  db: Database
  accountAgeService: AccountAgeService
  logger: Logger
  batchSize: number
  delayMs: number
}

export interface BackfillResult {
  total: number
  resolved: number
  skipped: number
  failed: number
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_BATCH_SIZE = 50
const DEFAULT_DELAY_MS = 200
const PROGRESS_INTERVAL = 10

// ---------------------------------------------------------------------------
// Core logic (testable)
// ---------------------------------------------------------------------------

export async function backfillAccountCreatedAt(deps: BackfillDeps): Promise<BackfillResult> {
  const { db, accountAgeService, logger, delayMs } = deps

  const pendingUsers = await db
    .select({ did: users.did })
    .from(users)
    .where(and(isNull(users.accountCreatedAt), like(users.did, 'did:plc:%')))

  if (pendingUsers.length === 0) {
    logger.info('No users need account age backfilling')
    return { total: 0, resolved: 0, skipped: 0, failed: 0 }
  }

  logger.info({ count: pendingUsers.length }, 'Starting account age backfill')

  const result: BackfillResult = { total: pendingUsers.length, resolved: 0, skipped: 0, failed: 0 }

  for (let i = 0; i < pendingUsers.length; i++) {
    const user = pendingUsers[i]
    if (!user) continue

    try {
      const createdAt = await accountAgeService.resolveCreationDate(user.did)

      if (createdAt) {
        await db.update(users).set({ accountCreatedAt: createdAt }).where(eq(users.did, user.did))
        result.resolved++
      } else {
        logger.warn({ did: user.did }, 'Could not resolve account creation date, skipping')
        result.skipped++
      }
    } catch (err: unknown) {
      logger.error({ err, did: user.did }, 'Failed to process user during backfill')
      result.failed++
    }

    // Log progress every PROGRESS_INTERVAL users
    const processed = i + 1
    if (processed % PROGRESS_INTERVAL === 0) {
      logger.info(
        {
          processed,
          total: pendingUsers.length,
          resolved: result.resolved,
          skipped: result.skipped,
          failed: result.failed,
        },
        `Processed ${String(processed)}/${String(pendingUsers.length)} users`
      )
    }

    // Rate-limit between PLC directory requests
    if (delayMs > 0 && i < pendingUsers.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, delayMs))
    }
  }

  return result
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const logger = pino({ level: 'info' })

  const databaseUrl = process.env['DATABASE_URL']
  if (!databaseUrl) {
    logger.fatal('DATABASE_URL environment variable is required')
    process.exit(1)
  }

  const { db, client } = createDb(databaseUrl)
  const accountAgeService = createAccountAgeService(logger)

  try {
    const result = await backfillAccountCreatedAt({
      db,
      accountAgeService,
      logger,
      batchSize: DEFAULT_BATCH_SIZE,
      delayMs: DEFAULT_DELAY_MS,
    })

    logger.info(
      {
        total: result.total,
        resolved: result.resolved,
        skipped: result.skipped,
        failed: result.failed,
      },
      'Backfill complete'
    )
  } finally {
    await client.end()
  }

  process.exit(0)
}

// Only run main when executed directly via tsx (not imported by Vitest)
const isDirectExecution =
  process.argv[1]?.endsWith('backfill-account-created-at.ts') === true &&
  typeof process.env['VITEST'] === 'undefined'
if (isDirectExecution) {
  main().catch((err: unknown) => {
    // eslint-disable-next-line no-console -- CLI fallback for fatal errors before logger setup
    console.error('Backfill failed:', err)
    process.exit(1)
  })
}
