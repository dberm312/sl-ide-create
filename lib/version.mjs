import fs from 'node:fs';
import path from 'node:path';
import { credsPath } from './cloud.mjs';

export const VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const CACHE = path.join(path.dirname(credsPath), 'latest-version.json');
const HOUR = 3_600_000;

const parts = (v) => v.split('-')[0].split('.').map(Number);
const newer = (a, b) => {
  const [x, y] = [parts(a), parts(b)];
  const i = x.findIndex((n, j) => n !== y[j]);
  return i !== -1 && x[i] > y[i];
};

// The registry's latest create-sl-ide, asked at most once a day (an hour after
// a failure). Never throws or waits past `timeout`: null when unknown.
export async function latestVersion({ timeout = 1500 } = {}) {
  try {
    const c = JSON.parse(fs.readFileSync(CACHE, 'utf8'));
    if (Date.now() - c.checked < (c.latest ? 24 : 1) * HOUR) return c.latest;
  } catch {}
  let latest = null;
  try {
    const registry = (process.env.npm_config_registry || 'https://registry.npmjs.org/').replace(/\/?$/, '/');
    const r = await fetch(`${registry}create-sl-ide/latest`, { signal: AbortSignal.timeout(timeout), headers: { Accept: 'application/json' } });
    const v = r.ok ? (await r.json()).version : null;
    if (typeof v === 'string' && /^\d+\.\d+\.\d+/.test(v)) latest = v;
  } catch {}
  try {
    fs.mkdirSync(path.dirname(CACHE), { recursive: true, mode: 0o700 });
    fs.writeFileSync(CACHE, `${JSON.stringify({ checked: Date.now(), latest })}\n`);
  } catch {}
  return latest;
}

export const outdated = (latest) => typeof latest === 'string' && newer(latest, VERSION);
