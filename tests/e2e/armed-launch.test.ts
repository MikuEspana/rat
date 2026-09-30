// Armed launch end to end (in memory): the worker runs LIVE before the coin exists (no COIN_MINT) with the kill
// switch armed; founding rats are seeded; the owner's launch tx (signed by the creator wallet) waits in the watch
// while the launch is pending; rat launch-register accepts it and releases the kill switch: rats are hired in the
// next loops, no restart.
import { launchArmCommand, launchRegisterCommand, foundersSeedCommand } from '@rat/cli';
import { ARMED_KILL_REASON, SETTINGS } from '@rat/core';
import { SOL, type SimWorld, createSimWorld } from '@rat/worker';
import { Keypair, SystemProgram } from '@solana/web3.js';
import { afterEach, describe, expect, it } from 'vitest';

let w: SimWorld;
afterEach(async () => w?.close());

async function ownerLaunchTx(world: SimWorld): Promise<string> {
  const req = {
    kind: 'claim' as const,
    label: 'owner launch',
    feePayer: world.creator,
    signers: [],
    instructions: [SystemProgram.transfer({ fromPubkey: world.creator.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1_000_000 })],
    computeUnitLimit: 50_000,
  };
  const out = await world.simSender.submit(await world.simSender.prepare(req));
  expect(out.status).toBe('confirmed');
  return out.signature;
}

describe('armed launch (no COIN_MINT, kill switch armed, one launch-register call)', () => {
  it('founding rats are hired right after launch-register, the launch tx never kills the bot', async () => {
    w = await createSimWorld({ dryRun: false, creatorSol: SOL, env: { COIN_MINT: '' } });
    expect(w.deps.config.coinMint).toBeUndefined();
    const lines: string[] = [];
    const ctx = { config: w.deps.config, store: w.store, clock: w.clock, out: (l: string) => lines.push(l) };

    expect(await launchArmCommand(ctx)).toBe(true);
    expect((await foundersSeedCommand(ctx, { chain: w.reader }, { rats: '3', confirm: 'FOUNDERS 3 RATS' })).executed).toBe(true);
    await w.run(120);
    expect(await w.store.rats.listByStatus(['hiring', 'active'])).toHaveLength(0);
    expect(await w.store.settings.get(SETTINGS.killReason)).toBe(ARMED_KILL_REASON);

    // the owner launches on pump.fun from the creator wallet
    w.chain.advanceBlocks(10);
    const launch = await ownerLaunchTx(w);
    await w.run(120);
    expect(await w.store.settings.get(SETTINGS.killReason)).toBe(ARMED_KILL_REASON);
    expect(w.alerts.keys()).not.toContain(`unknown_signed_${launch}`);
    expect(await w.store.rats.listByStatus(['hiring', 'active'])).toHaveLength(0);

    expect(await launchRegisterCommand(ctx, w.reader, w.coinMint, { sigs: launch })).toBe(true);
    expect(lines.at(-1)).toMatch(/kill switch released/);
    await w.run(180);
    expect((await w.deps.killSwitch.status()).on).toBe(false);
    expect(w.alerts.keys()).toContain(`owner_tx_${launch}`);
    expect(w.alerts.keys()).not.toContain(`unknown_signed_${launch}`);
    expect((await w.store.rats.listByStatus(['active'])).length).toBe(3);

    // the protection is back to normal: any other creator-signed tx kills
    w.chain.advanceBlocks(5);
    await ownerLaunchTx(w);
    await w.run(60);
    expect(await w.store.settings.get(SETTINGS.killReason)).toMatch(/unknown transaction signed/);
  });
});
