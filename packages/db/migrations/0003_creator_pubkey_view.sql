-- The creator's public key, without its encrypted secret. The API's read-only user (rat_api) has no access to
-- key_pool, but its staging check must still see whether this database holds the production creator key.
-- A plain view runs with its owner's rights, so rat_api reads this one column and never secret_enc.
CREATE VIEW "creator_pubkey" AS SELECT "pubkey" FROM "key_pool" WHERE "role" = 'creator';--> statement-breakpoint
-- databases set up before this migration already have rat_api (infra/readonly-role.sql grants new setups)
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rat_api') THEN
    GRANT SELECT ON "creator_pubkey" TO rat_api;
  END IF;
END $$;
