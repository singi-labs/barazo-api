import { describe, it, expect } from 'vitest'
import {
  createModNoteSchema,
  modNoteQuerySchema,
  createTopicNoticeSchema,
  // dismissTopicNoticeSchema and topicNoticeQuerySchema tested via route-level integration
  createWarningSchema,
  warningQuerySchema,
  acknowledgeWarningSchema,
} from '../../../src/validation/mod-annotations.js'

describe('mod annotation validation schemas', () => {
  describe('createModNoteSchema', () => {
    it('should accept valid user note', () => {
      const result = createModNoteSchema.safeParse({
        subjectDid: 'did:plc:abc123',
        content: 'User was warned verbally in chat.',
      })
      expect(result.success).toBe(true)
    })

    it('should accept valid post note', () => {
      const result = createModNoteSchema.safeParse({
        subjectUri: 'at://did:plc:abc/forum.barazo.topic.post/123',
        content: 'Borderline post, left up after review.',
      })
      expect(result.success).toBe(true)
    })

    it('should reject note with both subjectDid and subjectUri', () => {
      const result = createModNoteSchema.safeParse({
        subjectDid: 'did:plc:abc123',
        subjectUri: 'at://did:plc:abc/forum.barazo.topic.post/123',
        content: 'Invalid.',
      })
      expect(result.success).toBe(false)
    })

    it('should reject note with neither subjectDid nor subjectUri', () => {
      const result = createModNoteSchema.safeParse({
        content: 'No subject.',
      })
      expect(result.success).toBe(false)
    })

    it('should reject empty content', () => {
      const result = createModNoteSchema.safeParse({
        subjectDid: 'did:plc:abc123',
        content: '',
      })
      expect(result.success).toBe(false)
    })

    it('should reject content over 5000 chars', () => {
      const result = createModNoteSchema.safeParse({
        subjectDid: 'did:plc:abc123',
        content: 'a'.repeat(5001),
      })
      expect(result.success).toBe(false)
    })
  })

  describe('modNoteQuerySchema', () => {
    it('should accept valid query with subjectDid', () => {
      const result = modNoteQuerySchema.safeParse({
        subjectDid: 'did:plc:abc123',
      })
      expect(result.success).toBe(true)
    })

    it('should accept valid query with subjectUri', () => {
      const result = modNoteQuerySchema.safeParse({
        subjectUri: 'at://did:plc:abc/forum.barazo.topic.post/123',
      })
      expect(result.success).toBe(true)
    })

    it('should accept query with cursor and limit', () => {
      const result = modNoteQuerySchema.safeParse({
        subjectDid: 'did:plc:abc123',
        cursor: '10',
        limit: 50,
      })
      expect(result.success).toBe(true)
    })

    it('should default limit to 25', () => {
      const result = modNoteQuerySchema.safeParse({
        subjectDid: 'did:plc:abc123',
      })
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.limit).toBe(25)
      }
    })
  })

  describe('createTopicNoticeSchema', () => {
    it('should accept valid notice', () => {
      const result = createTopicNoticeSchema.safeParse({
        topicUri: 'at://did:plc:abc/forum.barazo.topic.post/123',
        noticeType: 'closed',
        headline: 'This topic has been closed.',
      })
      expect(result.success).toBe(true)
    })

    it('should accept notice with optional body', () => {
      const result = createTopicNoticeSchema.safeParse({
        topicUri: 'at://did:plc:abc/forum.barazo.topic.post/123',
        noticeType: 'custom',
        headline: 'Please read before posting.',
        body: 'This topic has specific rules.',
      })
      expect(result.success).toBe(true)
    })

    it('should reject headline over 200 chars', () => {
      const result = createTopicNoticeSchema.safeParse({
        topicUri: 'at://did:plc:abc/forum.barazo.topic.post/123',
        noticeType: 'closed',
        headline: 'a'.repeat(201),
      })
      expect(result.success).toBe(false)
    })

    it('should reject invalid notice type', () => {
      const result = createTopicNoticeSchema.safeParse({
        topicUri: 'at://did:plc:abc/forum.barazo.topic.post/123',
        noticeType: 'invalid',
        headline: 'Test.',
      })
      expect(result.success).toBe(false)
    })
  })

  describe('createWarningSchema', () => {
    it('should accept valid warning', () => {
      const result = createWarningSchema.safeParse({
        targetDid: 'did:plc:user123',
        warningType: 'rule_violation',
        message: 'Your post violated community rule #3.',
      })
      expect(result.success).toBe(true)
    })

    it('should accept warning with optional fields', () => {
      const result = createWarningSchema.safeParse({
        targetDid: 'did:plc:user123',
        warningType: 'harassment',
        message: 'Please review our community guidelines.',
        modComment: 'This is a first offense.',
        internalNote: 'User has been argumentative in multiple threads.',
      })
      expect(result.success).toBe(true)
    })

    it('should reject modComment over 300 chars', () => {
      const result = createWarningSchema.safeParse({
        targetDid: 'did:plc:user123',
        warningType: 'other',
        message: 'Warning.',
        modComment: 'a'.repeat(301),
      })
      expect(result.success).toBe(false)
    })

    it('should reject empty message', () => {
      const result = createWarningSchema.safeParse({
        targetDid: 'did:plc:user123',
        warningType: 'other',
        message: '',
      })
      expect(result.success).toBe(false)
    })
  })

  describe('acknowledgeWarningSchema', () => {
    it('should accept valid warning id param', () => {
      const result = acknowledgeWarningSchema.safeParse({ id: '5' })
      expect(result.success).toBe(true)
    })
  })

  describe('warningQuerySchema', () => {
    it('should accept query with targetDid', () => {
      const result = warningQuerySchema.safeParse({
        targetDid: 'did:plc:user123',
      })
      expect(result.success).toBe(true)
    })

    it('should default limit to 25', () => {
      const result = warningQuerySchema.safeParse({})
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.limit).toBe(25)
      }
    })
  })
})
