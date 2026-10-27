import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// Exercise the real runner with cheap isolated commands, including a broken ref.
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-ide-bench-check-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const child of ['scripts', 'bench', 'bin']) fs.mkdirSync(path.join(dir, child));
  fs.copyFileSync(new URL('./bench.mjs', import.meta.url), path.join(dir, 'scripts/bench.mjs'));
  const baseline = JSON.stringify({ commands: { test: { median_ms: 1000 } } });
  fs.writeFileSync(path.join(dir, 'bench/baseline.json'), baseline);
  fs.writeFileSync(path.join(dir, 'bin/pnpm'), `#!${process.execPath}
if (process.argv.includes('install')) process.exit(0);
const base = process.cwd().includes('sl-ide-bench-ref-');
process.exit((base ? process.env.FAIL_BASE : process.env.FAIL_CURRENT) === '1' ? 23 : 0);
`, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'bin/git'), `#!${process.execPath}
import fs from 'node:fs';
if (process.argv[3] === 'remove') fs.rmSync(process.argv.at(-1), { recursive: true, force: true });
`, { mode: 0o755 });
  return {
    baseline: () => fs.readFileSync(path.join(dir, 'bench/baseline.json'), 'utf8'),
    original: baseline,
    run: (args, env = {}) => spawnSync(process.execPath, [path.join(dir, 'scripts/bench.mjs'), '--runs', '1', ...args], {
      cwd: dir, env: { ...process.env, GITHUB_STEP_SUMMARY: '', PATH: `${path.join(dir, 'bin')}:${process.env.PATH}`, ...env },
      encoding: 'utf8', timeout: 10000,
    }),
  };
}

test('a failed comparison ref fails the run and has no speedup', (t) => {
  const box = fixture(t);
  const r = box.run(['--compare', 'old-ref', 'test'], { FAIL_BASE: '1' });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stdout, /\| test \| [^\n]*\(failed\)[^\n]*\| — \|/);
});

test('a failed current command cannot replace a saved baseline', (t) => {
  const box = fixture(t);
  const r = box.run(['--compare', '--save', 'test'], { FAIL_CURRENT: '1' });
  assert.equal(r.status, 1, r.stderr);
  assert.equal(box.baseline(), box.original);
  assert.match(r.stderr, /refusing to save/);
  assert.match(r.stdout, /\| test \| [^\n]*\| — \|/);
});

test('successful commands still compare and save', (t) => {
  const box = fixture(t);
  const r = box.run(['--compare', '--save', 'test']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /\| test \| [^\n]*\| [\d.]+x \|/);
  assert.notEqual(box.baseline(), box.original);
});
