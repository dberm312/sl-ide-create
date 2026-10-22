// create-B: generated projects use the current cloud, start team-only and say
// how to share publicly.
import test from 'node:test';
import assert from 'node:assert/strict';
import { sandbox } from './harness.mjs';

const PUBLISH = ['pitch', '--yes', '--team', 'acme', '--no-install'];

test('a default deck is private on GitHub, team-only and published to app.sl-ide.com', (t) => {
  const r = sandbox(t).run(PUBLISH);
  assert.equal(r.status, 0, r.out);
  // No url key: the template's publisher then uses its own app.sl-ide.com default.
  assert.deepEqual(r.config(), { slug: 'pitch', team: 'acme' });
  assert.ok(r.ran('gh repo create pitch --private'), r.out);
  assert.ok(r.fetches.length > 0);
  for (const { url } of r.fetches) assert.equal(new URL(url).origin, 'https://app.sl-ide.com');
  assert.match(r.out, /publishes https:\/\/app\.sl-ide\.com\/d\/pitch\/ \(team acme only\)/);
  assert.match(r.out, /To share it publicly, open https:\/\/app\.sl-ide\.com\/decks\/pitch after the first publish and save Anyone with the link/);
});

test('the publish commit names the deck and its team', (t) => {
  const r = sandbox(t).run(PUBLISH);
  assert.equal(r.status, 0, r.out);
  const commits = r.commands.filter((c) => c.includes('commit')).map((c) => c.at(-1));
  assert.deepEqual(commits, ['Publish to sl-ide cloud as pitch (team acme)']);
});
