import { randomUUID } from 'node:crypto'
import { eq, sql } from 'drizzle-orm'
import { communitySettings } from '../db/schema/community-settings.js'
import { communityOnboardingFields } from '../db/schema/onboarding-fields.js'
import { users } from '../db/schema/users.js'
import { pages } from '../db/schema/pages.js'
import { categories } from '../db/schema/categories.js'
import { topics } from '../db/schema/topics.js'
import { replies } from '../db/schema/replies.js'
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

      // Seed default pages (Terms of Service, Privacy Policy, Cookie Policy)
      const now = new Date()
      const pageDefaults = [
        {
          id: `page-${randomUUID()}`,
          slug: 'terms-of-service',
          title: 'Terms of service',
          content: TERMS_OF_SERVICE_CONTENT,
          status: 'published' as const,
          metaDescription: 'Terms and conditions for using this forum community.',
          parentId: null,
          sortOrder: 0,
          communityDid,
          createdAt: now,
          updatedAt: now,
        },
        {
          id: `page-${randomUUID()}`,
          slug: 'privacy-policy',
          title: 'Privacy policy',
          content: PRIVACY_POLICY_CONTENT,
          status: 'published' as const,
          metaDescription: 'How we collect, use, and protect your personal data.',
          parentId: null,
          sortOrder: 1,
          communityDid,
          createdAt: now,
          updatedAt: now,
        },
        {
          id: `page-${randomUUID()}`,
          slug: 'cookie-policy',
          title: 'Cookie policy',
          content: COOKIE_POLICY_CONTENT,
          status: 'published' as const,
          metaDescription: 'Information about the cookies used on this forum.',
          parentId: null,
          sortOrder: 2,
          communityDid,
          createdAt: now,
          updatedAt: now,
        },
        {
          id: `page-${randomUUID()}`,
          slug: 'accessibility',
          title: 'Accessibility statement',
          content: ACCESSIBILITY_CONTENT,
          status: 'published' as const,
          metaDescription:
            'Barazo is committed to WCAG 2.2 Level AA accessibility. Learn about our testing, standards, and how to report issues.',
          parentId: null,
          sortOrder: 3,
          communityDid,
          createdAt: now,
          updatedAt: now,
        },
      ]
      await db.insert(pages).values(pageDefaults)
      logger.info({ communityDid, pageCount: pageDefaults.length }, 'Default pages seeded')

      // Seed default categories with subcategories
      const catGeneral = `cat-${randomUUID()}`
      const catDev = `cat-${randomUUID()}`
      const catDevFrontend = `cat-${randomUUID()}`
      const catDevBackend = `cat-${randomUUID()}`
      const catDevDevops = `cat-${randomUUID()}`
      const catCommunity = `cat-${randomUUID()}`
      const catCommunityShowcase = `cat-${randomUUID()}`
      const catCommunityEvents = `cat-${randomUUID()}`
      const catFeedback = `cat-${randomUUID()}`
      const catFeedbackBugs = `cat-${randomUUID()}`
      const catFeedbackFeatures = `cat-${randomUUID()}`

      const categoryDefaults = [
        // Root categories
        {
          id: catGeneral,
          slug: 'general',
          name: 'General',
          description: 'Open discussion on any topic.',
          parentId: null,
          sortOrder: 0,
          communityDid,
          maturityRating: 'safe' as const,
          createdAt: now,
          updatedAt: now,
        },
        {
          id: catDev,
          slug: 'development',
          name: 'Development',
          description: 'Technical discussions about software development.',
          parentId: null,
          sortOrder: 1,
          communityDid,
          maturityRating: 'safe' as const,
          createdAt: now,
          updatedAt: now,
        },
        {
          id: catCommunity,
          slug: 'community',
          name: 'Community',
          description: 'Community news, events, and member introductions.',
          parentId: null,
          sortOrder: 2,
          communityDid,
          maturityRating: 'safe' as const,
          createdAt: now,
          updatedAt: now,
        },
        {
          id: catFeedback,
          slug: 'feedback',
          name: 'Feedback',
          description: 'Help us improve — report bugs and suggest features.',
          parentId: null,
          sortOrder: 3,
          communityDid,
          maturityRating: 'safe' as const,
          createdAt: now,
          updatedAt: now,
        },
        // Subcategories: Development
        {
          id: catDevFrontend,
          slug: 'frontend',
          name: 'Frontend',
          description: 'UI frameworks, CSS, accessibility, and browser APIs.',
          parentId: catDev,
          sortOrder: 0,
          communityDid,
          maturityRating: 'safe' as const,
          createdAt: now,
          updatedAt: now,
        },
        {
          id: catDevBackend,
          slug: 'backend',
          name: 'Backend',
          description: 'Servers, databases, APIs, and system design.',
          parentId: catDev,
          sortOrder: 1,
          communityDid,
          maturityRating: 'safe' as const,
          createdAt: now,
          updatedAt: now,
        },
        {
          id: catDevDevops,
          slug: 'devops',
          name: 'DevOps',
          description: 'CI/CD, containers, infrastructure, and deployment.',
          parentId: catDev,
          sortOrder: 2,
          communityDid,
          maturityRating: 'safe' as const,
          createdAt: now,
          updatedAt: now,
        },
        // Subcategories: Community
        {
          id: catCommunityShowcase,
          slug: 'showcase',
          name: 'Showcase',
          description: 'Share what you have built with the community.',
          parentId: catCommunity,
          sortOrder: 0,
          communityDid,
          maturityRating: 'safe' as const,
          createdAt: now,
          updatedAt: now,
        },
        {
          id: catCommunityEvents,
          slug: 'events',
          name: 'Events',
          description: 'Meetups, conferences, and community happenings.',
          parentId: catCommunity,
          sortOrder: 1,
          communityDid,
          maturityRating: 'safe' as const,
          createdAt: now,
          updatedAt: now,
        },
        // Subcategories: Feedback
        {
          id: catFeedbackBugs,
          slug: 'bugs',
          name: 'Bug Reports',
          description: 'Report issues so we can fix them.',
          parentId: catFeedback,
          sortOrder: 0,
          communityDid,
          maturityRating: 'safe' as const,
          createdAt: now,
          updatedAt: now,
        },
        {
          id: catFeedbackFeatures,
          slug: 'feature-requests',
          name: 'Feature Requests',
          description: 'Suggest new features or improvements.',
          parentId: catFeedback,
          sortOrder: 1,
          communityDid,
          maturityRating: 'safe' as const,
          createdAt: now,
          updatedAt: now,
        },
      ]

      await db.insert(categories).values(categoryDefaults)
      logger.info(
        { communityDid, categoryCount: categoryDefaults.length },
        'Default categories seeded'
      )

      // Seed demo topics and replies so the forum feels alive on first visit.
      // Uses the admin's DID as author. URIs use a synthetic namespace to avoid
      // collisions with real AT Protocol records from the firehose.
      const demoTopics = [
        {
          category: 'general',
          title: 'Welcome to the community!',
          content:
            'This is a brand new forum powered by the AT Protocol. Your identity is portable, your data is yours, and the community is decentralized.\n\nFeel free to introduce yourself and start a conversation.',
          tags: ['welcome', 'introduction'],
          replyContent:
            'Excited to be here! The AT Protocol integration is a great touch — portable identity is the future.',
        },
        {
          category: 'frontend',
          title: 'What frontend framework are you using?',
          content:
            'Curious what everyone is building with these days. React? Vue? Svelte? Something else entirely?\n\nBonus points if you can explain *why* you chose it over the alternatives.',
          tags: ['frontend', 'frameworks', 'discussion'],
          replyContent:
            'SolidJS for new projects, React for anything with a large ecosystem requirement. The signals model in Solid feels like the future of reactivity.',
        },
        {
          category: 'backend',
          title: 'Database migration strategies for zero-downtime deploys',
          content:
            'We have been running into issues with schema migrations that lock tables during deployment. Has anyone implemented a reliable expand-and-contract pattern?\n\nLooking for practical advice, not just theory.',
          tags: ['database', 'migrations', 'deployment'],
          replyContent:
            'The expand-contract pattern works well. Key insight: never rename columns in a single migration. Add the new column, backfill, switch reads, then drop the old one.',
        },
        {
          category: 'devops',
          title: 'Docker Compose vs Kubernetes for small teams',
          content:
            'Our team of 4 is debating whether to move from Docker Compose to Kubernetes. Current setup handles ~10k requests/day on a single VPS.\n\nIs K8s overkill at this scale? What would make you switch?',
          tags: ['docker', 'kubernetes', 'infrastructure'],
          replyContent:
            'At 10k req/day, Compose is perfectly fine. We made the switch at ~500k req/day when we needed auto-scaling and rolling deploys across multiple nodes.',
        },
        {
          category: 'showcase',
          title: 'Built a real-time markdown editor with AT Protocol sync',
          content:
            'Just finished a side project: a markdown editor that syncs documents to your PDS as AT Protocol records. Edits propagate in real-time via the firehose.\n\nSource is on GitHub — feedback welcome!',
          tags: ['atproto', 'project', 'open-source'],
          replyContent:
            'This is impressive. How do you handle conflict resolution when two clients edit the same document simultaneously?',
        },
        {
          category: 'bugs',
          title: '[Example] How to write a good bug report',
          content:
            'A good bug report includes:\n\n1. **What you expected** to happen\n2. **What actually happened** (screenshots help!)\n3. **Steps to reproduce** the issue\n4. **Environment details** — browser, OS, screen size\n\nThe more detail you provide, the faster we can fix it.',
          tags: ['meta', 'guide'],
          replyContent:
            'Adding browser console output (F12 → Console tab) is also incredibly helpful for tracking down frontend issues.',
        },
        {
          category: 'feature-requests',
          title: '[Example] Dark mode toggle in user preferences',
          content:
            'It would be great to have a dark mode option in user settings. Currently the theme follows the system preference, but I would like to override it per-forum.\n\n**Use case:** I prefer dark mode at night but light mode during the day, and my system setting does not auto-switch.',
          tags: ['ux', 'accessibility', 'theming'],
          replyContent:
            'Strong support for this. A three-way toggle (Light / Dark / System) is the standard pattern. Could even store the preference in the PDS for cross-forum portability.',
        },
      ]

      const topicValues = demoTopics.map((t, i) => {
        const rkey = `seed${String(i + 1).padStart(3, '0')}`
        return {
          uri: `at://${did}/forum.barazo.topic.post/${rkey}`,
          rkey,
          authorDid: did,
          title: t.title,
          content: t.content,
          contentFormat: null,
          category: t.category,
          tags: t.tags,
          communityDid,
          cid: `bafyreiseed${String(i + 1).padStart(3, '0')}`,
          replyCount: 1,
          reactionCount: 0,
          voteCount: 0,
          lastActivityAt: now,
          createdAt: now,
          indexedAt: now,
          isLocked: false,
          isPinned: i === 0,
          isModDeleted: false,
          isAuthorDeleted: false,
          moderationStatus: 'approved' as const,
          trustStatus: 'trusted' as const,
        }
      })

      await db.insert(topics).values(topicValues)

      const replyValues = demoTopics.map((t, i) => {
        const topicRkey = `seed${String(i + 1).padStart(3, '0')}`
        const topicUri = `at://${did}/forum.barazo.topic.post/${topicRkey}`
        const topicCid = `bafyreiseed${String(i + 1).padStart(3, '0')}`
        const replyRkey = `seedreply${String(i + 1).padStart(3, '0')}`
        return {
          uri: `at://${did}/forum.barazo.topic.reply/${replyRkey}`,
          rkey: replyRkey,
          authorDid: did,
          content: t.replyContent,
          contentFormat: null,
          rootUri: topicUri,
          rootCid: topicCid,
          parentUri: topicUri,
          parentCid: topicCid,
          communityDid,
          cid: `bafyreiseedreply${String(i + 1).padStart(3, '0')}`,
          reactionCount: 0,
          voteCount: 0,
          depth: 1,
          createdAt: now,
          indexedAt: now,
          isAuthorDeleted: false,
          isModDeleted: false,
          moderationStatus: 'approved' as const,
          trustStatus: 'trusted' as const,
        }
      })

      await db.insert(replies).values(replyValues)
      logger.info(
        { communityDid, topicCount: topicValues.length, replyCount: replyValues.length },
        'Demo content seeded'
      )

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

