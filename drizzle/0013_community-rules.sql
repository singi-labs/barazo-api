CREATE TABLE "community_rules" (
	"id" serial PRIMARY KEY NOT NULL,
	"community_did" text NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"display_order" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "community_rules" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "community_rule_versions" (
	"id" serial PRIMARY KEY NOT NULL,
	"rule_id" integer NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "community_rule_versions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "moderation_action_rules" (
	"id" serial PRIMARY KEY NOT NULL,
	"warning_id" integer,
	"moderation_action_id" integer,
	"rule_version_id" integer NOT NULL,
	"community_did" text NOT NULL,
	CONSTRAINT "exactly_one_parent" CHECK ((warning_id IS NOT NULL AND moderation_action_id IS NULL) OR (warning_id IS NULL AND moderation_action_id IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "moderation_action_rules" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "community_rules_community_did_idx" ON "community_rules" USING btree ("community_did");--> statement-breakpoint
CREATE INDEX "community_rules_display_order_idx" ON "community_rules" USING btree ("display_order");--> statement-breakpoint
CREATE INDEX "community_rule_versions_rule_id_idx" ON "community_rule_versions" USING btree ("rule_id");--> statement-breakpoint
CREATE INDEX "mod_action_rules_warning_id_idx" ON "moderation_action_rules" USING btree ("warning_id");--> statement-breakpoint
CREATE INDEX "mod_action_rules_moderation_action_id_idx" ON "moderation_action_rules" USING btree ("moderation_action_id");--> statement-breakpoint
CREATE INDEX "mod_action_rules_rule_version_id_idx" ON "moderation_action_rules" USING btree ("rule_version_id");--> statement-breakpoint
CREATE INDEX "mod_action_rules_community_did_idx" ON "moderation_action_rules" USING btree ("community_did");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "community_rules" AS PERMISSIVE FOR ALL TO "barazo_app" USING (community_did = current_setting('app.current_community_did', true)) WITH CHECK (community_did = current_setting('app.current_community_did', true));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "community_rule_versions" AS PERMISSIVE FOR ALL TO "barazo_app" USING (rule_id IN (SELECT id FROM community_rules WHERE community_did = current_setting('app.current_community_did', true))) WITH CHECK (rule_id IN (SELECT id FROM community_rules WHERE community_did = current_setting('app.current_community_did', true)));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "moderation_action_rules" AS PERMISSIVE FOR ALL TO "barazo_app" USING (community_did = current_setting('app.current_community_did', true)) WITH CHECK (community_did = current_setting('app.current_community_did', true));
