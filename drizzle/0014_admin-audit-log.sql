CREATE TABLE "admin_audit_log" (
	"id" serial PRIMARY KEY NOT NULL,
	"community_did" text NOT NULL,
	"actor_did" text NOT NULL,
	"action" text NOT NULL,
	"changes" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "admin_audit_log" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "admin_audit_log_community_did_idx" ON "admin_audit_log" USING btree ("community_did");--> statement-breakpoint
CREATE INDEX "admin_audit_log_actor_did_idx" ON "admin_audit_log" USING btree ("actor_did");--> statement-breakpoint
CREATE INDEX "admin_audit_log_created_at_idx" ON "admin_audit_log" USING btree ("created_at");--> statement-breakpoint
CREATE POLICY "tenant_isolation_select" ON "admin_audit_log" AS PERMISSIVE FOR SELECT TO "barazo_app" USING (community_did = current_setting('app.current_community_did', true));--> statement-breakpoint
CREATE POLICY "tenant_isolation_insert" ON "admin_audit_log" AS PERMISSIVE FOR INSERT TO "barazo_app" WITH CHECK (community_did = current_setting('app.current_community_did', true));
