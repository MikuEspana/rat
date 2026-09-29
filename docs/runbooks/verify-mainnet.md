# Read-only mainnet check (2 minutes, before the launch)

Checks what the bot depends on against live mainnet, from your Mac. Public endpoints only (the Solana RPC and Jupiter's keyless API), no keys, no Railway, no database. **Nothing is signed or sent**: the claim and the swap are simulated with signature checks off.

From `~/wallstreetrats`:
```
scripts/verify-mainnet.sh --sample <any pump.fun coin mint> --payer <your own wallet address>
```
- `--sample`: any live pump.fun coin (copy a mint from pump.fun). Checks the bonding curve layout and the creator vault derivation on real data, and simulates the claim.
- `--payer`: any wallet that holds about 0.05 SOL, for example yours (only its address). Pays the simulated claim and swap. Without it the swap is skipped.
- A private RPC only through the environment: `VERIFY_RPC_URL=<url> scripts/verify-mainnet.sh ...` (never on the command line of a shared screen).
- The xStocks mint authority is the one most mints share (like the bot), or `--authority <address>`.

| Line | PASS means | Not PASS: what to do |
|---|---|---|
| `pump program`, `pump_amm program` | the program exists and runs | FAIL: wrong network or RPC down. Do not launch until it passes. |
| `mint <stock>` | Token-2022, the xStocks authority, not paused, no extension that breaks a hire (the extensions are listed) | FAIL: do not approve that stock (`scripts/approve-stocks.sh`). WARN (transfer fee, transfer hook, default frozen accounts): leave it unapproved. |
| `quote <stock>` | Jupiter has a route for 0.03 SOL, price impact and the gap to the Price API are under 2% | FAIL (no route) or WARN (over 2%): the bot would skip it; leave it unapproved or accept fewer stocks. |
| `bonding curve` | the layout the bot reads and the vault it claims from match live data | FAIL: stop; the claim code would not find the fees. Send the output. |
| `claim simulation` | `collect_creator_fee_v2` runs on mainnet | FAIL: stop and send the output. WARN without `--payer`: the coin's creator had no SOL; add `--payer`. |
| `swap simulation` | a real Jupiter swap into the first stock (with its token account) runs | FAIL: stop and send the output. |

It ends with `OK: no FAIL` or `NOT OK: N FAIL`. Exit code 1 on any FAIL. `--json` prints one line for scripts.