// ---------------------------------------------------------------------------
// Default page content (markdown)
// ---------------------------------------------------------------------------

const TERMS_OF_SERVICE_CONTENT = `## Acceptance of terms

By accessing or using Barazo, you agree to be bound by these Terms of Service. If you do not agree to these terms, you may not use the service. Barazo reserves the right to update these terms at any time, with notice provided through the platform.

## Eligibility

You must be at least 16 years old to use Barazo (in accordance with the Dutch implementation of GDPR, UAVG). By using the service, you confirm that you meet this age requirement. Access to mature content may require additional age verification as required by applicable law.

## Account and authentication

Barazo uses the AT Protocol for authentication. You log in using your existing AT Protocol identity (e.g., a Bluesky account). You are responsible for maintaining the security of your AT Protocol account. Barazo does not store your password.

## Content and conduct

You retain ownership of content you post on Barazo. By posting, you grant Barazo a license to display, index, and distribute your content as part of the forum service and via the AT Protocol.

You agree not to post content that:

- Violates applicable laws or regulations.
- Infringes on the intellectual property rights of others.
- Contains spam, malware, or deceptive content.
- Harasses, threatens, or promotes violence against individuals or groups.
- Contains child sexual abuse material (CSAM).

Community administrators may enforce additional content policies specific to their community. Repeated violations may result in content removal, account restrictions, or bans.

## Content maturity ratings

Communities and categories may be rated for content maturity (Safe for Work, Mature, or Adult). You are responsible for accurately labeling your content. Communities may require age verification to access mature content. New accounts default to safe-mode with mature content hidden.

## Cross-posting

Barazo may cross-post your content to connected platforms (such as Bluesky or Frontpage) when you enable this feature. Cross-posting is optional and can be controlled in your settings. Cross-posted content is subject to the terms of the destination platform.

## Moderation and labels

Your account may be labeled by independent moderation services (such as Bluesky's Ozone). Labels affect posting limits and content visibility. You cannot delete labels applied by labeler services, but you can dispute inaccuracies by contacting us or the labeler service. Community administrators may also apply local moderation overrides.

## AI-generated summaries

Barazo may generate AI-powered summaries of discussion threads. These summaries are anonymized derivative works that do not contain personal data (no usernames or verbatim quotes). AI summaries may persist after individual content is deleted, as they are regenerated from remaining content. Community administrators can disable summary preservation.

## AT Protocol and federation

Barazo is built on the AT Protocol, which is a federated, open network. Content you post may be indexed by other services on the AT Protocol network. Barazo cannot control how third-party services handle your data once it is published via the protocol.

## Termination

Barazo may suspend or terminate your access if you violate these terms. You may stop using the service at any time. Deleting your AT Protocol account or content will trigger removal of indexed data from Barazo (see our Privacy Policy for details).

## Limitation of liability

Barazo is provided "as is" without warranties of any kind. We are not liable for any damages arising from your use of the service, including but not limited to loss of data, service interruptions, or actions taken by community moderators or administrators.

## Governing law

These terms are governed by the laws of the Netherlands. Any disputes arising from these terms will be subject to the exclusive jurisdiction of the courts of the Netherlands.

*These terms were last updated on February 2026.*`

