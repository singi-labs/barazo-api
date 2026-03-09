import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers'
import { drizzle } from 'drizzle-orm/postgres-js'
import { sql } from 'drizzle-orm'
import postgres from 'postgres'
import * as schema from '../../src/db/schema/index.js'

const COMMUNITY_A = 'did:plc:communityA'
const COMMUNITY_B = 'did:plc:communityB'

/** Port for the test PostgreSQL instance (host networking). */
const PG_PORT = 25432

/**
 * Create the schema tables and RLS policies directly via SQL.
 * Only creates the tables needed for tenant-isolation testing.
 */
async function pushSchema(client: ReturnType<typeof postgres>): Promise<void> {
  await client`
    CREATE ROLE barazo_app LOGIN PASSWORD 'barazo_app'
  `

  // community_settings
  await client`
    CREATE TABLE community_settings (
      community_did TEXT PRIMARY KEY,
      domains JSONB NOT NULL DEFAULT '[]',
      initialized BOOLEAN NOT NULL DEFAULT false,
      admin_did TEXT,
      community_name TEXT NOT NULL DEFAULT 'Barazo Community',
      maturity_rating TEXT NOT NULL DEFAULT 'safe',
      reaction_set JSONB NOT NULL DEFAULT '["like"]',
      moderation_thresholds JSONB NOT NULL DEFAULT '{}',
      word_filter JSONB NOT NULL DEFAULT '[]',
      jurisdiction_country TEXT,
      age_threshold INTEGER NOT NULL DEFAULT 16,
      max_reply_depth INTEGER NOT NULL DEFAULT 9999,
      require_login_for_mature BOOLEAN NOT NULL DEFAULT true,
      community_description TEXT,
      handle TEXT,
      service_endpoint TEXT,
      signing_key TEXT,
      rotation_key TEXT,
      community_logo_url TEXT,
      favicon_url TEXT,
      header_logo_url TEXT,
      show_community_name BOOLEAN NOT NULL DEFAULT true,
      primary_color TEXT,
      accent_color TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `

  // categories
  await client`
    CREATE TABLE categories (
      id TEXT PRIMARY KEY,
      slug TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      parent_id TEXT REFERENCES categories(id) ON DELETE SET NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      community_did TEXT NOT NULL,
      maturity_rating TEXT NOT NULL DEFAULT 'safe',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `

  // topics
  await client`
    CREATE TABLE topics (
      uri TEXT PRIMARY KEY,
      rkey TEXT NOT NULL,
      author_did TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      category TEXT NOT NULL,
      site TEXT,
      tags JSONB,
      community_did TEXT NOT NULL,
      cid TEXT NOT NULL,
      labels JSONB,
      reply_count INTEGER NOT NULL DEFAULT 0,
      reaction_count INTEGER NOT NULL DEFAULT 0,
      vote_count INTEGER NOT NULL DEFAULT 0,
      last_activity_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      published_at TIMESTAMPTZ NOT NULL,
      indexed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      is_locked BOOLEAN NOT NULL DEFAULT false,
      is_pinned BOOLEAN NOT NULL DEFAULT false,
      pinned_at TIMESTAMPTZ,
      pinned_scope TEXT,
      is_mod_deleted BOOLEAN NOT NULL DEFAULT false,
      is_author_deleted BOOLEAN NOT NULL DEFAULT false,
      moderation_status TEXT NOT NULL DEFAULT 'approved',
      trust_status TEXT NOT NULL DEFAULT 'trusted'
    )
  `

  // replies
  await client`
    CREATE TABLE replies (
      uri TEXT PRIMARY KEY,
      rkey TEXT NOT NULL,
      author_did TEXT NOT NULL,
      content TEXT NOT NULL,
      root_uri TEXT NOT NULL,
      root_cid TEXT NOT NULL,
      parent_uri TEXT NOT NULL,
      parent_cid TEXT NOT NULL,
      community_did TEXT NOT NULL,
      cid TEXT NOT NULL,
      labels JSONB,
      reaction_count INTEGER NOT NULL DEFAULT 0,
      vote_count INTEGER NOT NULL DEFAULT 0,
      depth INTEGER NOT NULL DEFAULT 1,
      created_at TIMESTAMPTZ NOT NULL,
      indexed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      is_author_deleted BOOLEAN NOT NULL DEFAULT false,
      is_mod_deleted BOOLEAN NOT NULL DEFAULT false,
      moderation_status TEXT NOT NULL DEFAULT 'approved',
      trust_status TEXT NOT NULL DEFAULT 'trusted'
    )
  `

  // Enable RLS and create policies on all tables
  const tables = ['community_settings', 'categories', 'topics', 'replies']
  for (const table of tables) {
    await client.unsafe(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`)
    await client.unsafe(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`)
    await client.unsafe(`
      CREATE POLICY tenant_isolation ON ${table}
        AS PERMISSIVE
        FOR ALL
        TO barazo_app
        USING (community_did = current_setting('app.current_community_did', true))
        WITH CHECK (community_did = current_setting('app.current_community_did', true))
    `)
  }

  // Grant permissions to app role
  await client`GRANT ALL ON ALL TABLES IN SCHEMA public TO barazo_app`
  await client`GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO barazo_app`
}

