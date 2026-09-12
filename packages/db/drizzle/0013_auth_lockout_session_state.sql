ALTER TYPE "public"."audit_action" ADD VALUE 'auth.login_blocked' BEFORE 'auth.logout';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'auth.lockout_triggered' BEFORE 'auth.logout';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'auth.step_up_failed' BEFORE 'auth.logout';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'mfa.recovery_codes_regenerated' BEFORE 'mfa.admin_reset';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'session.rotated' BEFORE 'system.retention';--> statement-breakpoint
CREATE TABLE "auth_login_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subject_key" varchar(64) NOT NULL,
	"ip_hash" varchar(64) DEFAULT '' NOT NULL,
	"scope" varchar(16) DEFAULT 'account_ip' NOT NULL,
	"failed_count" integer DEFAULT 0 NOT NULL,
	"window_started_at" timestamp with time zone,
	"last_failed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_until" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_sessions" ADD COLUMN "last_seen_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "user_sessions" ADD COLUMN "step_up_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "user_sessions" ADD COLUMN "replaced_by" uuid;--> statement-breakpoint
CREATE UNIQUE INDEX "auth_login_attempts_key_unique" ON "auth_login_attempts" USING btree ("subject_key","ip_hash");--> statement-breakpoint
CREATE INDEX "auth_login_attempts_sweep_idx" ON "auth_login_attempts" USING btree ("last_failed_at");