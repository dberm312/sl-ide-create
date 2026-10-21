// sl-ide cloud: saved credentials, browser sign-in, and the API calls the
// create flow needs. Credentials live in ~/.config/sl-ide/credentials.json
// (mode 600): one publish token per team, kept per cloud server so a token
// is only ever sent to the server that issued it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

// The canonical form of a cloud server URL: its origin. https only, except
// plain http on this machine; no credentials, path, query or fragment.
export function normalizeServer(raw) {
  let u;
  try { u = new URL(raw); } catch { throw new Error(`"${raw}" isn't a URL`); }
  if (u.username || u.password) throw new Error(`${raw} must not contain a user name or password`);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && LOOPBACK.has(u.hostname))) {
    throw new Error(`${raw} must use https (plain http only on localhost)`);
  }
  return u.origin;
}

function serverFromEnv() {
  try {
    return normalizeServer(process.env.SL_IDE_URL || 'https://app.sl-ide.com');
  } catch (e) {
    console.error(`SL_IDE_URL: ${e.message}`);
    process.exit(1);
  }
}

export const CLOUD = serverFromEnv();
export const DEFAULT_CLOUD = 'https://app.sl-ide.com';
const CONF = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'sl-ide');
const CREDS = path.join(CONF, 'credentials.json');

// { version: 2, servers: { <origin>: { teams: { <team>: { token, savedAt } } } } }.
// Anything else (an older layout, a damaged file) reads as no credentials.
function readAll() {
  try {
    const c = JSON.parse(fs.readFileSync(CREDS, 'utf8'));
    if (c?.version === 2 && c.servers && typeof c.servers === 'object') return c;
  } catch { /* missing or unreadable */ }
  return { version: 2, servers: {} };
}

function writeAll(c) {
  fs.mkdirSync(CONF, { recursive: true });
  const tmp = `${CREDS}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(c, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, CREDS);
}

// The saved teams for this server: { <team>: { token, savedAt } }.
export function readCreds() {
  return { ...readAll().servers[CLOUD]?.teams };
}

export function saveToken(team, token) {
  const c = readAll();
  c.servers[CLOUD] = { teams: { ...c.servers[CLOUD]?.teams, [team]: { token, savedAt: new Date().toISOString() } } };
  writeAll(c);
}

// Forget one team or every team on this server; `all` forgets every server.
export function forget(team, { all = false } = {}) {
  if (!fs.existsSync(CREDS)) return;
  const c = readAll();
  if (all) c.servers = {};
  else if (team) {
    if (c.servers[CLOUD]) delete c.servers[CLOUD].teams[team];
  } else delete c.servers[CLOUD];
  if (c.servers[CLOUD] && !Object.keys(c.servers[CLOUD].teams).length) delete c.servers[CLOUD];
  writeAll(c);
}

export const credsPath = CREDS;

async function api(pathname, { token, method = 'GET', body } = {}) {
  const res = await fetch(`${CLOUD}${pathname}`, {
    method,
    // A redirect could carry the token or a sign-in code to another server.
    redirect: 'error',
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, json };
}

// Is the saved token still good? -> { team, admin } or null.
export async function whoami(token) {
  const r = await api('/api/cli/whoami', { token }).catch(() => null);
  return r?.ok ? r.json : null;
}

export async function slugAvailable(token, slug) {
  const r = await api(`/api/cli/slug/${slug}`, { token });
  return r.ok ? r.json : { available: false, reason: r.json.error || `HTTP ${r.status}` };
}

export function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
  } catch { /* no browser: the URL is printed anyway */ }
}

// Browser sign-in. onCode(user_code, url) is called once, to show the code;
// resolves { team, token } once a team member approves it at app.sl-ide.com/cli.
export async function deviceLogin({ onCode, open = true }) {
  const start = await api('/api/cli/login/start', { method: 'POST', body: { client: os.hostname().replace(/\.local$/, '') } });
  if (!start.ok) throw new Error(`could not reach ${CLOUD} (${start.status})`);
  const { device_code: device, user_code: code, verification_uri_complete: url, interval = 2, expires_in: ttl = 600 } = start.json;
  onCode(code, url);
  if (open) openBrowser(url);
  const until = Date.now() + ttl * 1000;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, interval * 1000));
    const r = await api('/api/cli/login/poll', { method: 'POST', body: { device_code: device } }).catch(() => null);
    if (!r || r.status === 202) continue;
    if (r.ok && r.json.token) return { team: r.json.team, token: r.json.token };
    throw new Error('the sign-in code expired; run the command again');
  }
  throw new Error('the sign-in code expired; run the command again');
}
