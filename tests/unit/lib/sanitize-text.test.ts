import { describe, it, expect } from 'vitest'
import { stripControlCharacters } from '../../../src/lib/sanitize-text.js'

describe('stripControlCharacters', () => {
  it('strips RTL override characters', () => {
    expect(stripControlCharacters('Hello\u202Eworld')).toBe('Helloworld')
  })

  it('strips zero-width characters', () => {
    expect(stripControlCharacters('He\u200Bllo')).toBe('Hello')
  })

  it('strips bidi isolate characters', () => {
    expect(stripControlCharacters('\u2066Hello\u2069')).toBe('Hello')
  })

  it('strips BOM character', () => {
    expect(stripControlCharacters('\uFEFFHello')).toBe('Hello')
  })

  it('preserves normal Unicode (accents, CJK)', () => {
    expect(stripControlCharacters('Héllo')).toBe('Héllo')
    expect(stripControlCharacters('こんにちは')).toBe('こんにちは')
    expect(stripControlCharacters('Ñoño')).toBe('Ñoño')
  })

  it('returns empty string for all-control input', () => {
    expect(stripControlCharacters('\u200B\u200C\u200D')).toBe('')
  })

  it('trims whitespace', () => {
    expect(stripControlCharacters('  Hello  ')).toBe('Hello')
  })

  it('handles empty string', () => {
    expect(stripControlCharacters('')).toBe('')
  })
})
