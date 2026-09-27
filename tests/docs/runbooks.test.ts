// Runbooks and infra config must only reference things that exist.
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const root = new URL('../../', import.meta.url);
const read = (p: string) => readFileSync(new URL(p, root), 'utf8');
const runbooks = readdirSync(new URL('docs/runbooks/', root)).filter((f) => f.endsWith('.md'));

describe('infra config', () => {
  it('railway files are valid and point at the Dockerfile', () => {
    for (const f of ['infra/railway.worker.json', 'infra/railway.api.json']) {
      const j = JSON.parse(read(f)) as { build: { dockerfilePath: string }; deploy: { startCommand: string } };
      expect(j.build.dockerfilePath).toBe('infra/Dockerfile');
      expect(j.deploy.startCommand).toMatch(/^pnpm --filter @rat\/(worker|api) start$/);
    }
    expect(JSON.parse(read('infra/railway.worker.json')).deploy.numReplicas).toBe(1);
    const docker = read('infra/Dockerfile');
    expect(docker).toContain('pnpm install --frozen-lockfile');
    expect(docker).toMatch(/DRY_RUN=true/);
    expect(docker).toContain('USER node');
    // every workspace package.json is copied before the install
    for (const dir of ['packages/core', 'packages/contract', 'packages/db', 'packages/keys', 'packages/chain', 'packages/pump', 'packages/jupiter', 'packages/safety', 'apps/worker', 'apps/api', 'apps/cli', 'tests']) {
      expect(docker, dir).toContain(`COPY ${dir}/package.json ${dir}/`);
    }
  });
});

describe('runbooks', () => {
  const cli = read('apps/cli/src/main.ts');
  const commands = new Set<string>();
  for (const m of cli.matchAll(/\.command\('([a-z-]+)/g)) commands.add(m[1]!);
  const env = new Set(read('.env.example').split('\n').map((l) => l.split('=')[0]!.trim()).filter((k) => /^[A-Z0-9_]+$/.test(k)));
  const extraEnv = new Set(['KEY_ENCRYPTION_KEY_PREVIOUS', 'KEY_VERSION_PREVIOUS', 'PORT', 'DATABASE_URL', 'RUN_SLOW_GRIND']);

  it('every `rat <command>` in the runbooks exists in the CLI', () => {
    for (const f of runbooks) {
      for (const m of read(`docs/runbooks/${f}`).matchAll(/(?:`|^)rat ([a-z-]+)/gm)) {
        expect(commands.has(m[1]!), `${f}: rat ${m[1]}`).toBe(true);
      }
    }
  });

  it('every env var named in the runbooks exists in .env.example (or is documented as extra)', () => {
    for (const f of runbooks) {
      for (const m of read(`docs/runbooks/${f}`).matchAll(/`([A-Z][A-Z0-9_]{3,})(=[^`]*)?`/g)) {
        const name = m[1]!;
        expect(env.has(name) || extraEnv.has(name), `${f}: ${name}`).toBe(true);
      }
    }
  });

  it('runbooks never contain a secret value', () => {
    for (const f of runbooks) {
      const text = read(`docs/runbooks/${f}`);
      expect(text).not.toMatch(/KEY_ENCRYPTION_KEY=[A-Za-z0-9+/]{20,}/);
      expect(text).not.toMatch(/JUPITER_API_KEY=[A-Za-z0-9-]{8,}/);
    }
  });
});
