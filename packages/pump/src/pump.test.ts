import { NATIVE_SOL_MINT, TOKEN_2022_PROGRAM, TOKEN_PROGRAM, type TxRequest } from '@rat/core';
import { SIGNATURE_FEE, SimChain, SimChainReader, SimTxSender } from '@rat/chain/sim';
import { Keypair, PublicKey, SystemProgram } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import idl from '../fixtures/creator-fee-idl.json';
import { PumpFunClient } from './client';
import { DISCRIMINATORS, PUMP_AMM_PROGRAM_ID, PUMP_PROGRAM_ID } from './constants';
import { collectCoinCreatorFeeIx, collectCreatorFeeV2Ix } from './instructions';
import { creatorAccounts } from './pdas';
import { accrueCreatorFees, registerPumpSimPrograms } from './sim';

const SOL = 1_000_000_000n;

describe('IDL conformance', () => {
  const creator = Keypair.generate().publicKey.toBase58();

  it('program ids and discriminators match the official IDL', () => {
    expect(idl.programs.pump.address).toBe(PUMP_PROGRAM_ID);
    expect(idl.programs.pump_amm.address).toBe(PUMP_AMM_PROGRAM_ID);
    expect(Array.from(DISCRIMINATORS.collectCreatorFeeV2)).toEqual(idl.programs.pump.instructions.collect_creator_fee_v2.discriminator);
    expect(Array.from(DISCRIMINATORS.collectCreatorFee)).toEqual(idl.programs.pump.instructions.collect_creator_fee.discriminator);
    expect(Array.from(DISCRIMINATORS.collectCoinCreatorFee)).toEqual(idl.programs.pump_amm.instructions.collect_coin_creator_fee.discriminator);
  });

  it('collect_creator_fee_v2 accounts: order, writability, fixed addresses, PDA seeds', () => {
    const ix = collectCreatorFeeV2Ix(creator);
    const spec = idl.programs.pump.instructions.collect_creator_fee_v2.accounts;
    expect(ix.keys.length).toBe(spec.length);
    spec.forEach((s, i) => {
      expect(ix.keys[i]!.isWritable, s.name).toBe(s.writable);
      expect(ix.keys[i]!.isSigner, s.name).toBe(s.signer);
      if ('address' in s && s.address) expect(ix.keys[i]!.pubkey.toBase58(), s.name).toBe(s.address);
    });
    const vaultSeeds = spec.find((s) => s.name === 'creator_vault')!.pdaSeeds!;
    expect(vaultSeeds).toEqual([{ const: 'creator-vault' }, { account: 'creator' }]);
    const [vault] = PublicKey.findProgramAddressSync([Buffer.from('creator-vault'), new PublicKey(creator).toBuffer()], new PublicKey(PUMP_PROGRAM_ID));
    expect(ix.keys[2]!.pubkey.toBase58()).toBe(vault.toBase58());
    expect(ix.keys[0]!.pubkey.toBase58()).toBe(creator);
    expect(ix.keys[4]!.pubkey.toBase58()).toBe(NATIVE_SOL_MINT);
    expect(ix.keys[9]!.pubkey.toBase58()).toBe(PUMP_PROGRAM_ID);
  });

  it('collect_coin_creator_fee accounts: order, writability, PDA seeds', () => {
    const ix = collectCoinCreatorFeeIx(creator);
    const spec = idl.programs.pump_amm.instructions.collect_coin_creator_fee.accounts;
    expect(ix.keys.length).toBe(spec.length);
    spec.forEach((s, i) => {
      expect(ix.keys[i]!.isWritable, s.name).toBe(s.writable);
      expect(ix.keys[i]!.isSigner, s.name).toBe(s.signer);
    });
    expect(spec.find((s) => s.name === 'coin_creator_vault_authority')!.pdaSeeds).toEqual([{ const: 'creator_vault' }, { account: 'coin_creator' }]);
    const a = creatorAccounts(creator);
    expect(ix.keys[2]!.pubkey.toBase58()).toBe(creator);
    expect(ix.keys[3]!.pubkey.toBase58()).toBe(a.ammVaultAuthority);
    expect(ix.keys[4]!.pubkey.toBase58()).toBe(a.ammVaultAta);
    expect(ix.keys[5]!.pubkey.toBase58()).toBe(a.creatorWsolAta);
  });
});

function world() {
  const chain = new SimChain();
  registerPumpSimPrograms(chain);
  const sender = new SimTxSender(chain);
  const reader = new SimChainReader(chain);
  const pump = new PumpFunClient(reader);
  const creator = Keypair.generate();
  chain.fundAccount(creator.publicKey.toBase58(), SOL / 10n);
  const req = (payer: Keypair, instructions: TxRequest['instructions']): TxRequest => ({
    kind: 'claim',
    label: 'claim',
    feePayer: payer,
    signers: [],
    instructions,
    computeUnitLimit: 200_000,
  });
  return { chain, sender, reader, pump, creator, req };
}

