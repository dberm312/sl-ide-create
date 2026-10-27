import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { sandbox } from './harness.mjs';

// Every sandbox is its own home, so a file's tests run concurrently.
describe('create', { concurrency: 8 }, () => {

  // All cloud calls and external commands are local fakes. No repo or deck is published.
  async function create(t, { replace, available = true, exists = true, extra = [] } = {}) {
    const box = sandbox(t, { cloud: { slugs: { pitch: { available, exists, reason: 'unauthorized' } } } });
    const r = await box.run(['pitch', '--yes', '--no-install', ...(replace === undefined ? [] : ['--replace', replace]), ...extra]);
    return { result: r, config: r.config(), commands: JSON.stringify(r.commands) };
  }

  test('--yes chooses a fresh slug and writes it into publishing config', async (t) => {
    const { result, config, commands } = await create(t);
    assert.equal(result.status, 0, result.out);
    assert.deepEqual(config, { slug: 'pitch-2' });
    assert.match(commands, /Publish to sl-ide cloud as pitch-2/);
  });

  test('an unused slug stays unchanged', async (t) => {
    const { result, config } = await create(t, { exists: false });
    assert.equal(result.status, 0, result.out);
    assert.equal(config.slug, 'pitch');
  });

  test('explicit replacement writes the existing slug', async (t) => {
    const { result, config } = await create(t, { replace: 'pitch' });
    assert.equal(result.status, 0, result.out);
    assert.equal(config.slug, 'pitch');
  });

  for (const options of [{ available: false }, { replace: 'pitch', exists: false }, { replace: 'pitch', available: false }, { replace: 'pitch', extra: ['--no-publish'] }, { replace: 'pitch', extra: ['--github', 'none'] }]) {
    test(`unsafe or disabled publishing stops before cloning: ${JSON.stringify(options)}`, async (t) => {
      const { result, config, commands } = await create(t, options);
      assert.equal(result.status, 1, result.out);
      assert.equal(config, null);
      assert.doesNotMatch(commands, /"clone"|"create"|"push"/);
    });
  }
});
