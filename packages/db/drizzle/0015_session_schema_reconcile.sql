-- Reconcile user_sessions DDL with the Drizzle schema (the 0014 handcrafted SQL
-- used different constraint names). Idempotent so it applies over 0014 or fresh.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_sessions_replaced_by_fk') THEN
    ALTER TABLE user_sessions DROP CONSTRAINT user_sessions_replaced_by_fk;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_sessions_replaced_by_user_sessions_id_fk') THEN
    ALTER TABLE user_sessions
      ADD CONSTRAINT user_sessions_replaced_by_user_sessions_id_fk
      FOREIGN KEY (replaced_by) REFERENCES user_sessions(id) ON DELETE SET NULL;
  END IF;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "user_sessions_token_hash_unique" ON "user_sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_sessions_expires_idx" ON "user_sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_sessions_last_seen_idx" ON "user_sessions" USING btree ("last_seen_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_sessions_user_id_created_at_idx" ON "user_sessions" USING btree ("user_id","created_at");