describe('claims on SimChain', () => {
  it('claims both vaults, unwraps WSOL, and measures exactly what left our vaults', async () => {
    const { chain, sender, pump, creator, req } = world();
    const c = creator.publicKey.toBase58();
    accrueCreatorFees(chain, c, { bondingLamports: 1n * SOL, ammLamports: SOL / 2n });
    const claimable = await pump.getClaimable(c);
    expect(claimable).toMatchObject({ bondingLamports: SOL, ammLamports: SOL / 2n, totalLamports: (3n * SOL) / 2n, creatorWsolLamports: 0n });
    const ixs = pump.buildClaimInstructions({ creator: c, claimable });
    expect(ixs.length).toBe(4);
    const before = chain.sol(c);
    const out = await sender.submit(await sender.prepare(req(creator, ixs)));
    expect(out.status).toBe('confirmed');
    expect(chain.sol(c) - before).toBe((3n * SOL) / 2n - SIGNATURE_FEE);
    expect(pump.parseClaim(out.record!, c)).toEqual({ bondingLamports: SOL, ammLamports: SOL / 2n, totalLamports: (3n * SOL) / 2n });
    expect((await pump.getClaimable(c)).totalLamports).toBe(0n);
  });

  it('bonding-only claim needs no unwrap; nothing claimable builds nothing', async () => {
    const { chain, pump, creator } = world();
    const c = creator.publicKey.toBase58();
    expect(pump.buildClaimInstructions({ creator: c, claimable: await pump.getClaimable(c) })).toEqual([]);
    accrueCreatorFees(chain, c, { bondingLamports: SOL });
    const ixs = pump.buildClaimInstructions({ creator: c, claimable: await pump.getClaimable(c) });
    expect(ixs.map((i) => i.programId.toBase58())).toEqual([PUMP_PROGRAM_ID]);
  });

  it('detects an external claim of OUR vault signed by someone else, ignores other creators and failed txs', async () => {
    const { chain, sender, pump, creator, req } = world();
    const c = creator.publicKey.toBase58();
    const stranger = Keypair.generate();
    chain.fundAccount(stranger.publicKey.toBase58(), SOL);
    accrueCreatorFees(chain, c, { bondingLamports: 2n * SOL });
    const out = await sender.submit(await sender.prepare(req(stranger, [collectCreatorFeeV2Ix(c)])));
    expect(out.status).toBe('confirmed');
    expect(pump.parseClaim(out.record!, c)?.totalLamports).toBe(2n * SOL);

    const other = Keypair.generate().publicKey.toBase58();
    accrueCreatorFees(chain, other, { bondingLamports: SOL });
    const out2 = await sender.submit(await sender.prepare(req(stranger, [collectCreatorFeeV2Ix(other)])));
    expect(pump.parseClaim(out2.record!, c)).toBeNull();

    const plain = await sender.submit(
      await sender.prepare(req(stranger, [SystemProgram.transfer({ fromPubkey: stranger.publicKey, toPubkey: creator.publicKey, lamports: 1_000_000 })])),
    );
    expect(pump.parseClaim(plain.record!, c)).toBeNull();

    accrueCreatorFees(chain, c, { bondingLamports: SOL });
    sender.failNext('fail');
    const failed = await sender.submit(await sender.prepare(req(stranger, [collectCreatorFeeV2Ix(c)])));
    expect(failed.status).toBe('failed');
    expect(pump.parseClaim(failed.record!, c)).toBeNull();
  });

  it('leftover creator WSOL (from an external AMM claim) is unwrapped on our next claim', async () => {
    const { chain, sender, pump, creator, req } = world();
    const c = creator.publicKey.toBase58();
    chain.setTokenBalance(c, NATIVE_SOL_MINT, SOL / 4n, TOKEN_PROGRAM);
    const claimable = await pump.getClaimable(c);
    expect(claimable.creatorWsolLamports).toBe(SOL / 4n);
    const ixs = pump.buildClaimInstructions({ creator: c, claimable });
    expect(ixs.length).toBe(2);
    const before = chain.sol(c);
    await sender.submit(await sender.prepare(req(creator, ixs)));
    expect(chain.sol(c)).toBeGreaterThan(before + SOL / 4n - SIGNATURE_FEE);
  });
});

describe('coin info', () => {
  for (const program of [TOKEN_PROGRAM, TOKEN_2022_PROGRAM]) {
    it(`detects the token program (${program === TOKEN_PROGRAM ? 'SPL Token' : 'Token-2022'})`, async () => {
      const { chain, pump } = world();
      const mint = Keypair.generate().publicKey.toBase58();
      chain.createMint({ mint, decimals: 6, tokenProgram: program, supply: 1_000_000_000n });
      const info = await pump.getCoinInfo(mint);
      expect(info).toMatchObject({ tokenProgram: program, decimals: 6, supply: 1_000_000_000n });
    });
  }

  it('rejects unknown coin mints', async () => {
    const { pump } = world();
    await expect(pump.getCoinInfo(Keypair.generate().publicKey.toBase58())).rejects.toThrow(/not found/);
  });
});
