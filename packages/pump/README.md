# @rat/pump

pump.fun creator fees, burn and the direct buy fallback. Owned by WS06.

Source of truth: the official IDLs in [pump-fun/pump-public-docs](https://github.com/pump-fun/pump-public-docs) (VERIFIED). `fixtures/creator-fee-idl.json` is a trimmed copy of the creator fee instructions; tests check our builders against it.

- `pdas.ts`: bonding vault `["creator-vault", creator]` (pump), AMM vault authority `["creator_vault", creator]` (pump_amm) and its WSOL ATA, creator WSOL ATA, event authorities.
- `instructions.ts`: `collect_creator_fee_v2` (pays native SOL for SOL-paired coins), `collect_coin_creator_fee` (pays WSOL), create + close of the creator WSOL ATA (unwrap), BurnChecked with the coin's own token program.
- `client.ts`: `PumpFunClient` (reads through the ChainReader port, so it runs on RPC or SimChain):
  - `getClaimable`: bonding vault lamports above rent, AMM vault WSOL, leftover creator WSOL
  - `buildClaimInstructions`: unwrap only when AMM fees or leftover WSOL exist
  - `getCoinInfo`: token program detected at runtime
  - `parseClaim(record, creator)`: finds a claim instruction for OUR creator (any signer, including the legacy `collect_creator_fee`) and measures what left our vaults
- `direct-buy.ts`: `PumpDirectBuyBuilder` (SwapBuilder) on the official `@pump-fun/pump-sdk`, bonding curve only. The SDK is loaded lazily through its CommonJS build because its ESM build does not import under Node.
- `sim.ts`: SimChain handlers for both claim instructions and `accrueCreatorFees()` to simulate trading volume.
