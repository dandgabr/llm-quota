CREATE TYPE "public"."connection_type" AS ENUM('oauth', 'api');--> statement-breakpoint
CREATE TYPE "public"."granularity" AS ENUM('daily', 'weekly', 'monthly');--> statement-breakpoint
CREATE TYPE "public"."quota_kind" AS ENUM('percent', 'credits');--> statement-breakpoint
CREATE TYPE "public"."quota_window" AS ENUM('session', 'daily', 'weekly', 'monthly', 'lifetime');--> statement-breakpoint
CREATE TYPE "public"."role" AS ENUM('user', 'supervisor', 'admin');--> statement-breakpoint
CREATE TABLE "identity_providers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(120) NOT NULL,
	"issuer" varchar(255) NOT NULL,
	"client_id" varchar(255) NOT NULL,
	"client_secret_cipher" text NOT NULL,
	"discovery_url" varchar(255),
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "totp_secrets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"secret_cipher" text NOT NULL,
	"algorithm" varchar(20) DEFAULT 'SHA1' NOT NULL,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" varchar(320) NOT NULL,
	"email_verified_at" timestamp with time zone,
	"first_name" varchar(120),
	"last_name" varchar(120),
	"role" "role" DEFAULT 'user' NOT NULL,
	"locale" varchar(20) DEFAULT 'en' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webauthn_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"credential_id" varchar NOT NULL,
	"public_key" text NOT NULL,
	"counter" integer DEFAULT 0 NOT NULL,
	"transports" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"provider_id" uuid NOT NULL,
	"label" varchar(200) NOT NULL,
	"connection_type" "connection_type" NOT NULL,
	"secret_cipher" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "quota_providers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_key" varchar(120) NOT NULL,
	"name" varchar(120) NOT NULL,
	"connector_id" varchar(160) NOT NULL,
	"connection_type" "connection_type" NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "quota_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connection_id" uuid NOT NULL,
	"window" "quota_window" NOT NULL,
	"used_percent" numeric(6, 3),
	"remaining_percent" numeric(6, 3),
	"resets_at" timestamp with time zone,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "quota_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connection_id" uuid NOT NULL,
	"quota_session_id" uuid,
	"kind" "quota_kind" DEFAULT 'percent' NOT NULL,
	"window" "quota_window" NOT NULL,
	"currency" varchar(8),
	"credits" jsonb,
	"used_percent" numeric(6, 3),
	"remaining_percent" numeric(6, 3),
	"resets_at" timestamp with time zone,
	"read_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fx_rates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"base" varchar(8) DEFAULT 'USD' NOT NULL,
	"currency" varchar(8) NOT NULL,
	"rate" numeric(18, 8) NOT NULL,
	"effective_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "spending_aggregates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"granularity" "granularity" NOT NULL,
	"window" varchar(40) NOT NULL,
	"spent_amount" numeric(18, 6) DEFAULT '0' NOT NULL,
	"currency" varchar(8) NOT NULL,
	"count" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" varchar(128) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "totp_secrets" ADD CONSTRAINT "totp_secrets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webauthn_credentials" ADD CONSTRAINT "webauthn_credentials_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_provider_id_quota_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."quota_providers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quota_sessions" ADD CONSTRAINT "quota_sessions_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quota_snapshots" ADD CONSTRAINT "quota_snapshots_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quota_snapshots" ADD CONSTRAINT "quota_snapshots_quota_session_id_quota_sessions_id_fk" FOREIGN KEY ("quota_session_id") REFERENCES "public"."quota_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spending_aggregates" ADD CONSTRAINT "spending_aggregates_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spending_aggregates" ADD CONSTRAINT "spending_aggregates_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_sessions" ADD CONSTRAINT "user_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_unique" ON "users" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "connections_user_provider_unique" ON "connections" USING btree ("user_id","provider_id","label");--> statement-breakpoint
CREATE UNIQUE INDEX "quota_providers_provider_key_type_unique" ON "quota_providers" USING btree ("provider_key","connection_type");--> statement-breakpoint
CREATE UNIQUE INDEX "quota_snapshots_conn_window_read_unique" ON "quota_snapshots" USING btree ("connection_id","window","read_at");--> statement-breakpoint
CREATE INDEX "quota_snapshots_conn_read_idx" ON "quota_snapshots" USING btree ("connection_id","read_at");--> statement-breakpoint
CREATE UNIQUE INDEX "fx_rates_base_currency_day_unique" ON "fx_rates" USING btree ("base","currency","effective_at");--> statement-breakpoint
CREATE UNIQUE INDEX "spending_aggregates_user_slot_unique" ON "spending_aggregates" USING btree ("user_id","connection_id","granularity","window");--> statement-breakpoint
CREATE INDEX "spending_aggregates_user_window_idx" ON "spending_aggregates" USING btree ("user_id","granularity","window");