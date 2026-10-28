// Invoked by the private cloud's integration suite, where disposable providers
// already exist. Only GitHub is replaced: git, the CLI, template and publisher
// all run for real. Never contacts GitHub or uses a developer's saved credentials.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../../index.mjs', import.meta.url));

export async function runCreateSmoke({ base, token, owner, templateDir, format = 'slides' }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sl-ide-cross-repo-'));
  const bin = path.join(root, 'bin');
  const work = path.join(root, 'work');
  const conf = path.join(root, 'config');
  const secret = path.join(root, 'publish-token');
  const remote = path.join(root, 'remote.git');
  const name = `smoke-${format}-${path.basename(root).toLowerCase().replace(/[^a-z0-9]/g, '').slice(-6)}`;
  const env = {
    PATH: `${bin}:${process.env.PATH}`, HOME: root, XDG_CONFIG_HOME: conf,
    GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Smoke test', GIT_AUTHOR_EMAIL: 'smoke@example.invalid',
    GIT_COMMITTER_NAME: 'Smoke test', GIT_COMMITTER_EMAIL: 'smoke@example.invalid',
    SL_IDE_URL: base, SL_IDE_TEMPLATE: templateDir,
    SMOKE_REMOTE: remote, SMOKE_SECRET: secret,
    ...(process.env.CHROME ? { CHROME: process.env.CHROME } : {}),
  };
  const run = (command, args, cwd = work, extraEnv = {}) => new Promise((resolve, reject) => {
    execFile(command, args, { cwd, env: { ...env, ...extraEnv }, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(`${command} ${args.join(' ')} failed: ${stdout}\n${stderr}`));
      else resolve(stdout.trim());
    });
  });
  try {
    await Promise.all([fs.mkdir(bin), fs.mkdir(work), fs.mkdir(path.join(conf, 'sl-ide'), { recursive: true })]);
    await fs.writeFile(path.join(conf, 'sl-ide', 'credentials.json'), JSON.stringify({ version: 3,
      servers: { [base]: { owner, token } } }), { mode: 0o600 });
    await fs.writeFile(path.join(bin, 'gh'), `#!${process.execPath}
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
const a = process.argv.slice(2);
if (a[0] === 'auth') process.exit(0);
if (a[0] === 'api') { console.log('smoke-user'); process.exit(0); }
if (a[0] === 'repo' && a[1] === 'view') process.exit(1);
if (a[0] === 'repo' && a[1] === 'create') {
  execFileSync('git', ['init', '--bare', '-q', process.env.SMOKE_REMOTE]);
  execFileSync('git', ['remote', 'add', 'origin', process.env.SMOKE_REMOTE]);
} else if (a[0] === 'repo' && a[1] === 'set-default') process.exit(a[2] === 'smoke-user/${name}' ? 0 : 3);
else if (a[0] === 'secret' && a[1] === 'set') fs.writeFileSync(process.env.SMOKE_SECRET, fs.readFileSync(0), { mode: 0o600 });
else process.exit(2);
`, { mode: 0o755 });
    // Node must parse the executable fake gh as ESM even outside a package.
    await fs.writeFile(path.join(bin, 'package.json'), '{"type":"module"}');
    const out = await run(process.execPath, [cli, name, '--format', format, '--github', 'private', '--no-install', '--yes']);
    assert.doesNotMatch(out, /gh repo set-default/, 'gh in the deck should default to its own repo');
    const deck = path.join(work, name);
    const config = JSON.parse(await fs.readFile(path.join(deck, 'sl-ide.config.json'), 'utf8'));
    assert.deepEqual(config, { slug: name, url: base });
    // The repo holds a token for this deck only, never the account token.
    const deckToken = await fs.readFile(secret, 'utf8');
    assert.notEqual(deckToken, token);
    const who = await (await fetch(`${base}/api/cli/whoami`, { headers: { Authorization: `Bearer ${deckToken}` } })).json();
    assert.equal(who.deck, name);
    const other = await fetch(`${base}/api/publish/${name}-other/${'0'.repeat(40)}/index.html`, {
      method: 'PUT', headers: { Authorization: `Bearer ${deckToken}`, 'X-Sl-Ide-Upload-Id': randomUUID() }, body: 'x',
    });
    assert.equal(other.status, 403, 'a deck token must not publish another deck');
    assert.equal(await run('git', ['remote', 'get-url', 'upstream'], deck), templateDir);
    const sha = await run('git', ['rev-parse', 'HEAD'], deck);
    assert.equal(await run('git', ['--git-dir', remote, 'rev-parse', 'refs/heads/main']), sha);
    // Install into the real clone: pnpm rejects a node_modules symlink outside
    // the project, and a real install also checks the generated lockfile flow.
    await run('pnpm', ['install', '--frozen-lockfile'], deck);
    // macOS Chrome's sandbox cannot load pages with a fabricated HOME.
    // The template gives Chrome a disposable profile; CLI credentials and
    // config remain isolated under XDG_CONFIG_HOME throughout this test.
    await run('pnpm', ['pdf'], deck, process.platform === 'darwin' ? { HOME: os.homedir() } : {});
    env.SL_IDE_PUBLISH_TOKEN = await fs.readFile(secret, 'utf8');
    env.GITHUB_SHA = sha;
    env.GITHUB_REF_NAME = 'main';
    env.GITHUB_REPOSITORY = `smoke-user/${name}`;
    await run(process.execPath, ['scripts/publish-deck.mjs'], deck);
    const pdfs = (await fs.readdir(path.join(deck, 'output'))).filter(name => name.endsWith('.pdf'));
    assert.equal(pdfs.length, 1);
    const pdf = await fs.readFile(path.join(deck, 'output', pdfs[0]));
    assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
    return { slug: name, sha, config, pdf, format };
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}
