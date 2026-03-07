-- Align with lexicon v0.3.0: content union, publishedAt, site field
-- Topics: rename created_at → published_at, drop content_format, add site
ALTER TABLE "topics" RENAME COLUMN "created_at" TO "published_at";--> statement-breakpoint
ALTER TABLE "topics" DROP COLUMN IF EXISTS "content_format";--> statement-breakpoint
ALTER TABLE "topics" ADD COLUMN "site" text;--> statement-breakpoint
DROP INDEX IF EXISTS "topics_created_at_idx";--> statement-breakpoint
CREATE INDEX "topics_published_at_idx" ON "topics" USING btree ("published_at");--> statement-breakpoint
-- Replies: drop content_format only (replies keep created_at)
ALTER TABLE "replies" DROP COLUMN IF EXISTS "content_format";
