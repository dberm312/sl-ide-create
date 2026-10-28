// Runs the CLI in a temporary home with fake git, gh and pnpm on PATH and a fake
// sl-ide cloud behind fetch. Nothing reaches GitHub or a real cloud.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { VERSION } from '../lib/version.mjs';

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
  if (command === 'gh' && args[0] === 'secret') {
    let input = '';
    process.stdin.on('data', (d) => { input += d; });
    process.stdin.on('end', () => fs.appendFileSync(process.env.TEST_SECRETS, JSON.stringify([args, input]) + '\\n'));
  }
  process.stdin.resume();
}
`;

// Cloud fixture: per-route { status, json, headers } responses. `slugs` maps a
// slug to its availability; other slugs are free. `poll` is the device-login
// poll reply; deckToken the deck-token mint reply (default: sli_deck_<slug>).
// A route's reply may be a list, answered in order (the last one
// repeats). { hang: true } never answers (until the request's deadline aborts
// it); { drop: true } fails as a lost connection does.
export const DEFAULT_START = { status: 200, json: { device_code: 'dev-1', user_code: 'ABCD-1234', verification_uri_complete: 'https://app.sl-ide.com/cli?code=ABCD-1234', interval: 0, expires_in: 5 } };
const DEFAULT_CLOUD = {
  whoami: { status: 200, json: { owner: 'acme' } },
  slugs: {},
  start: DEFAULT_START,
  poll: { status: 200, json: { owner: 'acme', token: 'sli_new' } },
};

const preloadSource = `import fs from 'node:fs';
if (process.env.TEST_NODE_VERSION) Object.defineProperty(process.versions, 'node', { value: process.env.TEST_NODE_VERSION });
const cloud = JSON.parse(process.env.TEST_CLOUD);
const seen = {};
const next = (name, reply) => {
  if (!Array.isArray(reply)) return reply;
  const n = seen[name] = (seen[name] ?? -1) + 1;
  return reply[Math.min(n, reply.length - 1)];
};
globalThis.fetch = async (url, init = {}) => {
  const { pathname } = new URL(url);
  if (pathname.endsWith('/create-sl-ide/latest')) {
    fs.appendFileSync(process.env.TEST_REGISTRY, JSON.stringify({ url: String(url), deadline: init.signal instanceof AbortSignal }) + '\\n');
    return answer(next('registry', cloud.registry ?? { status: 200, json: { version: process.env.TEST_VERSION } }), init);
  }
  const auth = init.headers?.Authorization ?? null;
  const body = init.body ? JSON.parse(init.body) : null;
  fs.appendFileSync(process.env.TEST_FETCHES, JSON.stringify({ url: String(url), method: init.method || 'GET', auth, body, redirect: init.redirect ?? 'follow', deadline: init.signal instanceof AbortSignal }) + '\\n');
  const reply = pathname === '/api/cli/whoami' ? next('whoami', cloud.whoami)
    : pathname === '/api/cli/login/start' ? next('start', cloud.start)
    : pathname === '/api/cli/login/poll' ? next('poll', cloud.poll)
    : pathname === '/api/cli/deck-token' ? (cloud.deckToken ? next('deckToken', cloud.deckToken) : { status: 200, json: { token: 'sli_deck_' + body?.slug, slug: body?.slug } })
    : pathname.startsWith('/api/cli/slug/') ? { status: 200, json: cloud.slugs[pathname.split('/').at(-1)] ?? { available: true, exists: false } }
    : { status: 404, json: {} };
  return answer(reply, init);
};
const answer = (reply, init) => {
  if (reply.hang) {
    return new Promise((_, reject) => {
      const keepAlive = setInterval(() => {}, 1000);
      init.signal?.addEventListener('abort', () => { clearInterval(keepAlive); reject(init.signal.reason); });
    });
  }
  if (reply.drop) throw new TypeError('fetch failed', { cause: new Error('other side closed') });
  const headers = new Headers(reply.headers ?? {});
  const text = JSON.stringify(reply.json ?? {});
  return { ok: reply.status >= 200 && reply.status < 300, status: reply.status, headers, text: async () => text, json: async () => JSON.parse(text) };
};
`;

export const PROD = 'https://app.sl-ide.com';
// Account credentials kept separately for each server.
export const savedCreds = (servers) => ({
  version: 3,
  servers: Object.fromEntries(Object.entries(servers).map(([server, accounts]) => {
    const [owner, token] = Object.entries(accounts)[0];
    return [server, { owner, token }];
  })),
});

const lines = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

// creds: saved credentials.json, or null for none. useFormat: whether the
// cloned template has scripts/use-format.mjs. missing: commands that are not
// installed (PATH is then only the stubs and `which`). node: the Node version
// the CLI sees.
export function sandbox(t, { creds = savedCreds({ [PROD]: { acme: 'fake-token' } }), cloud = {}, fail = [], hang = [], useFormat = true, missing = [], node, env = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-ide-create-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  for (const command of ['git', 'gh', 'pnpm'].filter((c) => !missing.includes(c))) {
    // .mjs symlinks preserve ESM parsing while retaining the invoked command name.
    fs.writeFileSync(path.join(bin, `${command}.mjs`), stub, { mode: 0o755 });
    fs.symlinkSync(`${command}.mjs`, path.join(bin, command));
  }
  if (missing.length) fs.symlinkSync(spawnSync('which', ['which'], { encoding: 'utf8' }).stdout.trim(), path.join(bin, 'which'));
  const conf = path.join(root, 'config');
  const credsFile = path.join(conf, 'sl-ide', 'credentials.json');
  fs.mkdirSync(path.dirname(credsFile), { recursive: true });
  if (creds) fs.writeFileSync(credsFile, JSON.stringify(creds));
  const preload = path.join(root, 'cloud.mjs');
  fs.writeFileSync(preload, preloadSource);
  const work = path.join(root, 'work');
  fs.mkdirSync(work);
  const files = { commands: path.join(root, 'commands'), fetches: path.join(root, 'fetches'), registry: path.join(root, 'registry'), secrets: path.join(root, 'secrets'), hung: path.join(root, 'hung') };

  const childEnv = {
    ...process.env, PATH: missing.length ? bin : `${bin}:${process.env.PATH}`, HOME: root, XDG_CONFIG_HOME: conf,
    TEST_COMMANDS: files.commands, TEST_FETCHES: files.fetches, TEST_REGISTRY: files.registry, TEST_VERSION: VERSION, TEST_SECRETS: files.secrets, TEST_HUNG: files.hung,
    TEST_CLOUD: JSON.stringify({ ...DEFAULT_CLOUD, ...cloud }), TEST_FAIL: JSON.stringify(fail), TEST_HANG: JSON.stringify(hang),
    TEST_USE_FORMAT: useFormat ? '1' : '', ...env,
  };
  // The default cloud is under test; SL_IDE_URL only when a test sets it.
  if (!('SL_IDE_URL' in env)) delete childEnv.SL_IDE_URL;
  if (node) childEnv.TEST_NODE_VERSION = node;
  else delete childEnv.TEST_NODE_VERSION;
  delete childEnv.SL_IDE_TEMPLATE;
  const argv = (args) => ['--import', preload, cli, ...args];
  const report = (status, signal, out) => ({
    status, signal, out, root, work,
    commands: lines(files.commands),
    ran: (prefix) => lines(files.commands).some((c) => c.join(' ').startsWith(prefix)),
    fetches: lines(files.fetches),
    // Version checks against the npm registry, kept apart from cloud calls.
    registry: lines(files.registry),
    // [gh secret args, the value piped in], one per gh secret command.
    secrets: lines(files.secrets),
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
    // Async so the tests in a file run concurrently (each sandbox is its own home).
    async run(args, { cwd = work } = {}) {
      const child = spawn(process.execPath, argv(args), { cwd, env: childEnv, timeout: 15000 });
      let out = '';
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { out += d; });
      const [status, signal] = await new Promise((resolve, reject) => {
        child.on('error', reject);
        child.on('close', (code, sig) => resolve([code, sig]));
      });
      return report(status, signal, out);
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
      const hungPid = Number(fs.readFileSync(files.hung, 'utf8'));
      child.kill(signal);
      const [status, sig] = await closed;
      // The CLI sends SIGTERM from its exit hook. Its own close event need
      // not wait for the OS to schedule the command's termination and reaping.
      // Observe the process becoming stopped rather than assuming that ordering.
      const stoppedBy = Date.now() + 5000;
      while (alive(hungPid) && Date.now() < stoppedBy) await new Promise((r) => setTimeout(r, 10));
      return { ...report(status, sig, out), hungPid };
    },
  };
}

export const alive = (pid) => {
  try {
    process.kill(pid, 0);
    // On Linux an orphan can remain a zombie until init reaps it. It has
    // already exited and cannot execute commands, but kill(pid, 0) succeeds.
    if (process.platform === 'linux') {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0] !== 'Z';
    }
    return true;
  } catch (error) {
    if (error.code === 'ESRCH' || error.code === 'ENOENT') return false;
    throw error;
  }
};
