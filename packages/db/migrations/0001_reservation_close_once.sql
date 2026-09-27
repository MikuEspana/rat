ALTER TABLE "ledger_entries" ADD COLUMN "closes_id" bigint;--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_closes_id" ON "ledger_entries" USING btree ("closes_id");--> statement-breakpoint
-- Reservations booked before this migration: mark them closed (zero-delta entry) unless a rat or burn still uses
-- them, so the new orphan cleanup can never release an old reservation a second time.
INSERT INTO "ledger_entries" ("mode", "at", "bucket", "delta_lamports", "reason", "ref_type", "ref_id", "note", "closes_id")
SELECT r."mode", now(), r."bucket", 0, CASE r."bucket" WHEN 'hire' THEN 'hire_settle' ELSE 'burn_settle' END, r."ref_type", r."ref_id", 'migration: closed before exactly-once tracking', r."id"
FROM "ledger_entries" r
WHERE r."reason" IN ('hire_reserve', 'burn_reserve')
  AND r."id" NOT IN (SELECT "reserve_ledger_id" FROM "rats" WHERE "reserve_ledger_id" IS NOT NULL)
  AND r."id" NOT IN (SELECT "reserve_ledger_id" FROM "burns" WHERE "reserve_ledger_id" IS NOT NULL);
