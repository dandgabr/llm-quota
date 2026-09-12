CREATE TYPE "public"."audit_action" AS ENUM('user.created', 'user.role_changed', 'user.blocked', 'user.unblocked', 'user.deleted', 'user.password_reset', 'invite.created', 'invite.revoked', 'invite.accepted', 'connection.created', 'connection.updated', 'connection.deleted', 'auth.setup_completed', 'auth.login_succeeded', 'auth.login_failed', 'auth.logout', 'mfa.enrolled', 'mfa.disabled', 'mfa.recovery_code_used', 'mfa.admin_reset', 'session.revoked', 'system.retention');--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_user_id" uuid,
	"actor_role" varchar(20),
	"action" "audit_action" NOT NULL,
	"target_type" varchar(40),
	"target_id" varchar(128),
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"request_id" varchar(128)
);
--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_events_cursor_idx" ON "audit_events" USING btree ("occurred_at","id");--> statement-breakpoint
CREATE INDEX "audit_events_actor_idx" ON "audit_events" USING btree ("actor_user_id","occurred_at");--> statement-breakpoint
CREATE INDEX "audit_events_target_idx" ON "audit_events" USING btree ("target_type","target_id");