import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseSlug, SLUG_RE } from '../lib/slug.mjs';

test('fresh slug skips existing decks belonging to this or another team', async () => {
  const checked = [];
  const slug = await chooseSlug('pitch', { check: async (candidate) => {
    checked.push(candidate);
    if (candidate === 'pitch') return { available: true, exists: true };
    if (candidate === 'pitch-2') return { available: false, reason: 'another team already has a deck with this name' };
    return { available: true, exists: false };
  } });
  assert.equal(slug, 'pitch-3');
  assert.deepEqual(checked, ['pitch', 'pitch-2', 'pitch-3']);
});

test('suffixes stay valid at the maximum slug length', async () => {
  const base = `${'a'.repeat(61)}-aa`;
  const slug = await chooseSlug(base, { check: async (candidate) => ({ available: true, exists: candidate === base }) });
  assert.equal(slug.length, 63);
  assert.ok(SLUG_RE.test(slug));
  assert.ok(slug.endsWith('-2'));
});

test('replacement requires a valid, existing, authorized target', async () => {
  assert.equal(await chooseSlug('new-repo', { replace: 'pitch', check: async () => ({ available: true, exists: true }) }), 'pitch');
  for (const result of [{ available: true, exists: false }, { available: false, reason: 'another team already has a deck with this name' }, {}]) {
    await assert.rejects(chooseSlug('new-repo', { replace: 'pitch', check: async () => result }));
  }
  await assert.rejects(chooseSlug('new-repo', { replace: '../pitch', check: () => assert.fail('must validate before lookup') }));
});

test('lookup failures and incomplete responses fail closed without retrying', async () => {
  for (const result of [{ available: false, reason: 'HTTP 503' }, { available: false, reason: 'unauthorized' }, { available: true }, {}]) {
    let calls = 0;
    await assert.rejects(chooseSlug('pitch', { check: async () => { calls++; return result; } }));
    assert.equal(calls, 1);
  }
  await assert.rejects(chooseSlug('pitch', { check: async () => { throw new Error('offline'); } }), /offline/);
});

test('collision retries are bounded', async () => {
  let calls = 0;
  await assert.rejects(chooseSlug('pitch', { check: async () => { calls++; return { available: true, exists: true }; } }), /Pick another name/);
  assert.equal(calls, 100);
});
