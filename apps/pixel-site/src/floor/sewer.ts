// Where new rats come from: the sewer. It grows with the hires, from one rusty manhole to a giant portal, in front of
// the current lobby (on its apron and sidewalk, spawn zone). Pure: stages, and the tiles each part stands on.
import type { Cell } from '../iso';

export interface SpawnStage {
  /** hires from which it shows */
  min: number;
  name: string;
}

export const SPAWN_STAGES: SpawnStage[] = [
  { min: 0, name: 'ONE RUSTY MANHOLE' },
  { min: 50, name: 'MANHOLES AND STEAM VENTS' },
  { min: 250, name: 'THE GLOWING GRATE' },
  { min: 1000, name: 'THE HIRING TUNNEL' },
  { min: 3000, name: 'THE SEWER PORTAL' },
];

export function spawnStageOf(rats: number): number {
  let s = 0;
  for (let k = 0; k < SPAWN_STAGES.length; k++) if (rats >= SPAWN_STAGES[k]!.min) s = k;
  return s;
}

export type SewerKind = 'manhole' | 'vent' | 'grate' | 'tunnel' | 'portal';

export interface SewerPart {
  kind: SewerKind;
  /** top-left cell and size (cells) */
  i0: number;
  j0: number;
  w: number;
  h: number;
  /** the main way out: rats climb out of this one */
  main: boolean;
}

/** The parts of the sewer at a stage, round the spawn cell (the lobby door is 4 cells towards -j). */
export function sewerParts(stage: number, spawn: Cell): SewerPart[] {
  const { i, j } = spawn;
  const out: SewerPart[] = [];
  // the main way out, bigger every stage: its front edge sits on the spawn row
  if (stage >= 4) out.push({ kind: 'portal', i0: i - 2, j0: j - 3, w: 4, h: 4, main: true });
  else if (stage === 3) out.push({ kind: 'tunnel', i0: i - 1, j0: j - 2, w: 3, h: 3, main: true });
  else if (stage === 2) out.push({ kind: 'grate', i0: i - 1, j0: j - 1, w: 2, h: 2, main: true });
  else out.push({ kind: 'manhole', i0: i, j0: j, w: 1, h: 1, main: true });
  // more manholes along the sidewalk, and steam vents on the apron (from 50 hires)
  if (stage >= 1) {
    out.push({ kind: 'manhole', i0: i - 5, j0: j, w: 1, h: 1, main: false });
    out.push({ kind: 'manhole', i0: i + 5, j0: j, w: 1, h: 1, main: false });
    out.push({ kind: 'vent', i0: i - 3, j0: j - 3, w: 1, h: 1, main: false });
    out.push({ kind: 'vent', i0: i + 3, j0: j - 3, w: 1, h: 1, main: false });
  }
  if (stage >= 2 && stage < 3) out.push({ kind: 'manhole', i0: i + 2, j0: j, w: 1, h: 1, main: false });
  return out;
}