const PRIVACY_POLICY_CONTENT = `## Overview

Barazo is committed to protecting your privacy. This policy explains what personal data we collect, why we collect it, how long we keep it, and what rights you have. Barazo is operated from the Netherlands and complies with the General Data Protection Regulation (GDPR).

## What we collect

When you use Barazo, we process the following data:

- **AT Protocol identifiers** -- your DID (decentralized identifier) and handle, used to identify your account.
- **Profile information** -- display name and profile data retrieved from your AT Protocol PDS.
- **Content** -- posts, replies, and reactions you create on the forum, indexed from the AT Protocol firehose.
- **IP addresses** -- collected for API rate limiting and security purposes.
- **Authentication cookie** -- a single HTTP-only, Secure, SameSite=Strict refresh token cookie used to maintain your session. Access tokens are held in memory only and never stored in cookies or browser storage.
- **Moderation records** -- actions taken by moderators on your content or account.
- **Age declaration** -- stored in the forum database only (deliberately kept off your PDS to avoid broadcasting age data on a public network).
- **Per-community preferences** -- notification settings and content maturity overrides, stored locally in the forum database (not on your PDS) to protect your browsing patterns.

## What we do not collect

- We do not collect or store your password (authentication is handled via AT Protocol OAuth).
- We do not collect email addresses unless provided by a community admin for billing.
- We do not collect payment card details (processed by our payment provider).
- We do not use tracking cookies or analytics that profile your behavior.
- We do not use device fingerprinting.
- We do not load third-party trackers, pixels, or analytics scripts.

## Legal basis

We process your data under the following legal bases (GDPR Art. 6):

- **Contract performance** -- processing necessary to provide the forum service you signed up for.
- **Legitimate interest** -- indexing public AT Protocol content, spam prevention, platform security, content moderation, and AI-generated discussion summaries.

## Data storage and transfers

Our servers are hosted in the European Union (Hetzner, Germany). We use the following sub-processors:

- Hetzner (EU) -- hosting infrastructure.
- Bunny.net (EU, Slovenia) -- content delivery network.
- Stripe (EU-US Data Privacy Framework certified) -- payment processing.

A full sub-processor list is maintained at **barazo.forum/legal/sub-processors**.

## Data retention and deletion

Your indexed data is retained while the source exists on your AT Protocol PDS. When you delete content or your account via the AT Protocol, we process the deletion event immediately:

- Your post is removed from public view and replaced with a "deleted by author" notice.
- Your personal data (DID, handle, AT Protocol URI) is stripped from the database record.
- The anonymized content (with no link to your identity) may be retained to preserve community knowledge and enable AI-generated discussion summaries. This anonymized data falls outside GDPR scope (Recital 26) because it can no longer identify you.

You may request full content deletion (including anonymized content) by contacting us directly, independent of AT Protocol signals. We respond to deletion requests within one month (GDPR Art. 12(3)).

Barazo cannot guarantee deletion from external systems such as AT Protocol relays, other AppViews, search engine caches, or web archives. Our reasonable steps include: propagating AT Protocol delete events, submitting Google Search Console removal requests for deleted content URLs, and documenting which systems confirmed deletion.

## AI features

Barazo offers optional AI features including thread summaries, semantic search, and content moderation assistance. Here is how they work:

- **No training on your content.** We do not use member posts to train AI models, and we do not provide member content to others for training.
- **Local-first processing.** The default AI configuration uses local inference (Ollama) -- your content never leaves the server. Your forum administrator may choose a different AI provider; in that case, content is sent to that provider for processing.
- **Anonymized summaries.** AI-generated thread summaries are designed to exclude usernames, handles, and verbatim quotes. Summaries capture the discussion's substance, not who said what. Summaries may persist after individual content deletion because they contain no personal data.

## Content labels

We subscribe to content labeling services (such as Bluesky's Ozone) for spam detection and content moderation. Labels applied to your account may affect posting limits and content visibility. Labels are stored by the labeler service, not on your PDS. You can dispute labels by contacting us.

## Your rights

Under the GDPR, you have the right to:

- Access the personal data we hold about you.
- Rectify inaccurate data.
- Request erasure of your data (right to be forgotten).
- Object to processing based on legitimate interest.
- Data portability (built into the AT Protocol).
- Lodge a complaint with the Dutch Data Protection Authority (Autoriteit Persoonsgegevens).

To exercise these rights, contact us through our [GitHub issue tracker](https://github.com/barazo-forum/barazo-workspace/issues) or via the contact details provided by your community administrator.

## Data breach notification

In the event of a data breach, we will notify the Dutch Data Protection Authority within 72 hours (GDPR Art. 33). For high-risk breaches, we will notify affected users without undue delay via AT Protocol notifications and public announcements.

*This policy was last updated on February 2026.*`

