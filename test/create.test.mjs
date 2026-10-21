import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const cli = fileURLToPath(new URL('../index.mjs', import.meta.url));

// All cloud calls and external commands are local fakes. No repo or deck is published.
function create(t, { replace, available = true, exists = true, extra = [] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-ide-create-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  const stub = `#!${process.execPath}
import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
const command = path.basename(process.argv[1]);
fs.appendFileSync(process.env.TEST_COMMANDS, JSON.stringify([command, ...args]) + '\\n');
if (command === 'gh' && args[0] === 'repo' && args[1] === 'view') process.exit(1);
if (command === 'gh' && args[0] === 'api') console.log('tester');
if (command === 'git' && args[0] === 'clone') fs.mkdirSync(args.at(-1), { recursive: true });
if (command === 'git' && args[0] === 'log') console.log('abc123 template');
process.stdin.resume();
`;
  for (const command of ['git', 'gh', 'pnpm']) {
    // .mjs symlinks preserve ESM parsing while retaining the invoked command name.
    fs.writeFileSync(path.join(bin, `${command}.mjs`), stub, { mode: 0o755 });
    fs.symlinkSync(`${command}.mjs`, path.join(bin, command));
  }
  const conf = path.join(root, 'config');
  fs.mkdirSync(path.join(conf, 'sl-ide'), { recursive: true });
  fs.writeFileSync(path.join(conf, 'sl-ide', 'credentials.json'), JSON.stringify({ teams: { acme: { token: 'fake-token' } } }));
  const preload = path.join(root, 'cloud.mjs');
  fs.writeFileSync(preload, `globalThis.fetch = async (url) => {
    const slug = new URL(url).pathname.split('/').at(-1);
    const json = slug === 'whoami' ? { team: 'acme' }
      : slug === 'pitch' ? ${JSON.stringify({ available, exists, reason: 'unauthorized' })}
      : { available: true, exists: false };
    return { ok: true, status: 200, json: async () => json };
  };`);
  const commands = path.join(root, 'commands');
  const result = spawnSync(process.execPath, ['--import', preload, cli, 'pitch', '--yes', '--no-install', '--team', 'acme', ...(replace === undefined ? [] : ['--replace', replace]), ...extra], {
    cwd: root,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, XDG_CONFIG_HOME: conf, TEST_COMMANDS: commands },
    encoding: 'utf8', timeout: 15000,
  });
  const configPath = path.join(root, 'pitch', 'sl-ide.config.json');
  return { result, config: fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath)) : null,
    commands: fs.existsSync(commands) ? fs.readFileSync(commands, 'utf8') : '' };
}

test('--yes chooses a fresh slug and writes it into publishing config', (t) => {
  const { result, config, commands } = create(t);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.deepEqual(config, { slug: 'pitch-2', team: 'acme', visibility: 'team' });
  assert.match(commands, /Publish to sl-ide cloud as pitch-2/);
});

test('an unused slug stays unchanged', (t) => {
  const { result, config } = create(t, { exists: false });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.equal(config.slug, 'pitch');
});

test('explicit replacement writes the existing slug', (t) => {
  const { result, config } = create(t, { replace: 'pitch' });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.equal(config.slug, 'pitch');
});

for (const options of [{ available: false }, { replace: 'pitch', exists: false }, { replace: 'pitch', available: false }, { replace: 'pitch', extra: ['--no-publish'] }, { replace: 'pitch', extra: ['--github', 'none'] }]) {
  test(`unsafe or disabled publishing stops before cloning: ${JSON.stringify(options)}`, (t) => {
    const { result, config, commands } = create(t, options);
    assert.equal(result.status, 1, result.stderr + result.stdout);
    assert.equal(config, null);
    assert.doesNotMatch(commands, /"clone"|"create"|"push"/);
  });
}
