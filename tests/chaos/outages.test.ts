// B. The RPC goes down from every RPC call of a hire / burn on, then comes back.
// C. The database drops from every database call of a hire / burn on (mid-transaction), then comes back.
// The same process keeps running afterwards; every lamport must be accounted for. Runs in the `chaos` CI job.
import { describe, it } from 'vitest';
import type { OpKind } from './chaos';
import { MATRIX, everyPoint, opsOf, scenario } from './scenario';

for (const [kind, title] of [
  ['rpc', 'B. RPC down from every RPC call of a hire and a burn, then back'],
  ['db', 'C. database drops from every database call of a hire and a burn, then comes back'],
] as [OpKind, string][]) {
  describe(title, () => {
    for (const [mode, step, variant] of MATRIX) {
      it(`${step} (${mode}, ${variant})`, async () => {
        const calls = (await opsOf(mode, step, variant)).filter((o) => o.kind === kind);
        await everyPoint(
          calls.length,
          (k) => `${kind} down from call ${k} (${calls[k - 1]!.name})`,
          (k) => scenario(mode, step, (c) => (c.failing = { kind, from: k }), 'same_process', variant),
        );
      }, 900_000);
    }
  });
}