const COOKIE_POLICY_CONTENT = `## Overview

Barazo uses a minimal number of cookies. We do not use tracking cookies, advertising cookies, or third-party analytics cookies. This page explains the cookies we do use and why.

## Cookies we use

Barazo uses a single essential cookie:

| Cookie | Purpose | Duration | Type |
|--------|---------|----------|------|
| Refresh token | Keeps you logged in across page reloads by enabling silent access token renewal. | Session | Essential |

## Technical details

The refresh token cookie has the following security properties:

- **HTTP-only** -- the cookie is not accessible to JavaScript, preventing cross-site scripting (XSS) attacks.
- **Secure** -- the cookie is only sent over HTTPS connections.
- **SameSite=Strict** -- the cookie is not sent with cross-site requests, preventing cross-site request forgery (CSRF) attacks.

Access tokens (used to authenticate API requests) are held in memory only and are never stored in cookies, localStorage, or sessionStorage.

## What we do not use

- No tracking or advertising cookies.
- No third-party analytics (Google Analytics, etc.).
- No social media tracking pixels.
- No fingerprinting or behavioral profiling.

## Cookie consent

Because we only use a single essential cookie required for the service to function, a cookie consent banner is not required under the ePrivacy Directive (EU Directive 2002/58/EC, Art. 5(3)). Essential cookies that are strictly necessary for the service requested by the user are exempt from the consent requirement.

## Theme preference

Your light/dark mode preference is stored in localStorage (not a cookie). This is a client-side preference that is never sent to our servers.

*This policy was last updated on February 2026.*`