describe('tenant isolation (RLS)', () => {
  let container: StartedTestContainer | undefined
  let superClient: ReturnType<typeof postgres> | undefined
  let superDb: ReturnType<typeof drizzle>
  let appClient: ReturnType<typeof postgres> | undefined
  let appDb: ReturnType<typeof drizzle>

  beforeAll(async () => {
    // 1. Start PostgreSQL with host networking
    container = await new GenericContainer('postgres:16-alpine')
      .withEnvironment({
        POSTGRES_USER: 'test',
        POSTGRES_PASSWORD: 'test',
        POSTGRES_DB: 'test',
        PGPORT: String(PG_PORT),
      })
      .withNetworkMode('host')
      .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
      .start()

    const superUri = `postgresql://test:test@127.0.0.1:${String(PG_PORT)}/test`

    // 2. Create schema and RLS policies
    const setupClient = postgres(superUri, { max: 1, connect_timeout: 10 })
    await pushSchema(setupClient)
    await setupClient.end()

    // 3. Superuser connection (table owner, bypasses RLS)
    superClient = postgres(superUri, { max: 5, connect_timeout: 10 })
    superDb = drizzle(superClient, { schema })

    // 4. App-role connection (subject to RLS)
    const appUri = `postgresql://barazo_app:barazo_app@127.0.0.1:${String(PG_PORT)}/test`
    appClient = postgres(appUri, { max: 5, connect_timeout: 10 })
    appDb = drizzle(appClient, { schema })

    // 5. Seed two communities using superuser (bypasses RLS)
    await superDb.insert(schema.communitySettings).values([
      { communityDid: COMMUNITY_A, communityName: 'Community A', domains: ['a.example.com'] },
      { communityDid: COMMUNITY_B, communityName: 'Community B', domains: ['b.example.com'] },
    ])

    // 6. Seed categories
    await superDb.insert(schema.categories).values([
      { id: 'cat-a-1', slug: 'general', name: 'General', communityDid: COMMUNITY_A },
      { id: 'cat-b-1', slug: 'general', name: 'General', communityDid: COMMUNITY_B },
    ])

    // 7. Seed topics
    const now = new Date()
    await superDb.insert(schema.topics).values([
      {
        uri: 'at://did:plc:user1/forum.barazo.topic/aaa',
        rkey: 'aaa',
        authorDid: 'did:plc:user1',
        title: 'Topic in A',
        content: 'Content for community A',
        category: 'general',
        communityDid: COMMUNITY_A,
        cid: 'cid-aaa',
        publishedAt: now,
      },
      {
        uri: 'at://did:plc:user2/forum.barazo.topic/bbb',
        rkey: 'bbb',
        authorDid: 'did:plc:user2',
        title: 'Topic in B',
        content: 'Content for community B',
        category: 'general',
        communityDid: COMMUNITY_B,
        cid: 'cid-bbb',
        publishedAt: now,
      },
    ])

    // 8. Seed replies
    await superDb.insert(schema.replies).values([
      {
        uri: 'at://did:plc:user1/forum.barazo.reply/r-aaa',
        rkey: 'r-aaa',
        authorDid: 'did:plc:user1',
        content: 'Reply in A',
        rootUri: 'at://did:plc:user1/forum.barazo.topic/aaa',
        rootCid: 'cid-aaa',
        parentUri: 'at://did:plc:user1/forum.barazo.topic/aaa',
        parentCid: 'cid-aaa',
        communityDid: COMMUNITY_A,
        cid: 'cid-r-aaa',
        createdAt: now,
      },
      {
        uri: 'at://did:plc:user2/forum.barazo.reply/r-bbb',
        rkey: 'r-bbb',
        authorDid: 'did:plc:user2',
        content: 'Reply in B',
        rootUri: 'at://did:plc:user2/forum.barazo.topic/bbb',
        rootCid: 'cid-bbb',
        parentUri: 'at://did:plc:user2/forum.barazo.topic/bbb',
        parentCid: 'cid-bbb',
        communityDid: COMMUNITY_B,
        cid: 'cid-r-bbb',
        createdAt: now,
      },
    ])
  }, 120_000)

  afterAll(async () => {
    await appClient?.end()
    await superClient?.end()
    await container?.stop()
  })

  /** Run a callback within a transaction scoped to a community DID. */
  async function withCommunity<T>(
    communityDid: string,
    fn: (db: typeof appDb) => Promise<T>
  ): Promise<T> {
    return await appDb.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.current_community_did', ${communityDid}, true)`)
      return await fn(tx as unknown as typeof appDb)
    })
  }

  /**
   * Run a callback as superuser with no RLS filtering (aggregator mode).
   * In production, aggregator queries use a service role that bypasses RLS.
   */
  async function withoutCommunity<T>(fn: (db: typeof superDb) => Promise<T>): Promise<T> {
    return await fn(superDb)
  }

  describe('SELECT isolation', () => {
    it('community A session sees only community A topics', async () => {
      const rows = await withCommunity(COMMUNITY_A, (db) => db.select().from(schema.topics))

      expect(rows).toHaveLength(1)
      expect(rows[0].communityDid).toBe(COMMUNITY_A)
      expect(rows[0].title).toBe('Topic in A')
    })

    it('community B session sees only community B topics', async () => {
      const rows = await withCommunity(COMMUNITY_B, (db) => db.select().from(schema.topics))

      expect(rows).toHaveLength(1)
      expect(rows[0].communityDid).toBe(COMMUNITY_B)
      expect(rows[0].title).toBe('Topic in B')
    })

    it('community A session sees only community A replies', async () => {
      const rows = await withCommunity(COMMUNITY_A, (db) => db.select().from(schema.replies))

      expect(rows).toHaveLength(1)
      expect(rows[0].communityDid).toBe(COMMUNITY_A)
    })

    it('community B session sees only community B replies', async () => {
      const rows = await withCommunity(COMMUNITY_B, (db) => db.select().from(schema.replies))

      expect(rows).toHaveLength(1)
      expect(rows[0].communityDid).toBe(COMMUNITY_B)
    })

    it('community A session sees only community A categories', async () => {
      const rows = await withCommunity(COMMUNITY_A, (db) => db.select().from(schema.categories))

      expect(rows).toHaveLength(1)
      expect(rows[0].communityDid).toBe(COMMUNITY_A)
    })

    it('community A session sees only community A settings', async () => {
      const rows = await withCommunity(COMMUNITY_A, (db) =>
        db.select().from(schema.communitySettings)
      )

      expect(rows).toHaveLength(1)
      expect(rows[0].communityDid).toBe(COMMUNITY_A)
      expect(rows[0].communityName).toBe('Community A')
    })
  })

  describe('aggregator mode (empty session variable)', () => {
    it('sees topics from all communities', async () => {
      const rows = await withoutCommunity((db) => db.select().from(schema.topics))

      expect(rows).toHaveLength(2)
      const dids = rows.map((r) => r.communityDid).sort()
      expect(dids).toEqual([COMMUNITY_A, COMMUNITY_B])
    })

    it('sees replies from all communities', async () => {
      const rows = await withoutCommunity((db) => db.select().from(schema.replies))

      expect(rows).toHaveLength(2)
      const dids = rows.map((r) => r.communityDid).sort()
      expect(dids).toEqual([COMMUNITY_A, COMMUNITY_B])
    })

    it('sees categories from all communities', async () => {
      const rows = await withoutCommunity((db) => db.select().from(schema.categories))

      expect(rows).toHaveLength(2)
    })

    it('sees community settings from all communities', async () => {
      const rows = await withoutCommunity((db) => db.select().from(schema.communitySettings))

      expect(rows).toHaveLength(2)
    })
  })

  describe('INSERT isolation (withCheck)', () => {
    it('allows INSERT when communityDid matches session variable', async () => {
      await withCommunity(COMMUNITY_A, async (db) => {
        await db.insert(schema.categories).values({
          id: 'cat-a-2',
          slug: 'announcements',
          name: 'Announcements',
          communityDid: COMMUNITY_A,
        })
      })

      // Verify it was inserted
      const rows = await withCommunity(COMMUNITY_A, (db) => db.select().from(schema.categories))
      expect(rows.some((r) => r.slug === 'announcements')).toBe(true)
    })

    it('blocks INSERT when communityDid does not match session variable', async () => {
      try {
        await withCommunity(COMMUNITY_A, (db) =>
          db.insert(schema.categories).values({
            id: 'cat-x-1',
            slug: 'sneaky',
            name: 'Cross-tenant insert',
            communityDid: COMMUNITY_B, // Mismatch!
          })
        )
        expect.unreachable('INSERT should have been blocked by RLS')
      } catch (err) {
        // Drizzle wraps the PostgreSQL error; the RLS message is in the cause
        const message = String(err instanceof Error ? (err.cause ?? err).message : err)
        expect(message).toMatch(/row-level security/)
      }
    })

    it('blocks INSERT of topic with mismatched communityDid', async () => {
      try {
        await withCommunity(COMMUNITY_B, (db) =>
          db.insert(schema.topics).values({
            uri: 'at://did:plc:attacker/forum.barazo.topic/evil',
            rkey: 'evil',
            authorDid: 'did:plc:attacker',
            title: 'Cross-tenant topic',
            content: 'Should be blocked',
            category: 'general',
            communityDid: COMMUNITY_A, // Mismatch!
            cid: 'cid-evil',
            publishedAt: new Date(),
          })
        )
        expect.unreachable('INSERT should have been blocked by RLS')
      } catch (err) {
        const message = String(err instanceof Error ? (err.cause ?? err).message : err)
        expect(message).toMatch(/row-level security/)
      }
    })
  })

  describe('UPDATE isolation', () => {
    it('cannot update rows belonging to another community', async () => {
      // Try to update community B's topic while set as community A
      await withCommunity(COMMUNITY_A, async (db) => {
        const result = await db
          .update(schema.topics)
          .set({ title: 'Hijacked!' })
          .where(sql`uri = 'at://did:plc:user2/forum.barazo.topic/bbb'`)

        // RLS silently filters the WHERE clause, so 0 rows affected
        expect(result.length).toBe(0)
      })

      // Verify community B's topic is unchanged
      const rows = await withCommunity(COMMUNITY_B, (db) => db.select().from(schema.topics))
      expect(rows[0].title).toBe('Topic in B')
    })
  })

  describe('DELETE isolation', () => {
    it('cannot delete rows belonging to another community', async () => {
      // Try to delete community B's reply while set as community A
      await withCommunity(COMMUNITY_A, async (db) => {
        const result = await db
          .delete(schema.replies)
          .where(sql`uri = 'at://did:plc:user2/forum.barazo.reply/r-bbb'`)

        // RLS silently filters, 0 rows deleted
        expect(result.length).toBe(0)
      })

      // Verify community B's reply still exists
      const rows = await withCommunity(COMMUNITY_B, (db) => db.select().from(schema.replies))
      expect(rows).toHaveLength(1)
    })
  })
})
