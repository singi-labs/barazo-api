CREATE TABLE "mod_notes" (
	"id" serial PRIMARY KEY NOT NULL,
	"community_did" text NOT NULL,
	"author_did" text NOT NULL,
	"subject_did" text,
	"subject_uri" text,
	"content" text NOT NULL,
	"note_type" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subject_check" CHECK ((subject_did IS NOT NULL AND subject_uri IS NULL) OR (subject_did IS NULL AND subject_uri IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "mod_notes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "topic_notices" (
	"id" serial PRIMARY KEY NOT NULL,
	"community_did" text NOT NULL,
	"topic_uri" text NOT NULL,
	"author_did" text NOT NULL,
	"notice_type" text NOT NULL,
	"headline" text NOT NULL,
	"body" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"dismissed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "topic_notices" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "mod_warnings" (
	"id" serial PRIMARY KEY NOT NULL,
	"community_did" text NOT NULL,
	"target_did" text NOT NULL,
	"moderator_did" text NOT NULL,
	"warning_type" text NOT NULL,
	"message" text NOT NULL,
	"mod_comment" text,
	"internal_note" text,
	"acknowledged_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mod_warnings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "mod_notes_community_did_idx" ON "mod_notes" USING btree ("community_did");--> statement-breakpoint
CREATE INDEX "mod_notes_author_did_idx" ON "mod_notes" USING btree ("author_did");--> statement-breakpoint
CREATE INDEX "mod_notes_subject_did_idx" ON "mod_notes" USING btree ("subject_did");--> statement-breakpoint
CREATE INDEX "mod_notes_subject_uri_idx" ON "mod_notes" USING btree ("subject_uri");--> statement-breakpoint
CREATE INDEX "mod_notes_created_at_idx" ON "mod_notes" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "topic_notices_community_did_idx" ON "topic_notices" USING btree ("community_did");--> statement-breakpoint
CREATE INDEX "topic_notices_topic_uri_idx" ON "topic_notices" USING btree ("topic_uri");--> statement-breakpoint
CREATE INDEX "topic_notices_created_at_idx" ON "topic_notices" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "mod_warnings_community_did_idx" ON "mod_warnings" USING btree ("community_did");--> statement-breakpoint
CREATE INDEX "mod_warnings_target_did_idx" ON "mod_warnings" USING btree ("target_did");--> statement-breakpoint
CREATE INDEX "mod_warnings_moderator_did_idx" ON "mod_warnings" USING btree ("moderator_did");--> statement-breakpoint
CREATE INDEX "mod_warnings_created_at_idx" ON "mod_warnings" USING btree ("created_at");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "mod_notes" AS PERMISSIVE FOR ALL TO "barazo_app" USING (community_did = current_setting('app.current_community_did', true)) WITH CHECK (community_did = current_setting('app.current_community_did', true));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "topic_notices" AS PERMISSIVE FOR ALL TO "barazo_app" USING (community_did = current_setting('app.current_community_did', true)) WITH CHECK (community_did = current_setting('app.current_community_did', true));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "mod_warnings" AS PERMISSIVE FOR ALL TO "barazo_app" USING (community_did = current_setting('app.current_community_did', true)) WITH CHECK (community_did = current_setting('app.current_community_did', true));