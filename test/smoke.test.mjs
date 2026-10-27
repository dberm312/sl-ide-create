// create-A: setup variants, expired credentials, interruption and recovery.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { alive, DEFAULT_START, PROD, sandbox, savedCreds } from './harness.mjs';

// Every sandbox is its own home, so a file's tests run concurrently.
// Bound child-process bursts so local runs keep the existing 15-second deadline.
describe('smoke', { concurrency: 8 }, () => {

  const PUBLISH = ['pitch', '--yes'];

  // --- formats ---------------------------------------------------------------

  test('slides: clones, publishes for the owner and installs', async (t) => {
    const r = await sandbox(t).run(PUBLISH);
    assert.equal(r.status, 0, r.out);
    assert.deepEqual(r.config(), { slug: 'pitch' });
    for (const step of ['git clone', 'git remote rename origin upstream', 'gh repo create pitch --private', 'gh secret set SL_IDE_PUBLISH_TOKEN --repo tester/pitch', 'git push -q -u origin main', 'pnpm install']) {
      assert.ok(r.ran(step), `${step} should run:\n${r.out}`);
    }
    assert.ok(!r.ran('node scripts/use-format.mjs'));
    assert.equal(r.file('pitch/format.txt'), null);
    assert.match(r.out, /Deck ready\./);
  });

  test('memo: swaps in the memo starter and commits it before publishing', async (t) => {
    const r = await sandbox(t).run([...PUBLISH, '--memo']);
    assert.equal(r.status, 0, r.out);
    assert.equal(r.file('pitch/format.txt'), 'memo');
    const commits = r.commands.filter((c) => c.includes('commit')).map((c) => c.at(-1));
    assert.deepEqual(commits, ['Start from the memo starter', 'Publish to sl-ide cloud as pitch']);
    assert.match(r.out, /outline the memo/);
    assert.match(r.out, /Memo ready\./);
  });

  test('memo on a template without formats stops with recovery steps', async (t) => {
    const r = await sandbox(t, { useFormat: false }).run([...PUBLISH, '--format', 'memo']);
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /this sl-ide template has no memo format yet/);
    assert.match(r.out, /Nothing was created on GitHub/);
    assert.ok(!r.ran('gh repo create'));
  });

  test('an unknown format is rejected before cloning', async (t) => {
    const r = await sandbox(t).run([...PUBLISH, '--format', 'poster']);
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /--format is slides or memo/);
    assert.ok(!r.ran('git clone'));
  });

  // --- skipped steps ---------------------------------------------------------

  test('--github none: no GitHub calls, no publishing, still a working deck', async (t) => {
    const r = await sandbox(t).run([...PUBLISH, '--github', 'none', '--no-install']);
    assert.equal(r.status, 0, r.out);
    assert.ok(r.ran('git clone'));
    assert.ok(!r.commands.some((c) => c[0] === 'gh' && c[1] !== 'auth'), JSON.stringify(r.commands));
    assert.equal(r.config(), null);
    assert.deepEqual(r.fetches, []);
    assert.match(r.out, /Publishing runs in GitHub Actions/);
    assert.match(r.out, /Not publishing/);
  });

  // --- preflight -------------------------------------------------------------

  test('gh not signed in: stops before the first question with the fix', async (t) => {
    const r = await sandbox(t, { fail: ['gh auth status'] }).run(['pitch', '--yes', '--no-install']);
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /Sign in to GitHub first: gh auth login/);
    assert.match(r.out, /Stuck\? https:\/\/sl-ide\.com\/contact/);
    assert.ok(!r.ran('git clone'));
    assert.deepEqual(r.fetches, []);
  });

  test('--github private without gh sign-in stops before cloning', async (t) => {
    const r = await sandbox(t, { fail: ['gh auth status'] }).run([...PUBLISH, '--github', 'private']);
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /gh auth login/);
    assert.ok(!r.ran('git clone'));
  });

  test('gh not installed: stops and says how to install it', async (t) => {
    const r = await sandbox(t, { missing: ['gh'] }).run(PUBLISH);
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /The GitHub CLI \(gh\) is needed: https:\/\/cli\.github\.com/);
    assert.ok(!r.ran('git clone'));
  });

  test('gh not installed is fine with --github none', async (t) => {
    const r = await sandbox(t, { missing: ['gh'] }).run([...PUBLISH, '--github', 'none', '--no-install']);
    assert.equal(r.status, 0, r.out);
    assert.ok(r.ran('git clone'));
  });

  test('pnpm missing: stops with corepack enable pnpm', async (t) => {
    const r = await sandbox(t, { missing: ['pnpm'] }).run(PUBLISH);
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /pnpm is needed: corepack enable pnpm/);
    assert.ok(r.commands.length === 0, JSON.stringify(r.commands));
  });

  for (const [version, ok] of [['20.11.1', false], ['20.19.0', true], ['21.7.3', false], ['22.11.0', false], ['22.12.0', true], ['24.0.0', true]]) {
    test(`Node ${version} ${ok ? 'passes' : 'stops'} the preflight`, async (t) => {
      const r = await sandbox(t, { node: version }).run([...PUBLISH, '--github', 'none', '--no-install']);
      if (ok) assert.equal(r.status, 0, r.out);
      else {
        assert.equal(r.status, 1, r.out);
        assert.match(r.out, new RegExp(`Node ${version.replace(/\./g, '\\.')} is too old; sl-ide needs 20\\.19\\+ or 22\\.12\\+`));
        assert.ok(!r.ran('git clone'));
      }
    });
  }

  test('an unknown --github value is rejected before anything runs', async (t) => {
    const r = await sandbox(t).run(['pitch', '--yes', '--github', 'bogus']);
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /--github is private, public or none/);
    assert.ok(!r.ran('git clone'));
  });

  test('--no-publish: makes the repo but sets no secret and no config', async (t) => {
    const r = await sandbox(t).run([...PUBLISH, '--no-publish', '--no-install']);
    assert.equal(r.status, 0, r.out);
    assert.ok(r.ran('gh repo create'));
    assert.ok(!r.ran('gh secret'));
    assert.equal(r.config(), null);
    assert.deepEqual(r.fetches, []);
  });

  test('--no-install: skips pnpm install and lists it as a next step', async (t) => {
    const r = await sandbox(t).run([...PUBLISH, '--no-install']);
    assert.equal(r.status, 0, r.out);
    assert.ok(!r.ran('pnpm install'));
    assert.match(r.out, /cd pitch\s[\s\S]*pnpm install[\s\S]*pnpm dev/);
  });

  test('non-interactive setup signs in without selecting a team', async (t) => {
    const r = await sandbox(t, { creds: null }).run(['pitch', '--yes', '--no-install', '--no-open']);
    assert.equal(r.status, 0, r.out);
    assert.deepEqual(r.config(), { slug: 'pitch' });
    assert.equal(r.creds.servers[PROD].owner, 'acme');
  });

  test('an existing non-empty folder stops before anything runs', async (t) => {
    const box = sandbox(t);
    await box.run(['pitch', '--yes', '--github', 'none', '--no-install']);
    const r = await box.run(['pitch', '--yes', '--github', 'none', '--no-install']);
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /already exists and isn't empty/);
  });

  // --- credentials -----------------------------------------------------------

  test('a rejected saved token stops before cloning and says to sign in again', async (t) => {
    const r = await sandbox(t, { cloud: { whoami: { status: 401, json: { error: 'unauthorized' } } } }).run(PUBLISH);
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /token for acme was rejected[\s\S]*pnpm create sl-ide login/);
    assert.ok(!r.ran('git clone'));
  });

  test('an expired sign-in code saves nothing', async (t) => {
    const r = await sandbox(t, { creds: null, cloud: { poll: { status: 410, json: {} } } }).run(['login', '--no-open']);
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /sign-in code expired; run the command again/);
    assert.equal(r.fetches.filter((f) => f.url.endsWith('/api/cli/login/poll')).length, 1);
    assert.equal(r.creds, null);
  });

  test('login saves the approved account token privately', async (t) => {
    const r = await sandbox(t, { creds: null }).run(['login', '--no-open']);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /ABCD-1234/);
    assert.equal(r.creds.servers[PROD].token, 'sli_new');
    assert.equal(r.credsMode, 0o600);
  });

  // --- slow, failed and lost cloud answers ----------------------------------

  const FAST = { SL_IDE_REQUEST_TIMEOUT_MS: '200', SL_IDE_RETRY_BACKOFF_MS: '1' };
  const calls = (r, route) => r.fetches.filter((f) => new URL(f.url).pathname === route);

  test('every cloud call carries a deadline', async (t) => {
    const setup = await sandbox(t).run([...PUBLISH, '--no-install']);
    const login = await sandbox(t, { creds: null }).run(['login', '--no-open']);
    for (const r of [setup, login]) {
      assert.equal(r.status, 0, r.out);
      assert.ok(r.fetches.length > 0);
      for (const f of r.fetches) assert.equal(f.deadline, true, JSON.stringify(f));
    }
  });

  test('a cloud that never answers the token check stops before cloning, without calling the token revoked', async (t) => {
    const r = await sandbox(t, { cloud: { whoami: { hang: true } }, env: FAST }).run(PUBLISH);
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /could not reach https:\/\/app\.sl-ide\.com \(no answer within/);
    assert.doesNotMatch(r.out, /rejected/);
    assert.equal(calls(r, '/api/cli/whoami').length, 3);
    assert.ok(!r.ran('git clone'));
    assert.equal(r.creds.servers[PROD].token, 'fake-token');
  });

  test('a failed token check is tried again', async (t) => {
    const r = await sandbox(t, { cloud: { whoami: [{ status: 503, json: {} }, { drop: true }, { status: 200, json: { owner: 'acme' } }] }, env: FAST }).run([...PUBLISH, '--no-install']);
    assert.equal(r.status, 0, r.out);
    assert.equal(calls(r, '/api/cli/whoami').length, 3);
  });

  test('a refused token is not asked about again', async (t) => {
    for (const status of [401, 403, 404]) {
      const r = await sandbox(t, { cloud: { whoami: { status, json: { error: 'unauthorized' } } }, env: FAST }).run(PUBLISH);
      assert.equal(r.status, 1, r.out);
      assert.match(r.out, /token for acme was rejected/);
      assert.equal(calls(r, '/api/cli/whoami').length, 1, `HTTP ${status}`);
    }
  });

  test('a lost answer to starting sign-in is tried once more', async (t) => {
    const r = await sandbox(t, { creds: null, cloud: { start: [{ drop: true }, DEFAULT_START] }, env: FAST }).run(['login', '--no-open']);
    assert.equal(r.status, 0, r.out);
    assert.equal(calls(r, '/api/cli/login/start').length, 2);
    assert.equal(r.creds.servers[PROD].token, 'sli_new');
  });

  test('too many sign-ins in progress stops with the cloud\'s reason, without retrying past Retry-After', async (t) => {
    const busy = { status: 429, headers: { 'Retry-After': '600' }, json: { error: 'too many sign-ins in progress; try again in a few minutes' } };
    const r = await sandbox(t, { creds: null, cloud: { start: busy }, env: FAST }).run(['login', '--no-open']);
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /too many sign-ins in progress/);
    assert.equal(calls(r, '/api/cli/login/start').length, 1);
    assert.equal(calls(r, '/api/cli/login/poll').length, 0);
  });

  test('a short Retry-After on starting sign-in is waited out', async (t) => {
    const r = await sandbox(t, { creds: null, cloud: { start: [{ status: 429, headers: { 'Retry-After': '0' }, json: {} }, DEFAULT_START] }, env: FAST }).run(['login', '--no-open']);
    assert.equal(r.status, 0, r.out);
    assert.equal(calls(r, '/api/cli/login/start').length, 2);
  });

  test('a slow poll times out and polling continues until the token arrives', async (t) => {
    const r = await sandbox(t, { creds: null, cloud: { poll: [{ status: 202, json: {} }, { hang: true }, { status: 429, json: {} }, { status: 200, json: { owner: 'acme', token: 'sli_new' } }] }, env: FAST }).run(['login', '--no-open']);
    assert.equal(r.status, 0, r.out);
    assert.equal(calls(r, '/api/cli/login/poll').length, 4);
    assert.equal(r.creds.servers[PROD].token, 'sli_new');
  });

  test('a lost token answer says to sign in again instead of polling on', async (t) => {
    // The cloud sent the token (and deleted the sign-in), but the answer never
    // arrived; the next poll can only say the code is gone.
    for (const lost of [{ drop: true }, { hang: true }, { status: 502, json: {} }]) {
      const r = await sandbox(t, { creds: null, cloud: { poll: [{ status: 202, json: {} }, lost, { status: 410, json: { status: 'expired' } }] }, env: FAST }).run(['login', '--no-open']);
      assert.equal(r.status, 1, r.out);
      assert.match(r.out, /answer was lost on the way, and a token is only sent once\. Run the command again/, JSON.stringify(lost));
      assert.match(r.out, /https:\/\/app\.sl-ide\.com\/tokens/);
      assert.equal(calls(r, '/api/cli/login/poll').length, 3);
      assert.equal(r.creds, null);
    }
  });

  test('polling gives up on a cloud that stops answering', async (t) => {
    const r = await sandbox(t, { creds: null, cloud: { poll: [{ status: 202, json: {} }, { drop: true }] }, env: FAST }).run(['login', '--no-open']);
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /answer was lost/);
    assert.equal(calls(r, '/api/cli/login/poll').length, 6);
    assert.equal(r.creds, null);
  });

  test('a refused poll stops at once', async (t) => {
    const r = await sandbox(t, { creds: null, cloud: { poll: { status: 400, json: { error: 'need device_code' } } }, env: FAST }).run(['login', '--no-open']);
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /sign-in failed: need device_code/);
    assert.equal(calls(r, '/api/cli/login/poll').length, 1);
    assert.equal(r.creds, null);
  });

  test('--team is no longer accepted', async (t) => {
    const r = await sandbox(t).run(['pitch', '--team', 'acme']);
    assert.equal(r.status, 1);
    assert.match(r.out, /Unknown option/);
  });

  test('a token that belongs to another team stops before cloning', async (t) => {
    const r = await sandbox(t, { cloud: { whoami: { status: 200, json: { owner: 'globex' } } } }).run(PUBLISH);
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /saved account does not match the token/);
    assert.ok(!r.ran('git clone'));
  });

  test('credentials in an older layout read as none and are never sent', async (t) => {
    const r = await sandbox(t, { creds: { url: PROD, teams: { acme: { token: 'old-token' } } } }).run(['pitch', '--yes', '--no-install', '--no-publish']);
    assert.equal(r.status, 0, r.out);
    assert.ok(r.fetches.every((f) => f.auth === null), JSON.stringify(r.fetches));
  });

  const LOCAL = 'http://localhost:3000';
  const TWO_SERVERS = savedCreds({ [PROD]: { acme: 'prod-a', globex: 'prod-g' }, [LOCAL]: { acme: 'local-a' } });

  test('logout forgets tokens for this server only', async (t) => {
    const box = sandbox(t, { creds: TWO_SERVERS });
    const result = await box.run(['logout']);
    assert.equal(result.creds.servers[PROD], undefined);
    assert.equal(result.creds.servers[LOCAL].token, 'local-a');
  });

  test('logout --all forgets every server', async (t) => {
    const r = await sandbox(t, { creds: TWO_SERVERS }).run(['logout', '--all']);
    assert.match(r.out, /every server/);
    assert.deepEqual(r.creds.servers, {});
  });

  // --- cloud domain ----------------------------------------------------------

  test('sign-in defaults to app.sl-ide.com', async (t) => {
    const r = await sandbox(t, { creds: null }).run(['login', '--no-open']);
    assert.equal(r.status, 0, r.out);
    for (const { url } of r.fetches) assert.equal(new URL(url).origin, PROD);
  });

  test('cloud calls never follow redirects', async (t) => {
    const r = await sandbox(t).run([...PUBLISH, '--no-install']);
    assert.equal(r.status, 0, r.out);
    for (const f of r.fetches) assert.equal(f.redirect, 'error', JSON.stringify(f));
  });

  test('SL_IDE_URL points every cloud call at another server, with its own token', async (t) => {
    const r = await sandbox(t, { creds: TWO_SERVERS, env: { SL_IDE_URL: 'HTTP://LOCALHOST:3000/some/path/' } }).run([...PUBLISH, '--no-install']);
    assert.equal(r.status, 0, r.out);
    for (const { url, auth } of r.fetches) {
      assert.equal(new URL(url).origin, LOCAL);
      assert.equal(auth, 'Bearer local-a');
    }
    assert.ok(r.ran('gh secret set SL_IDE_PUBLISH_TOKEN'));
    assert.deepEqual(r.config(), { slug: 'pitch', url: LOCAL });
    assert.match(r.out, /http:\/\/localhost:3000\/d\/pitch\//);
  });

  test('a production token is never sent to another server', async (t) => {
    const r = await sandbox(t, { env: { SL_IDE_URL: LOCAL } }).run(['pitch', '--yes', '--no-install', '--no-publish']);
    assert.equal(r.status, 0, r.out);
    assert.ok(r.fetches.every((f) => f.auth === null), JSON.stringify(r.fetches));
    assert.ok(!r.ran('gh secret'));
  });

  test('signing in on another server saves the token for that server', async (t) => {
    const r = await sandbox(t, { env: { SL_IDE_URL: LOCAL } }).run(['login', '--no-open']);
    assert.equal(r.status, 0, r.out);
    assert.equal(r.creds.servers[LOCAL].token, 'sli_new');
    assert.equal(r.creds.servers[PROD].token, 'fake-token');
  });

  for (const bad of ['http://staging.example.com', 'https://user:pw@app.sl-ide.com', 'not a url']) {
    test(`SL_IDE_URL=${bad} is refused before any cloud call`, async (t) => {
      const r = await sandbox(t, { env: { SL_IDE_URL: bad } }).run(PUBLISH);
      assert.equal(r.status, 1, r.out);
      assert.match(r.out, /SL_IDE_URL: /);
      assert.deepEqual(r.fetches, []);
      assert.ok(!r.ran('git clone'));
    });
  }

  // --- failures and recovery -------------------------------------------------

  test('a failed clone says nothing reached GitHub and how to start over', async (t) => {
    const r = await sandbox(t, { fail: ['git clone'] }).run(PUBLISH);
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /Nothing was created on GitHub/);
    assert.match(r.out, /Delete pitch, then run:[\s│]*pnpm create sl-ide pitch --yes/);
  });

  test('a failed repo create asks to check GitHub before starting over', async (t) => {
    const r = await sandbox(t, { fail: ['gh repo create'] }).run(PUBLISH);
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /Check github\.com\/tester\/pitch[\s\S]*gh repo delete tester\/pitch/);
    assert.ok(!r.ran('git push'));
  });

  test('a failed secret explains how to finish publishing by hand', async (t) => {
    const r = await sandbox(t, { fail: ['gh secret set'] }).run(PUBLISH);
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /gh secret set SL_IDE_PUBLISH_TOKEN --repo tester\/pitch failed \(test\)/);
    assert.match(r.out, /https:\/\/app\.sl-ide\.com\/tokens[\s\S]*cd pitch[\s\S]*gh secret set SL_IDE_PUBLISH_TOKEN --repo tester\/pitch[\s\S]*git push -u origin main/);
    assert.ok(!r.ran('git push'), 'never pushes without the publish secret');
    assert.doesNotMatch(r.out, /fake-token/);
  });

  test('a failed push says to push again', async (t) => {
    const r = await sandbox(t, { fail: ['git push'] }).run(PUBLISH);
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /github\.com\/tester\/pitch exists[\s\S]*cd pitch[\s\S]*git push -u origin main/);
    assert.ok(!r.ran('pnpm install'));
  });

  test('a failed install leaves a published deck and says to install', async (t) => {
    const r = await sandbox(t, { fail: ['pnpm install'] }).run(PUBLISH);
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /Only the install is left[\s\S]*cd pitch[\s\S]*pnpm install/);
  });

  test('in-place setup recovery says to empty the folder, not cd', async (t) => {
    const box = sandbox(t, { fail: ['git clone'] });
    const r = await box.run(['.', '--yes']);
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /Empty this folder, then run:[\s│]*pnpm create sl-ide \. --yes/);
  });

  for (const [step, signal, code, recovery] of [
    ['git clone', 'SIGINT', 130, /Nothing was created on GitHub/],
    ['git push', 'SIGINT', 130, /cd pitch[\s\S]*git push -u origin main/],
    ['pnpm install', 'SIGTERM', 143, /Only the install is left/],
  ]) {
    test(`interrupted during ${step} (${signal}): stops the command, fails and explains recovery`, async (t) => {
      const r = await sandbox(t, { hang: [step] }).interrupt(PUBLISH, signal);
      assert.equal(r.status, code, r.out);
      assert.match(r.out, /Setup was interrupted\. To recover:/);
      assert.match(r.out, recovery);
      assert.ok(!alive(r.hungPid), `${step} should be stopped`);
    });
  }
});
