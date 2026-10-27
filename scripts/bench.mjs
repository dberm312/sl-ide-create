#!/usr/bin/env node
// Time this repo's suites and checks, and compare them against a baseline.
//
//   pnpm bench                  every command 3 times -> output/bench.json
//   pnpm bench --runs 5         more runs (median and min are reported)
//   pnpm bench --compare        ratio against bench/baseline.json
//   pnpm bench --compare main   run the same commands at a git ref, on this
//                               machine, and compare against that instead
//   pnpm bench --save           write the results as bench/baseline.json
//
// Prints the 10 slowest tests from the last run of each test suite. In CI it
// appends a table to $GITHUB_STEP_SUMMARY and warns (never fails) on a command
// over 1.5x its baseline. Exits 1 if a command fails.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// name -> argv, and how to get per-test times as JUnit XML (written to `file`).
const junit = {
  node: (file) => ({ env: { NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --test-reporter=junit --test-reporter-destination=${file}` } }),
};
const COMMANDS = {
  test: { argv: ['pnpm', 'test'], tests: junit.node },
};
const SLOW = 1.5;

const root = path.resolve(import.meta.dirname, '..');
const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); if (i !== -1) argv.splice(i, 1); return i !== -1; };
const value = (name, fallback) => {
  const i = argv.indexOf(name);
  if (i === -1) return fallback;
  const [, v] = argv.splice(i, 2);
  return v;
};
const runs = Number(value('--runs', '3'));
const save = flag('--save');
const ci = argv.indexOf('--compare');
const compare = ci !== -1;
let ref = null;
if (compare) {
  const next = argv[ci + 1];
  ref = next && !next.startsWith('--') && !COMMANDS[next] ? next : null;
  argv.splice(ci, ref ? 2 : 1);
}
const names = argv.length ? argv : Object.keys(COMMANDS);
for (const n of names) if (!COMMANDS[n]) throw new Error(`unknown command "${n}" (known: ${Object.keys(COMMANDS).join(', ')})`);
if (!(runs >= 1)) throw new Error('--runs needs a positive number');

const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };
const attr = (s, k) => new RegExp(`\\b${k}="([^"]*)"`).exec(s)?.[1]?.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
const slowest = (file) => {
  if (!fs.existsSync(file)) return [];
  return [...fs.readFileSync(file, 'utf8').matchAll(/<testcase\b([^>]*)>/g)]
    .map(([, a]) => ({ test: attr(a, 'name'), file: path.relative(root, attr(a, 'file') ?? attr(a, 'classname') ?? ''), ms: Math.round(Number(attr(a, 'time')) * 1000) }))
    .sort((a, b) => b.ms - a.ms).slice(0, 10);
};

function bench(cwd, label) {
  const results = {};
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-ide-bench-'));
  try {
    for (const name of names) {
      const { argv: [cmd, ...args], tests } = COMMANDS[name];
      const ms = [];
      let ok = true;
      let slow = [];
      for (let i = 0; i < runs && ok; i++) {
        const file = path.join(tmp, `${name.replace(/\W/g, '_')}-${i}.xml`);
        const extra = tests?.(file) ?? {};
        const start = performance.now();
        const r = spawnSync(cmd, [...args, ...(extra.args ?? [])], { cwd, env: { ...process.env, ...extra.env }, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
        ms.push(Math.round(performance.now() - start));
        ok = r.status === 0;
        if (!ok) process.stderr.write(`${label} ${name} failed (exit ${r.status ?? r.signal}):\n${`${r.stdout}${r.stderr}`.slice(-4000)}\n`);
        if (tests) slow = slowest(file);
      }
      results[name] = { median_ms: Math.round(median(ms)), min_ms: Math.min(...ms), runs_ms: ms, ok };
      if (slow.length) results[name].slowest = slow;
      console.log(`${label} ${name}: median ${(results[name].median_ms / 1000).toFixed(2)} s, min ${(results[name].min_ms / 1000).toFixed(2)} s${ok ? '' : ' (FAILED)'}`);
    }
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  return results;
}

// A git ref benched in a throwaway worktree, so both sides share this machine.
function atRef(gitRef) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-ide-bench-ref-'));
  const git = (...a) => spawnSync('git', a, { cwd: root, stdio: 'inherit' });
  if (git('worktree', 'add', '--detach', dir, gitRef).status !== 0) throw new Error(`could not check out ${gitRef}`);
  try {
    if (spawnSync('pnpm', ['install', '--frozen-lockfile', '--prefer-offline', '--silent'], { cwd: dir, stdio: 'inherit' }).status !== 0) throw new Error(`pnpm install failed at ${gitRef}`);
    return bench(dir, gitRef);
  } finally { git('worktree', 'remove', '--force', dir); }
}

const machine = { cpus: os.cpus().length, cpu: os.cpus()[0]?.model, os: `${os.platform()} ${os.release()}`, node: process.version };
const base = !compare ? null : ref ? { label: ref, machine, commands: atRef(ref) }
  : { label: 'bench/baseline.json', ...JSON.parse(fs.readFileSync(path.join(root, 'bench/baseline.json'), 'utf8')) };
const commands = bench(root, 'now');
const report = { date: new Date().toISOString(), runs, machine, commands, ...(base && { baseline: { label: base.label, machine: base.machine, commands: base.commands } }) };
fs.mkdirSync(path.join(root, 'output'), { recursive: true });
fs.writeFileSync(path.join(root, 'output/bench.json'), `${JSON.stringify(report, null, 2)}\n`);
const failed = Object.values(commands).some((r) => !r.ok) || Object.values(base?.commands ?? {}).some((r) => r.ok === false);
if (save && failed) console.error('error: refusing to save a baseline because a benchmark command failed');
if (save && !failed) fs.writeFileSync(path.join(root, 'bench/baseline.json'), `${JSON.stringify({ date: report.date, machine, commands: Object.fromEntries(Object.entries(commands).map(([k, { median_ms, min_ms }]) => [k, { median_ms, min_ms }])) }, null, 2)}\n`);

const s = (msVal) => (msVal === undefined ? '—' : `${(msVal / 1000).toFixed(2)} s`);
const rows = names.map((n) => {
  const now = commands[n].median_ms;
  const was = base?.commands[n]?.median_ms;
  const baselineOk = base?.commands[n]?.ok !== false;
  const ratio = was && commands[n].ok && baselineOk ? was / now : undefined;
  return { n, now, was, ratio, baselineOk, ok: commands[n].ok };
});
const table = [
  base ? `| command | ${base.label} | now | speedup |` : '| command | median | min |',
  base ? '|---|---:|---:|---:|' : '|---|---:|---:|',
  ...rows.map((r) => (base
    ? `| ${r.n} | ${s(r.was)}${r.baselineOk ? '' : ' (failed)'} | ${s(r.now)}${r.ok ? '' : ' (failed)'} | ${r.ratio ? `${r.ratio.toFixed(2)}x` : '—'} |`
    : `| ${r.n} | ${s(r.now)}${r.ok ? '' : ' (failed)'} | ${s(commands[r.n].min_ms)} |`)),
].join('\n');
console.log(`\n${table}`);
for (const n of names) {
  if (!commands[n].slowest) continue;
  console.log(`\nslowest tests in ${n}:`);
  for (const t of commands[n].slowest) console.log(`  ${s(t.ms).padStart(8)}  ${t.file ? `${t.file} › ` : ''}${t.test}`);
}
for (const r of rows) {
  if (r.ratio && r.ratio < 1 / SLOW) {
    const msg = `${r.n} took ${s(r.now)}, over ${SLOW}x its baseline (${s(r.was)})`;
    console.log(process.env.GITHUB_ACTIONS ? `::warning::${msg}` : `warning: ${msg}`);
  }
}
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n### Bench (${runs} run${runs > 1 ? 's' : ''}, ${machine.cpus} CPUs)\n\n${table}\n`);
if (failed) process.exitCode = 1;
