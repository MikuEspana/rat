CREATE TABLE "burns" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"mode" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"status" text NOT NULL,
	"sig" text,
	"reserved_lamports" bigint NOT NULL,
	"reserve_ledger_id" bigint,
	"sol_spent_lamports" bigint,
	"tokens_burned_raw" bigint,
	"coin_decimals" integer
);
--> statement-breakpoint
CREATE TABLE "claims" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"mode" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"source" text NOT NULL,
	"status" text NOT NULL,
	"sig" text,
	"claimable_lamports" bigint NOT NULL,
	"claimed_lamports" bigint DEFAULT 0 NOT NULL,
	"to_fund_lamports" bigint DEFAULT 0 NOT NULL,
	"fund_share_lamports" bigint DEFAULT 0 NOT NULL,
	"hire_share_lamports" bigint DEFAULT 0 NOT NULL,
	"fee_lamports" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"mode" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"type" text NOT NULL,
	"tx_sig" text,
	"data" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "heartbeats" (
	"loop" text PRIMARY KEY NOT NULL,
	"last_run_at" timestamp with time zone NOT NULL,
	"last_ok_at" timestamp with time zone,
	"last_error" text,
	"runs" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "key_pool" (
	"pubkey" text PRIMARY KEY NOT NULL,
	"secret_enc" text NOT NULL,
	"key_version" integer NOT NULL,
	"role" text NOT NULL,
	"status" text DEFAULT 'available' NOT NULL,
	"assigned_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ledger_entries" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"mode" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"bucket" text NOT NULL,
	"delta_lamports" bigint NOT NULL,
	"reason" text NOT NULL,
	"ref_type" text,
	"ref_id" text,
	"note" text
);
--> statement-breakpoint
CREATE TABLE "locks" (
	"name" text PRIMARY KEY NOT NULL,
	"holder" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rats" (
	"id" serial PRIMARY KEY NOT NULL,
	"mode" text NOT NULL,
	"wallet" text NOT NULL,
	"stock_mint" text NOT NULL,
	"status" text NOT NULL,
	"freeze_reason" text,
	"avatar_seed" text NOT NULL,
	"salary_lamports" bigint NOT NULL,
	"reserve_ledger_id" bigint,
	"funded" boolean DEFAULT false NOT NULL,
	"sol_swapped_lamports" bigint,
	"token_amount_raw" bigint,
	"token_decimals" integer,
	"cost_usd" double precision,
	"sol_usd_at_hire" double precision,
	"hire_sig" text,
	"hire_attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"hired_at" timestamp with time zone,
	"last_checked_at" timestamp with time zone,
	CONSTRAINT "rats_wallet_unique" UNIQUE("wallet")
);
--> statement-breakpoint
CREATE TABLE "seen_signatures" (
	"signature" text PRIMARY KEY NOT NULL,
	"address" text NOT NULL,
	"classification" text NOT NULL,
	"at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stock_prices" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"mint" text NOT NULL,
	"price_usd" double precision NOT NULL,
	"at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stocks" (
	"mint" text PRIMARY KEY NOT NULL,
	"symbol" text NOT NULL,
	"name" text NOT NULL,
	"grp" text NOT NULL,
	"enabled" boolean NOT NULL,
	"approved" boolean NOT NULL,
	"decimals" integer,
	"token_program" text,
	"mint_authority" text,
	"verified" boolean DEFAULT false NOT NULL,
	"verify_error" text,
	"verified_at" timestamp with time zone,
	"status" text DEFAULT 'active' NOT NULL,
	"ui_multiplier" double precision DEFAULT 1 NOT NULL,
	"price_usd" double precision,
	"change_24h_pct" double precision,
	"price_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stocks_symbol_unique" UNIQUE("symbol")
);
--> statement-breakpoint
CREATE TABLE "tx_attempts" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"mode" text NOT NULL,
	"kind" text NOT NULL,
	"ref_type" text NOT NULL,
	"ref_id" text NOT NULL,
	"signature" text NOT NULL,
	"last_valid_block_height" bigint NOT NULL,
	"status" text NOT NULL,
	"error" text,
	"fee_lamports" bigint,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "tx_attempts_signature_unique" UNIQUE("signature")
);
--> statement-breakpoint
CREATE INDEX "burns_mode_at" ON "burns" USING btree ("mode","at");--> statement-breakpoint
CREATE INDEX "claims_mode_at" ON "claims" USING btree ("mode","at");--> statement-breakpoint
CREATE UNIQUE INDEX "claims_sig" ON "claims" USING btree ("sig");--> statement-breakpoint
CREATE INDEX "events_mode_id" ON "events" USING btree ("mode","id");--> statement-breakpoint
CREATE INDEX "key_pool_role_status" ON "key_pool" USING btree ("role","status");--> statement-breakpoint
CREATE INDEX "ledger_mode_bucket" ON "ledger_entries" USING btree ("mode","bucket");--> statement-breakpoint
CREATE INDEX "ledger_mode_at" ON "ledger_entries" USING btree ("mode","at");--> statement-breakpoint
CREATE INDEX "rats_mode_status" ON "rats" USING btree ("mode","status");--> statement-breakpoint
CREATE INDEX "rats_stock" ON "rats" USING btree ("stock_mint");--> statement-breakpoint
CREATE INDEX "stock_prices_mint_at" ON "stock_prices" USING btree ("mint","at");--> statement-breakpoint
CREATE INDEX "tx_attempts_ref" ON "tx_attempts" USING btree ("ref_type","ref_id");--> statement-breakpoint
CREATE INDEX "tx_attempts_mode_status" ON "tx_attempts" USING btree ("mode","status");