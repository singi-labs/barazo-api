import { describe, it, expect } from 'vitest'
import { envSchema, parseEnv, getCommunityDid } from '../../../src/config/env.js'
import type { Env } from '../../../src/config/env.js'

describe('envSchema', () => {
  const validEnv = {
    DATABASE_URL: 'postgresql://barazo:barazo_dev@localhost:5432/barazo',
    VALKEY_URL: 'redis://localhost:6379',
    TAP_URL: 'http://localhost:2480',
    TAP_ADMIN_PASSWORD: 'tap_dev_secret',
    OAUTH_CLIENT_ID:
      'http://localhost?redirect_uri=http%3A%2F%2F127.0.0.1%3A3000%2Fapi%2Fauth%2Fcallback',
    OAUTH_REDIRECT_URI: 'http://127.0.0.1:3000/api/auth/callback',
    SESSION_SECRET: 'a-very-long-session-secret-that-is-at-least-32-characters',
    AI_ENCRYPTION_KEY: 'a-very-long-encryption-key-that-is-at-least-32-characters',
    HOST: '0.0.0.0',
    PORT: '3000',
    LOG_LEVEL: 'info',
    CORS_ORIGINS: 'http://localhost:3001',
    COMMUNITY_MODE: 'single',
    COMMUNITY_DID: 'did:plc:testcommunity123',
  }

  it('parses valid environment variables', () => {
    const result = envSchema.safeParse(validEnv)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.PORT).toBe(3000)
      expect(result.data.LOG_LEVEL).toBe('info')
      expect(result.data.COMMUNITY_MODE).toBe('single')
    }
  })

  it('rejects missing DATABASE_URL', () => {
    const { DATABASE_URL: _, ...env } = validEnv
    const result = envSchema.safeParse(env)
    expect(result.success).toBe(false)
  })

  it('rejects missing VALKEY_URL', () => {
    const { VALKEY_URL: _, ...env } = validEnv
    const result = envSchema.safeParse(env)
    expect(result.success).toBe(false)
  })

  it('rejects missing TAP_URL', () => {
    const { TAP_URL: _, ...env } = validEnv
    const result = envSchema.safeParse(env)
    expect(result.success).toBe(false)
  })

  it('rejects missing TAP_ADMIN_PASSWORD', () => {
    const { TAP_ADMIN_PASSWORD: _, ...env } = validEnv
    const result = envSchema.safeParse(env)
    expect(result.success).toBe(false)
  })

  it('rejects missing OAUTH_CLIENT_ID', () => {
    const { OAUTH_CLIENT_ID: _, ...env } = validEnv
    const result = envSchema.safeParse(env)
    expect(result.success).toBe(false)
  })

  it('rejects missing OAUTH_REDIRECT_URI', () => {
    const { OAUTH_REDIRECT_URI: _, ...env } = validEnv
    const result = envSchema.safeParse(env)
    expect(result.success).toBe(false)
  })

  it('rejects missing SESSION_SECRET', () => {
    const { SESSION_SECRET: _, ...env } = validEnv
    const result = envSchema.safeParse(env)
    expect(result.success).toBe(false)
  })

  it('rejects SESSION_SECRET shorter than 32 characters', () => {
    const result = envSchema.safeParse({
      ...validEnv,
      SESSION_SECRET: 'too-short',
    })
    expect(result.success).toBe(false)
  })

  it('accepts SESSION_SECRET of exactly 32 characters', () => {
    const result = envSchema.safeParse({
      ...validEnv,
      SESSION_SECRET: 'a'.repeat(32),
    })
    expect(result.success).toBe(true)
  })

  it('applies default values for optional fields', () => {
    const result = envSchema.safeParse({
      DATABASE_URL: validEnv.DATABASE_URL,
      VALKEY_URL: validEnv.VALKEY_URL,
      TAP_URL: validEnv.TAP_URL,
      TAP_ADMIN_PASSWORD: validEnv.TAP_ADMIN_PASSWORD,
      OAUTH_CLIENT_ID: validEnv.OAUTH_CLIENT_ID,
      OAUTH_REDIRECT_URI: validEnv.OAUTH_REDIRECT_URI,
      SESSION_SECRET: validEnv.SESSION_SECRET,
      AI_ENCRYPTION_KEY: validEnv.AI_ENCRYPTION_KEY,
      COMMUNITY_DID: validEnv.COMMUNITY_DID,
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.HOST).toBe('0.0.0.0')
      expect(result.data.PORT).toBe(3000)
      expect(result.data.LOG_LEVEL).toBe('info')
      expect(result.data.CORS_ORIGINS).toBe('http://localhost:3001')
      expect(result.data.COMMUNITY_MODE).toBe('single')
      expect(result.data.RATE_LIMIT_AUTH).toBe(10)
      expect(result.data.RATE_LIMIT_WRITE).toBe(10)
      expect(result.data.RATE_LIMIT_READ_ANON).toBe(100)
      expect(result.data.RATE_LIMIT_READ_AUTH).toBe(300)
      expect(result.data.OAUTH_SESSION_TTL).toBe(604800)
      expect(result.data.OAUTH_ACCESS_TOKEN_TTL).toBe(900)
    }
  })

  it('rejects invalid PORT (non-numeric)', () => {
    const result = envSchema.safeParse({ ...validEnv, PORT: 'abc' })
    expect(result.success).toBe(false)
  })

  it('rejects invalid COMMUNITY_MODE', () => {
    const result = envSchema.safeParse({
      ...validEnv,
      COMMUNITY_MODE: 'invalid',
    })
    expect(result.success).toBe(false)
  })

  it('accepts multi COMMUNITY_MODE', () => {
    const result = envSchema.safeParse({
      ...validEnv,
      COMMUNITY_MODE: 'multi',
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.COMMUNITY_MODE).toBe('multi')
    }
  })

  it('accepts optional GLITCHTIP_DSN', () => {
    const result = envSchema.safeParse({
      ...validEnv,
      GLITCHTIP_DSN: 'https://key@glitchtip.example.com/1',
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.GLITCHTIP_DSN).toBe('https://key@glitchtip.example.com/1')
    }
  })

  it('accepts optional EMBEDDING_URL', () => {
    const result = envSchema.safeParse({
      ...validEnv,
      EMBEDDING_URL: 'https://api.openrouter.ai/v1/embeddings',
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.EMBEDDING_URL).toBe('https://api.openrouter.ai/v1/embeddings')
    }
  })

  it('parses OAUTH_SESSION_TTL from string to number', () => {
    const result = envSchema.safeParse({
      ...validEnv,
      OAUTH_SESSION_TTL: '86400',
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.OAUTH_SESSION_TTL).toBe(86400)
    }
  })

  it('rejects non-positive OAUTH_SESSION_TTL', () => {
    const result = envSchema.safeParse({
      ...validEnv,
      OAUTH_SESSION_TTL: '0',
    })
    expect(result.success).toBe(false)
  })

  it('rejects non-integer OAUTH_SESSION_TTL', () => {
    const result = envSchema.safeParse({
      ...validEnv,
      OAUTH_SESSION_TTL: '3.5',
    })
    expect(result.success).toBe(false)
  })

  it('parses OAUTH_ACCESS_TOKEN_TTL from string to number', () => {
    const result = envSchema.safeParse({
      ...validEnv,
      OAUTH_ACCESS_TOKEN_TTL: '1800',
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.OAUTH_ACCESS_TOKEN_TTL).toBe(1800)
    }
  })

  it('rejects non-positive OAUTH_ACCESS_TOKEN_TTL', () => {
    const result = envSchema.safeParse({
      ...validEnv,
      OAUTH_ACCESS_TOKEN_TTL: '-1',
    })
    expect(result.success).toBe(false)
  })
})

