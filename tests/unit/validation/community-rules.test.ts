import { describe, it, expect } from 'vitest'
import {
  createRuleSchema,
  updateRuleSchema,
  reorderRulesSchema,
  ruleVersionsQuerySchema,
} from '../../../src/validation/community-rules.js'

describe('community rules validation schemas', () => {
  describe('createRuleSchema', () => {
    it('should accept valid rule', () => {
      const result = createRuleSchema.safeParse({
        title: 'Be respectful',
        description: 'Treat all members with respect and courtesy.',
      })
      expect(result.success).toBe(true)
    })

    it('should reject empty title', () => {
      const result = createRuleSchema.safeParse({
        title: '',
        description: 'Some description',
      })
      expect(result.success).toBe(false)
    })

    it('should reject title exceeding 200 chars', () => {
      const result = createRuleSchema.safeParse({
        title: 'x'.repeat(201),
        description: 'Some description',
      })
      expect(result.success).toBe(false)
    })

    it('should reject empty description', () => {
      const result = createRuleSchema.safeParse({
        title: 'A rule',
        description: '',
      })
      expect(result.success).toBe(false)
    })

    it('should reject missing title', () => {
      const result = createRuleSchema.safeParse({
        description: 'Some description',
      })
      expect(result.success).toBe(false)
    })

    it('should reject missing description', () => {
      const result = createRuleSchema.safeParse({
        title: 'A rule',
      })
      expect(result.success).toBe(false)
    })
  })

  describe('updateRuleSchema', () => {
    it('should accept valid update', () => {
      const result = updateRuleSchema.safeParse({
        title: 'Updated title',
        description: 'Updated description',
      })
      expect(result.success).toBe(true)
    })

    it('should reject empty title', () => {
      const result = updateRuleSchema.safeParse({
        title: '',
        description: 'Updated description',
      })
      expect(result.success).toBe(false)
    })
  })

  describe('reorderRulesSchema', () => {
    it('should accept valid order array', () => {
      const result = reorderRulesSchema.safeParse({
        order: [
          { id: 1, displayOrder: 0 },
          { id: 2, displayOrder: 1 },
        ],
      })
      expect(result.success).toBe(true)
    })

    it('should reject empty order array', () => {
      const result = reorderRulesSchema.safeParse({
        order: [],
      })
      expect(result.success).toBe(false)
    })

    it('should reject negative id', () => {
      const result = reorderRulesSchema.safeParse({
        order: [{ id: -1, displayOrder: 0 }],
      })
      expect(result.success).toBe(false)
    })

    it('should reject negative displayOrder', () => {
      const result = reorderRulesSchema.safeParse({
        order: [{ id: 1, displayOrder: -1 }],
      })
      expect(result.success).toBe(false)
    })
  })

  describe('ruleVersionsQuerySchema', () => {
    it('should accept empty query (defaults)', () => {
      const result = ruleVersionsQuerySchema.safeParse({})
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.limit).toBe(25)
      }
    })

    it('should accept cursor and limit', () => {
      const result = ruleVersionsQuerySchema.safeParse({
        cursor: 'abc123',
        limit: '10',
      })
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.limit).toBe(10)
      }
    })

    it('should reject limit exceeding 100', () => {
      const result = ruleVersionsQuerySchema.safeParse({
        limit: '101',
      })
      expect(result.success).toBe(false)
    })
  })
})
