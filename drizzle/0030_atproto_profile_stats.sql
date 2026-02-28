ALTER TABLE "users" ADD COLUMN "followers_count" integer DEFAULT 0 NOT NULL;
ALTER TABLE "users" ADD COLUMN "follows_count" integer DEFAULT 0 NOT NULL;
ALTER TABLE "users" ADD COLUMN "atproto_posts_count" integer DEFAULT 0 NOT NULL;
ALTER TABLE "users" ADD COLUMN "has_bluesky_profile" boolean DEFAULT false NOT NULL;