describe('COMMUNITY_DID validation', () => {
  const baseEnv = {
    DATABASE_URL: 'postgresql://barazo:barazo_dev@localhost:5432/barazo',
    VALKEY_URL: 'redis://localhost:6379',
    TAP_URL: 'http://localhost:2480',
    TAP_ADMIN_PASSWORD: 'tap_dev_secret',
    OAUTH_CLIENT_ID:
      'http://localhost?redirect_uri=http%3A%2F%2F127.0.0.1%3A3000%2Fapi%2Fauth%2Fcallback',
    OAUTH_REDIRECT_URI: 'http://127.0.0.1:3000/api/auth/callback',
    SESSION_SECRET: 'a-very-long-session-secret-that-is-at-least-32-characters',
    AI_ENCRYPTION_KEY: 'a-very-long-encryption-key-that-is-at-least-32-characters',
  }

  it('rejects single mode without COMMUNITY_DID', () => {
    const result = envSchema.safeParse({
      ...baseEnv,
      COMMUNITY_MODE: 'single',
    })
    expect(result.success).toBe(false)
  })

  it('accepts single mode with COMMUNITY_DID', () => {
    const result = envSchema.safeParse({
      ...baseEnv,
      COMMUNITY_MODE: 'single',
      COMMUNITY_DID: 'did:plc:testcommunity',
    })
    expect(result.success).toBe(true)
  })

  it('accepts multi mode without COMMUNITY_DID', () => {
    const result = envSchema.safeParse({
      ...baseEnv,
      COMMUNITY_MODE: 'multi',
    })
    expect(result.success).toBe(true)
  })

  it('rejects default mode (single) without COMMUNITY_DID', () => {
    const result = envSchema.safeParse(baseEnv)
    expect(result.success).toBe(false)
  })
})

