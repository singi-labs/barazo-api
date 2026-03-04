ALTER TABLE "replies" ADD COLUMN "depth" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "community_settings" ADD COLUMN "max_reply_depth" integer DEFAULT 9999 NOT NULL;--> statement-breakpoint
CREATE INDEX "replies_root_uri_depth_idx" ON "replies" USING btree ("root_uri","depth");