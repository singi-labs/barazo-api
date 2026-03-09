<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/singi-labs/.github/main/assets/logo-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/singi-labs/.github/main/assets/logo-light.svg">
  <img alt="Barazo Logo" src="https://raw.githubusercontent.com/singi-labs/.github/main/assets/logo-dark.svg" width="120">
</picture>

# Barazo API

**AT Protocol AppView backend for federated forums -- portable identity, user data ownership, cross-community reputation.**

[![Status: Alpha](https://img.shields.io/badge/status-alpha-orange)]()
[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL%203.0-blue.svg)](https://opensource.org/licenses/AGPL-3.0)
[![CI](https://github.com/singi-labs/barazo-api/actions/workflows/ci.yml/badge.svg)](https://github.com/singi-labs/barazo-api/actions/workflows/ci.yml)
[![Node.js](https://img.shields.io/badge/node-24%20LTS-brightgreen)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/typescript-5.x-blue)](https://www.typescriptlang.org/)

</div>

---

## Overview

The AppView backend for Barazo forums. Handles authentication, forum CRUD, firehose indexing, moderation, search, and cross-posting -- all built on the AT Protocol. Communicates with any compatible frontend via REST API. Runs as a single-community forum or a global aggregator indexing all Barazo communities network-wide.

---

## Tech Stack

| Component  | Technology                                                     |
| ---------- | -------------------------------------------------------------- |
| Runtime    | Node.js 24 LTS / TypeScript (strict mode)                      |
| Framework  | Fastify 5                                                      |
| Protocol   | @atproto/api, @atproto/oauth-client-node, @atproto/tap         |
| Database   | PostgreSQL 16 + pgvector (Drizzle ORM, Drizzle Kit migrations) |
| Cache      | Valkey (via ioredis)                                           |
| Validation | Zod 4                                                          |
| Testing    | Vitest 4 + Supertest + Testcontainers                          |
| Logging    | Pino (structured)                                              |
| Monitoring | GlitchTip (self-hosted, Sentry SDK-compatible)                 |
| Security   | Helmet + DOMPurify + rate limiting + CSP/HSTS                  |
| API docs   | @fastify/swagger + Scalar                                      |

---

## Route Modules

15 route modules across 74 source files:

| Module         | File                | Functionality                                                                                                            |
| -------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Auth           | `auth.ts`           | AT Protocol OAuth sign-in with any PDS                                                                                   |
| OAuth Metadata | `oauth-metadata.ts` | OAuth discovery metadata endpoint                                                                                        |
| Health         | `health.ts`         | Health check                                                                                                             |
| Topics         | `topics.ts`         | CRUD, sorting (chronological / reactions / trending), cross-posting to Bluesky + Frontpage, self-labels                  |
| Replies        | `replies.ts`        | CRUD threaded replies, self-labels                                                                                       |
| Categories     | `categories.ts`     | CRUD with maturity ratings (SFW / Mature / Adult), parent-child hierarchy                                                |
| Reactions      | `reactions.ts`      | Configurable reaction types per community                                                                                |
| Search         | `search.ts`         | Full-text search (PostgreSQL tsvector + GIN index), optional semantic search via `EMBEDDING_URL`                         |
| Profiles       | `profiles.ts`       | User profiles with PDS sync, cross-community reputation, age declaration                                                 |
| Notifications  | `notifications.ts`  | In-app and email notification system                                                                                     |
| Moderation     | `moderation.ts`     | Lock, pin, delete, ban, content reporting, first-post queue, word/phrase blocklists, link spam detection, mod action log |
| Admin Settings | `admin-settings.ts` | Community settings, maturity rating, branding, jurisdiction + age threshold configuration                                |
| Block / Mute   | `block-mute.ts`     | Block and mute users (portable via PDS records)                                                                          |
| Onboarding     | `onboarding.ts`     | Admin-configurable community onboarding fields, user response submission and status tracking                             |
| Setup          | `setup.ts`          | Initial community setup wizard                                                                                           |

---

## Database Schema

15 schema modules (Drizzle ORM):

| Schema                  | Purpose                                                  |
| ----------------------- | -------------------------------------------------------- |
| `users.ts`              | User accounts synced from PDS                            |
| `topics.ts`             | Forum topics with maturity, self-labels                  |
| `replies.ts`            | Threaded replies                                         |
| `categories.ts`         | Category hierarchy with maturity ratings                 |
| `reactions.ts`          | Reaction records                                         |
| `reports.ts`            | Content reports                                          |
| `notifications.ts`      | Notification records                                     |
| `moderation-actions.ts` | Moderation action log                                    |
| `cross-posts.ts`        | Bluesky + Frontpage cross-post tracking                  |
| `community-settings.ts` | Per-community configuration, jurisdiction, age threshold |
| `user-preferences.ts`   | Global and per-community user preferences                |
| `onboarding-fields.ts`  | Admin-defined onboarding fields and user responses       |
| `tracked-repos.ts`      | AT Protocol repo tracking state                          |
| `firehose.ts`           | Firehose cursor and subscription state                   |
| `index.ts`              | Schema barrel export                                     |

---

## Features

**AT Protocol integration:**

- OAuth authentication with any AT Protocol PDS
- Firehose subscription via Tap, filtered for `forum.barazo.*` collections
- Record validation (Zod) before indexing
- Portable block/mute records stored on user PDS
- Cross-posting to Bluesky (default on, toggleable per topic) and Frontpage (feature flag)
- Cross-post deletion lifecycle (topic delete cascades to cross-posts)
- Rich OpenGraph images for cross-posts (forum branding, topic title, category)
- Self-labels on topics and replies
- Two operating modes: single-forum or global aggregator (`COMMUNITY_MODE=global`)

**Forum core:**

- Topics CRUD with sorting (chronological, reactions, trending)
- Threaded replies CRUD
- Categories with parent-child hierarchy and per-category maturity ratings
- Configurable reaction types per community
- Full-text search (PostgreSQL tsvector + GIN index)
- Optional semantic search (pgvector, activated by `EMBEDDING_URL`)
- In-app and email notifications
- User profiles with PDS sync
- Cross-community reputation (activity counts across forums)
- User preferences (global and per-community)

**Content maturity and age gating:**

- Three-tier content maturity system: SFW, Mature, Adult
- Maturity ratings at both forum and category level
- Content maturity filtering based on user age declaration
- Age declaration as numeric value with jurisdiction-aware thresholds
- Admin-configurable jurisdiction country and age threshold

**Moderation:**

- Content reporting system
- First-post moderation queue
- Word and phrase blocklists
- Link spam detection
- Topic lock, pin, and delete
- User bans
- Moderation action log
- GDPR-compliant account deletion (identity event handling)

**Community administration:**

- Admin settings panel (name, description, branding, colors)
- Community setup wizard
- Admin-configurable onboarding fields (text, select, checkbox, etc.)
- User onboarding response submission and completion tracking
- Jurisdiction and age threshold configuration

**Plugin system:**

- Plugin-aware route architecture across all modules

**Security:**

- Zod validation on all API endpoints
- DOMPurify output sanitization on all user-generated content
- Helmet security headers (CSP, HSTS)
- Rate limiting on all endpoints
- Pino structured logging (no `console.log`)
- Sentry-compatible error monitoring (GlitchTip)

---

## Planned Features

- Semantic search activation (pgvector hybrid ranking) -- infrastructure installed, not yet wired
- AI-assisted moderation (spam and toxicity flagging)
- Stripe billing integration (P3)
- Multi-tenant SaaS management endpoints (P3)
- AT Protocol labeler integration (P4)
- Migration API endpoints (P5)
- Private categories (P4)
- Solved/accepted answer markers (P4)

---

## API Documentation

When running, interactive API docs are available at:

- **Local:** `http://localhost:3000/docs`
- **Production:** `https://api.barazo.forum/docs`

OpenAPI spec: `GET /api/openapi.json`

---

## Quick Start

**Prerequisites:** Node.js 24 LTS, pnpm, Docker + Docker Compose, AT Protocol PDS access (Bluesky or self-hosted).

```bash
git clone https://github.com/singi-labs/barazo-api.git
cd barazo-api
pnpm install

# Start PostgreSQL + Valkey
docker compose -f docker-compose.dev.yml up -d

# Configure environment
cp .env.example .env
# Edit .env with your settings

# Run development server
pnpm dev
```

---

## Development

```bash
pnpm test           # Run all tests
pnpm test:watch     # Watch mode
pnpm test:coverage  # With coverage report
pnpm lint           # ESLint
pnpm typecheck      # TypeScript strict mode check
```

See [CONTRIBUTING.md](https://github.com/singi-labs/.github/blob/main/CONTRIBUTING.md) for branching strategy, commit format, and code review process.

**Key standards:**

- TypeScript strict mode (no `any`, no `@ts-ignore`)
- All endpoints validate input with Zod schemas
- All user content sanitized with DOMPurify
- Test-driven development (tests written before implementation)
- Conventional commits enforced (`type(scope): description`)

---

## Deployment

```bash
docker pull ghcr.io/singi-labs/barazo-api:latest
```

See [barazo-deploy](https://github.com/singi-labs/barazo-deploy) for full deployment templates.

---

## Related Repositories

| Repository                                                         | Description                                   | License |
| ------------------------------------------------------------------ | --------------------------------------------- | ------- |
| [barazo-web](https://github.com/singi-labs/barazo-web)           | Forum frontend (Next.js, Tailwind)            | MIT     |
| [barazo-lexicons](https://github.com/singi-labs/barazo-lexicons) | AT Protocol lexicon schemas + generated types | MIT     |
| [barazo-deploy](https://github.com/singi-labs/barazo-deploy)     | Docker Compose deployment templates           | MIT     |
| [barazo-website](https://github.com/singi-labs/barazo-website)   | Marketing + documentation site                | MIT     |

---

## Community

- **Website:** [barazo.forum](https://barazo.forum)
- **Discussions:** [GitHub Discussions](https://github.com/orgs/singi-labs/discussions)
- **Issues:** [Report bugs](https://github.com/singi-labs/barazo-api/issues)

---

## License

**AGPL-3.0** -- Server-side copyleft. Anyone running a modified version as a hosted service must share their changes.

See [LICENSE](LICENSE) for full terms.

---

Made with ♥ in 🇪🇺 by [Singi Labs](https://singi.dev)