describe('getCommunityDid', () => {
  it('returns COMMUNITY_DID when set', () => {
    const env = { COMMUNITY_DID: 'did:plc:test123' } as Env
    expect(getCommunityDid(env)).toBe('did:plc:test123')
  })

  it('throws when COMMUNITY_DID is undefined', () => {
    const env = { COMMUNITY_DID: undefined } as Env
    expect(() => getCommunityDid(env)).toThrow('COMMUNITY_DID is required')
  })
})

describe('AI_ENCRYPTION_KEY validation', () => {
  const baseEnv = {
    DATABASE_URL: 'postgresql://barazo:barazo_dev@localhost:5432/barazo',
    VALKEY_URL: 'redis://localhost:6379',
    TAP_URL: 'http://localhost:2480',
    TAP_ADMIN_PASSWORD: 'tap_dev_secret',
    OAUTH_CLIENT_ID:
      'http://localhost?redirect_uri=http%3A%2F%2F127.0.0.1%3A3000%2Fapi%2Fauth%2Fcallback',
    OAUTH_REDIRECT_URI: 'http://127.0.0.1:3000/api/auth/callback',
    SESSION_SECRET: 'a-very-long-session-secret-that-is-at-least-32-characters',
    COMMUNITY_DID: 'did:plc:testcommunity123',
    AI_ENCRYPTION_KEY: 'a'.repeat(32),
  }

  it('rejects missing AI_ENCRYPTION_KEY', () => {
    const { AI_ENCRYPTION_KEY: _, ...env } = baseEnv
    const result = envSchema.safeParse(env)
    expect(result.success).toBe(false)
  })

  it('rejects AI_ENCRYPTION_KEY shorter than 32 characters', () => {
    const result = envSchema.safeParse({
      ...baseEnv,
      AI_ENCRYPTION_KEY: 'too-short',
    })
    expect(result.success).toBe(false)
  })

  it('accepts AI_ENCRYPTION_KEY of exactly 32 characters', () => {
    const result = envSchema.safeParse({
      ...baseEnv,
      AI_ENCRYPTION_KEY: 'a'.repeat(32),
    })
    expect(result.success).toBe(true)
  })

  it('accepts AI_ENCRYPTION_KEY longer than 32 characters', () => {
    const result = envSchema.safeParse({
      ...baseEnv,
      AI_ENCRYPTION_KEY: 'a'.repeat(64),
    })
    expect(result.success).toBe(true)
  })
})

describe('HOSTING_MODE validation', () => {
  const baseEnv = {
    DATABASE_URL: 'postgresql://barazo:barazo_dev@localhost:5432/barazo',
    VALKEY_URL: 'redis://localhost:6379',
    TAP_URL: 'http://localhost:2480',
    TAP_ADMIN_PASSWORD: 'tap_dev_secret',
    OAUTH_CLIENT_ID:
      'http://localhost?redirect_uri=http%3A%2F%2F127.0.0.1%3A3000%2Fapi%2Fauth%2Fcallback',
    OAUTH_REDIRECT_URI: 'http://127.0.0.1:3000/api/auth/callback',
    SESSION_SECRET: 'a-very-long-session-secret-that-is-at-least-32-characters',
    AI_ENCRYPTION_KEY: 'a-very-long-encryption-key-that-is-at-least-32-characters',
    COMMUNITY_DID: 'did:plc:testcommunity123',
  }

  it('defaults to selfhosted when HOSTING_MODE is omitted', () => {
    const result = envSchema.safeParse(baseEnv)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.HOSTING_MODE).toBe('selfhosted')
    }
  })

  it('accepts saas as HOSTING_MODE', () => {
    const result = envSchema.safeParse({ ...baseEnv, HOSTING_MODE: 'saas' })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.HOSTING_MODE).toBe('saas')
    }
  })

  it('rejects invalid HOSTING_MODE values', () => {
    const result = envSchema.safeParse({ ...baseEnv, HOSTING_MODE: 'cloud' })
    expect(result.success).toBe(false)
  })
})

describe('parseEnv', () => {
  it('throws on invalid environment', () => {
    expect(() => parseEnv({})).toThrow()
  })
})
