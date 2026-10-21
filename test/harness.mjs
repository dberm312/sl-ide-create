// Runs the CLI in a temporary home with fake git, gh and pnpm on PATH and a fake
// sl-ide cloud behind fetch. Nothing reaches GitHub or a real cloud.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

const cli = fileURLToPath(new URL('../index.mjs', import.meta.url));

// Every external command is this script. TEST_FAIL and TEST_HANG name command
// prefixes ("gh secret", "git push") that fail or wait to be killed.
const stub = `#!${process.execPath}
import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
const command = path.basename(process.argv[1]);
const line = [command, ...args].join(' ');
fs.appendFileSync(process.env.TEST_COMMANDS, JSON.stringify([command, ...args]) + '\\n');
const match = (name) => JSON.parse(process.env[name] || '[]').some((prefix) => line.startsWith(prefix));
if (match('TEST_HANG')) {
  fs.writeFileSync(process.env.TEST_HUNG, String(process.pid));
  setTimeout(() => {}, 60000);
} else {
  if (match('TEST_FAIL')) { console.error(line + ' failed (test)'); process.exit(1); }
  if (command === 'gh' && args[0] === 'repo' && args[1] === 'view') process.exit(1);
  if (command === 'gh' && args[0] === 'api') console.log('tester');
  if (command === 'git' && args[0] === 'clone') {
    const dest = args.at(-1);
    fs.mkdirSync(dest, { recursive: true });
    if (process.env.TEST_USE_FORMAT) {
      fs.mkdirSync(path.join(dest, 'scripts'));
      fs.writeFileSync(path.join(dest, 'scripts', 'use-format.mjs'), "import fs from 'node:fs'; fs.writeFileSync('format.txt', process.argv[2]);");
    }
  }
  if (command === 'git' && args[0] === 'log') console.log('abc123 template');
  process.stdin.resume();
}
`;

// Cloud fixture: per-route { status, json } responses. `slugs` maps a slug to
// its availability; other slugs are free. `poll` is the device-login poll reply.
const DEFAULT_CLOUD = {
  whoami: { status: 200, json: { team: 'acme' } },
  slugs: {},
  start: { status: 200, json: { device_code: 'dev-1', user_code: 'ABCD-1234', verification_uri_complete: 'https://app.sl-ide.com/cli?code=ABCD-1234', interval: 0, expires_in: 5 } },
  poll: { status: 200, json: { team: 'acme', token: 'sli_new' } },
};

const preloadSource = `import fs from 'node:fs';
const cloud = JSON.parse(process.env.TEST_CLOUD);
globalThis.fetch = async (url, init = {}) => {
  const { pathname } = new URL(url);
  const auth = init.headers?.Authorization ?? null;
  fs.appendFileSync(process.env.TEST_FETCHES, JSON.stringify({ url: String(url), method: init.method || 'GET', auth, redirect: init.redirect ?? 'follow' }) + '\\n');
  const reply = pathname === '/api/cli/whoami' ? cloud.whoami
    : pathname === '/api/cli/login/start' ? cloud.start
    : pathname === '/api/cli/login/poll' ? cloud.poll
    : pathname.startsWith('/api/cli/slug/') ? { status: 200, json: cloud.slugs[pathname.split('/').at(-1)] ?? { available: true, exists: false } }
    : { status: 404, json: {} };
  return { ok: reply.status >= 200 && reply.status < 300, status: reply.status, json: async () => reply.json };
};
`;

export const PROD = 'https://app.sl-ide.com';
// A credentials.json with `teams` ({ team: token }) saved for each server.
export const savedCreds = (servers) => ({
  version: 2,
  servers: Object.fromEntries(Object.entries(servers).map(([server, teams]) => [server, {
    teams: Object.fromEntries(Object.entries(teams).map(([team, token]) => [team, { token }])),
  }])),
});

const lines = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

