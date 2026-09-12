ALTER TYPE "public"."audit_action" ADD VALUE 'user.purged' BEFORE 'user.password_reset';--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "anonymized_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "audit_events" ADD COLUMN "prev_hash" varchar(64);--> statement-breakpoint
ALTER TABLE "audit_events" ADD COLUMN "event_hash" varchar(64);