import { describe, expect, it } from 'vitest';
import { STAGES, stageOfSol } from '../floor/plan';
import { roadmapModel } from './roadmap';

describe('the Company Roadmap', () => {
  it('lists every stage in order: done ones checked, the next one with its progress, the rest locked with a target', () => {
    const m = roadmapModel(stageOfSol(0.62), 0.62);
    expect(m.rows.map((r) => r.name)).toEqual(STAGES.map((s) => s.name));
    expect(m.rows.map((r) => r.status)).toEqual(['done', 'done', 'next', 'locked', 'locked', 'locked']);
    const next = m.rows[2]!;
    expect(next.text).toBe('0.62 / 1 SOL');
    expect(next.progress).toBeCloseTo(0.62, 9);
    expect(m.rows.filter((r) => r.status !== 'next').every((r) => r.progress === null)).toBe(true);
    expect(m.rows.map((r) => r.text)).toEqual(['0 SOL', '0.25 SOL', '0.62 / 1 SOL', '5 SOL', '20 SOL', '50 SOL']);
    expect(m.line).toBe('NEXT: FULL FLOOR 0.62 / 1 SOL');
  });

  it('folds to one line for a phone: the next stage and how far, or where the company is at the top', () => {
    expect(roadmapModel(2, 3.2).line).toBe('NEXT: CORPORATE 3.2 / 5 SOL');
    expect(roadmapModel(0, 0).line).toBe('NEXT: SMALL OFFICE 0 / 0.25 SOL');
    expect(roadmapModel(4, 49.99).line).toBe('NEXT: WALL STREET 49.9 / 50 SOL');
    expect(roadmapModel(5, 72.4).line).toBe('WALL STREET: 72.4 SOL');
    expect(roadmapModel(5, 72.4).rows.every((r) => r.status === 'done')).toBe(true);
    // one line on a 375 px phone (11 px monospace is about 6.6 px a character, inside a 16 px gutter)
    for (let k = 0; k < STAGES.length; k++) expect(roadmapModel(k, 49.99).line.length).toBeLessThanOrEqual(36);
  });

  it('never rounds the next stage into looking reached, and never overfills its bar', () => {
    const edge = roadmapModel(stageOfSol(0.2499), 0.2499);
    expect(edge.rows[1]!.status).toBe('next');
    expect(edge.rows[1]!.text).toBe('0.24 / 0.25 SOL');
    expect(edge.rows[1]!.progress!).toBeLessThan(1);
    const at = roadmapModel(stageOfSol(0.25), 0.25);
    expect(at.rows[1]!.status).toBe('done');
    expect(at.rows[2]!.text).toBe('0.25 / 1 SOL');
    // the stage never closes: the roadmap follows the building's stage even if a lower SOL came in
    const kept = roadmapModel(3, 1);
    expect(kept.rows.map((r) => r.status)).toEqual(['done', 'done', 'done', 'done', 'next', 'locked']);
    expect(kept.rows[4]!.progress).toBeGreaterThanOrEqual(0);
    expect(roadmapModel(1, 999).rows[2]!.progress).toBe(1);
  });
});
