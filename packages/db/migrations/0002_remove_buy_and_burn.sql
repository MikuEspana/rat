-- Buy and burn removed: every claimed lamport hires rats. The burns table and the fund-share columns go; old
-- ledger rows in the retired "burn" bucket (DRY RUN rehearsals only) stay untouched and are no longer read.
DROP TABLE "burns" CASCADE;--> statement-breakpoint
ALTER TABLE "claims" DROP COLUMN "to_fund_lamports";--> statement-breakpoint
ALTER TABLE "claims" DROP COLUMN "fund_share_lamports";