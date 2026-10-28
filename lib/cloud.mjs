// sl-ide cloud: saved credentials, browser sign-in, and the API calls the
// create flow needs. Credentials live in ~/.config/sl-ide/credentials.json
// (mode 600): one account token, kept per cloud server so a token is only
// ever sent to the server that issued it. It never leaves this machine: each
// deck repo gets its own deck token (deckToken), which publishes only that deck.
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

// { version: 3, servers: { <origin>: { owner, token, savedAt } } }.
// Anything else (an older layout, a damaged file) reads as no credentials.
function readAll() {
  try {
    const c = JSON.parse(fs.readFileSync(CREDS, 'utf8'));
    if (c?.version === 3 && c.servers && typeof c.servers === 'object') return c;
  } catch { /* missing or unreadable */ }
  return { version: 3, servers: {} };
}

function writeAll(c) {
  fs.mkdirSync(CONF, { recursive: true });
  const tmp = `${CREDS}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(c, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, CREDS);
}

// One signed-in account per server. Login replaces this server's credential.
export function readCreds() {
  return readAll().servers[CLOUD] ?? null;
}

export function saveToken(owner, token) {
  const c = readAll();
  c.servers[CLOUD] = { owner, token, savedAt: new Date().toISOString() };
  writeAll(c);
}

export function forget({ all = false } = {}) {
  if (!fs.existsSync(CREDS)) return;
  const c = readAll();
  if (all) c.servers = {};
  else delete c.servers[CLOUD];
  writeAll(c);
}

export const credsPath = CREDS;

// Every cloud call has a deadline (SL_IDE_REQUEST_TIMEOUT_MS, default 30 s).
// Calls that are safe to repeat are sent again when no answer comes or the
// answer is 408, 429 or 5xx, after a jittered backoff or the server's
// Retry-After (up to 30 s); any other answer is final.
const setting = (name, fallback) => { const v = Number(process.env[name]); return Number.isFinite(v) && v > 0 ? v : fallback; };
const REQUEST_MS = setting('SL_IDE_REQUEST_TIMEOUT_MS', 30_000);
const BACKOFF_MS = setting('SL_IDE_RETRY_BACKOFF_MS', 500);
const MAX_WAIT_MS = 30_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const retryable = (status) => status === 0 || status === 408 || status === 429 || (status >= 500 && status < 600);

function retryAfterMs(header) {
  if (!header) return null;
  const ms = /^\d+$/.test(header.trim()) ? Number(header) * 1000 : Date.parse(header) - Date.now();
  return Number.isFinite(ms) ? Math.max(0, ms) : null;
}

// One attempt: { status, ok, json, retryAfter }, or status 0 and `error` when
// no answer came in time.
async function send(pathname, { token, method, body, timeout }) {
  try {
    const res = await fetch(`${CLOUD}${pathname}`, {
      method,
      // A redirect could carry the token or a sign-in code to another server.
      redirect: 'error',
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeout),
    });
    const text = await res.text();
    let json = {};
    try { json = JSON.parse(text) ?? {}; } catch { /* not JSON */ }
    return { status: res.status, ok: res.ok, json, retryAfter: res.headers?.get('retry-after') ?? null };
  } catch (e) {
    const error = e?.name === 'TimeoutError' ? `no answer within ${Math.round(timeout / 1000)} s` : (e?.cause?.message ?? e?.message ?? String(e));
    return { status: 0, ok: false, json: {}, error };
  }
}

async function api(pathname, { token, method = 'GET', body, attempts = 3, timeout = REQUEST_MS } = {}) {
  for (let n = 1; ; n += 1) {
    const r = await send(pathname, { token, method, body, timeout });
    if (r.ok || !retryable(r.status) || n >= attempts) return r;
    const asked = retryAfterMs(r.retryAfter);
    const wait = asked ?? Math.min(MAX_WAIT_MS, BACKOFF_MS * 2 ** (n - 1)) * (0.5 + Math.random() / 2);
    if (wait > MAX_WAIT_MS) return r;
    await sleep(wait);
  }
}

const unreachable = (r) => `could not reach ${CLOUD} (${r.status ? `HTTP ${r.status}` : r.error})`;

// Is the saved token still good? -> { owner }, or null if the cloud refuses it.
// Throws when the cloud can't be reached, so an outage never reads as a
// revoked token.
export async function whoami(token) {
  const r = await api('/api/cli/whoami', { token });
  if (r.ok) return r.json;
  if (retryable(r.status)) throw new Error(unreachable(r));
  return null;
}

export async function slugAvailable(token, slug) {
  const r = await api(`/api/cli/slug/${slug}`, { token });
  if (r.ok) return r.json;
  return { available: false, reason: r.json.error || (retryable(r.status) ? unreachable(r) : `HTTP ${r.status}`) };
}

// A new token that publishes only `slug`, for a deck repo's secret, minted
// with the account token. Sent once: a lost answer is not repeated, since a
// retry would leave the first token live and unseen.
export async function deckToken(token, slug) {
  const r = await api('/api/cli/deck-token', { token, method: 'POST', body: { slug }, attempts: 1 });
  if (r.ok && typeof r.json.token === 'string') return r.json.token;
  if (r.status === 401) throw new Error('the saved sign-in was rejected (revoked?). Run: pnpm create sl-ide login');
  throw new Error(r.json.error ? `${CLOUD}: ${r.json.error}` : unreachable(r));
}

export function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
  } catch { /* no browser: the URL is printed anyway */ }
}

const EXPIRED = 'the sign-in code expired; run the command again';
// Polls in a row that may go unanswered before giving up.
const MAX_UNANSWERED_POLLS = 5;

// Browser sign-in. onCode(user_code, url) is called once, to show the code;
// resolves { owner, token } once the account owner approves it at app.sl-ide.com/cli.
//
// The token comes in exactly one poll answer: collecting it deletes the
// sign-in. If a poll's answer is lost (no answer in time, a dropped
// connection, a 5xx) the next polls continue, but if the cloud then calls the
// code expired the token may already have been sent and lost. Asking again
// cannot recover it, so this says to sign in again rather than loop.
export async function deviceLogin({ onCode, open = true }) {
  // Starting again only leaves an unused code to expire; two tries at most,
  // since each counts toward the cloud's cap on sign-ins in progress.
  const start = await api('/api/cli/login/start', { method: 'POST', body: { client: os.hostname().replace(/\.local$/, '') }, attempts: 2 });
  if (!start.ok) throw new Error(start.status === 429 && start.json.error ? `${CLOUD}: ${start.json.error}` : unreachable(start));
  const { device_code: device, user_code: code, verification_uri_complete: url, interval = 2, expires_in: ttl = 600 } = start.json;
  onCode(code, url);
  if (open) openBrowser(url);
  const until = Date.now() + ttl * 1000;
  const lost = () => new Error(`the sign-in may have been approved, but ${CLOUD}'s answer was lost on the way, and a token is only sent once. Run the command again to sign in; an unused "CLI" token can be revoked at ${CLOUD}/tokens`);
  let uncertain = false;
  let unanswered = 0;
  while (Date.now() < until) {
    await sleep(interval * 1000);
    const r = await api('/api/cli/login/poll', {
      method: 'POST', body: { device_code: device }, attempts: 1, timeout: Math.max(1000, Math.min(REQUEST_MS, until - Date.now())),
    });
    if (r.status === 202) { unanswered = 0; continue; }
    if (r.ok && r.json.token) return { owner: r.json.owner, token: r.json.token };
    if (retryable(r.status)) {
      // 408 and 429 mean the poll was not processed; anything else might have been.
      if (r.status !== 408 && r.status !== 429) uncertain = true;
      if (++unanswered >= MAX_UNANSWERED_POLLS) throw uncertain ? lost() : new Error(`${unreachable(r)}; run the command again`);
      if (r.status === 429) await sleep(Math.min(MAX_WAIT_MS, retryAfterMs(r.retryAfter) ?? 0));
      continue;
    }
    if (r.status === 410 && uncertain) throw lost();
    if (r.status === 410 || r.ok) throw new Error(EXPIRED);
    throw new Error(`sign-in failed: ${r.json.error || `HTTP ${r.status}`}; run the command again`);
  }
  throw uncertain ? lost() : new Error(EXPIRED);
}