const ACCESSIBILITY_CONTENT = `## Our commitment

Barazo is committed to ensuring digital accessibility for people with disabilities. We continually improve the user experience for everyone and apply the relevant accessibility standards.

## Conformance status

We aim to conform to the **Web Content Accessibility Guidelines (WCAG) 2.2 Level AA**. These guidelines explain how to make web content more accessible to people with a wide range of disabilities.

## Testing methods

We test accessibility through a combination of methods:

- **Automated testing** using axe-core and ESLint accessibility rules in our continuous integration pipeline.
- **Keyboard navigation** testing to ensure all interactive elements are reachable and operable without a mouse.
- **Screen reader** testing with VoiceOver to verify content is properly announced and navigable.
- **Lighthouse audits** targeting an accessibility score of 95 or higher on all page types.

## Accessibility features

- Semantic HTML with proper heading hierarchy and landmark regions.
- Skip links for jumping to main content and the reply editor.
- Keyboard-accessible controls with visible focus indicators.
- ARIA attributes for dynamic content, dialogs, and tab patterns.
- Color contrast meeting WCAG AA requirements in both light and dark themes.
- Pagination as the default for content lists (no infinite scroll).
- Respects reduced motion preferences via prefers-reduced-motion.

## Known limitations

While we strive for full accessibility, some areas may have limitations:

- User-generated content may not always meet accessibility standards (e.g., images without alt text in posts).
- Third-party embeds and plugins may have their own accessibility limitations.

## Contact us

If you encounter accessibility barriers on Barazo, please contact us. We take accessibility feedback seriously and will work to address issues promptly.

You can report accessibility issues through our [GitHub issue tracker](https://github.com/barazo-forum/barazo-web/issues). Please include the page URL, a description of the issue, and the assistive technology you are using.

*This statement was last updated on February 2026.*`
