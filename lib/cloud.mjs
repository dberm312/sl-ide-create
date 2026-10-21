// sl-ide cloud: saved credentials, browser sign-in, and the API calls the
// create flow needs. Credentials live in ~/.config/sl-ide/credentials.json
// (mode 600): one publish token per team.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

export const CLOUD = (process.env.SL_IDE_URL || 'https://app.sl-ide.com').replace(/\/$/, '');
const CONF = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'sl-ide');
const CREDS = path.join(CONF, 'credentials.json');
const LEGACY = path.join(CONF, 'publish-token');

export function readCreds() {
  try {
    const c = JSON.parse(fs.readFileSync(CREDS, 'utf8'));
    return { teams: {}, ...c };
  } catch {
    return { teams: {} };
  }
}

export function saveToken(team, token) {
  const c = readCreds();
  c.url = CLOUD;
  c.teams[team] = { token, savedAt: new Date().toISOString() };
  fs.mkdirSync(CONF, { recursive: true });
  fs.writeFileSync(CREDS, `${JSON.stringify(c, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(CREDS, 0o600);
}

export function forget(team) {
  const c = readCreds();
  if (team) delete c.teams[team];
  else c.teams = {};
  if (fs.existsSync(CREDS)) fs.writeFileSync(CREDS, `${JSON.stringify(c, null, 2)}\n`, { mode: 0o600 });
}

// An admin token from before team tokens existed: publishes for any team.
export function legacyToken() {
  try { return fs.readFileSync(LEGACY, 'utf8').trim() || null; } catch { return null; }
}

export const credsPath = CREDS;

async function api(pathname, { token, method = 'GET', body } = {}) {
  const res = await fetch(`${CLOUD}${pathname}`, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, json };
}

// Is the saved token still good? -> { team } or null.
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