// creds: saved credentials.json, or null for none. useFormat: whether the
// cloned template has scripts/use-format.mjs.
export function sandbox(t, { creds = savedCreds({ [PROD]: { acme: 'fake-token' } }), cloud = {}, fail = [], hang = [], useFormat = true, env = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-ide-create-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  for (const command of ['git', 'gh', 'pnpm']) {
    // .mjs symlinks preserve ESM parsing while retaining the invoked command name.
    fs.writeFileSync(path.join(bin, `${command}.mjs`), stub, { mode: 0o755 });
    fs.symlinkSync(`${command}.mjs`, path.join(bin, command));
  }
  const conf = path.join(root, 'config');
  const credsFile = path.join(conf, 'sl-ide', 'credentials.json');
  fs.mkdirSync(path.dirname(credsFile), { recursive: true });
  if (creds) fs.writeFileSync(credsFile, JSON.stringify(creds));
  const preload = path.join(root, 'cloud.mjs');
  fs.writeFileSync(preload, preloadSource);
  const work = path.join(root, 'work');
  fs.mkdirSync(work);
  const files = { commands: path.join(root, 'commands'), fetches: path.join(root, 'fetches'), hung: path.join(root, 'hung') };

  const childEnv = {
    ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: root, XDG_CONFIG_HOME: conf,
    TEST_COMMANDS: files.commands, TEST_FETCHES: files.fetches, TEST_HUNG: files.hung,
    TEST_CLOUD: JSON.stringify({ ...DEFAULT_CLOUD, ...cloud }), TEST_FAIL: JSON.stringify(fail), TEST_HANG: JSON.stringify(hang),
    TEST_USE_FORMAT: useFormat ? '1' : '', ...env,
  };
  // The default cloud is under test; SL_IDE_URL only when a test sets it.
  if (!('SL_IDE_URL' in env)) delete childEnv.SL_IDE_URL;
  delete childEnv.SL_IDE_TEMPLATE;
  const argv = (args) => ['--import', preload, cli, ...args];
  const report = (status, signal, out) => ({
    status, signal, out, root, work,
    commands: lines(files.commands),
    ran: (prefix) => lines(files.commands).some((c) => c.join(' ').startsWith(prefix)),
    fetches: lines(files.fetches),
    creds: fs.existsSync(credsFile) ? JSON.parse(fs.readFileSync(credsFile, 'utf8')) : null,
    credsMode: fs.existsSync(credsFile) ? fs.statSync(credsFile).mode & 0o777 : null,
    file: (rel) => (fs.existsSync(path.join(work, rel)) ? fs.readFileSync(path.join(work, rel), 'utf8') : null),
    config: (dir = 'pitch') => {
      const f = path.join(work, dir, 'sl-ide.config.json');
      return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
    },
  });

  return {
    // For driving the CLI by hand, e.g. in a pty: node ...argv(args) with env in cwd work.
    env: childEnv, argv, work, report: () => report(null, null, ''),
    run(args, { cwd = work } = {}) {
      const r = spawnSync(process.execPath, argv(args), { cwd, env: childEnv, encoding: 'utf8', timeout: 15000 });
      return report(r.status, r.signal, r.stdout + r.stderr);
    },
    // Start the CLI, wait for a TEST_HANG command, send `signal`, then report.
    async interrupt(args, signal = 'SIGINT') {
      const child = spawn(process.execPath, argv(args), { cwd: work, env: childEnv });
      let out = '';
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { out += d; });
      const closed = new Promise((resolve) => child.on('close', (code, sig) => resolve([code, sig])));
      const until = Date.now() + 10000;
      while (!fs.existsSync(files.hung) && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
      if (!fs.existsSync(files.hung)) { child.kill('SIGKILL'); throw new Error(`never reached the hung command:\n${out}`); }
      child.kill(signal);
      const [status, sig] = await closed;
      return { ...report(status, sig, out), hungPid: Number(fs.readFileSync(files.hung, 'utf8')) };
    },
  };
}

export const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};
