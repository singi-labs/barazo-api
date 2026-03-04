ALTER TABLE "community_settings" ADD COLUMN "header_logo_url" text;--> statement-breakpoint
ALTER TABLE "community_settings" ADD COLUMN "show_community_name" boolean DEFAULT true NOT NULL;