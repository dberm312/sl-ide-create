// create-B: generated projects use the current cloud, start restricted and say
// how to share publicly.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { sandbox } from './harness.mjs';

// Every sandbox is its own home, so a file's tests run concurrently.
describe('defaults', { concurrency: 8 }, () => {

  const PUBLISH = ['pitch', '--yes', '--no-install'];

  test('a default deck is private on GitHub, restricted and published to app.sl-ide.com', async (t) => {
    const r = await sandbox(t).run(PUBLISH);
    assert.equal(r.status, 0, r.out);
    // No url key: the template's publisher then uses its own app.sl-ide.com default.
    assert.deepEqual(r.config(), { slug: 'pitch' });
    assert.ok(r.ran('gh repo create pitch --private'), r.out);
    assert.ok(r.fetches.length > 0);
    for (const { url } of r.fetches) assert.equal(new URL(url).origin, 'https://app.sl-ide.com');
    assert.match(r.out, /publishes https:\/\/app\.sl-ide\.com\/d\/pitch\/ \(restricted\)/);
    assert.match(r.out, /To share it, open https:\/\/app\.sl-ide\.com\/decks\/pitch after the first publish. Choose Share/);
  });

  test('the publish commit names the deck and its owner', async (t) => {
    const r = await sandbox(t).run(PUBLISH);
    assert.equal(r.status, 0, r.out);
    const commits = r.commands.filter((c) => c.includes('commit')).map((c) => c.at(-1));
    assert.deepEqual(commits, ['Publish to sl-ide cloud as pitch']);
  });
});
