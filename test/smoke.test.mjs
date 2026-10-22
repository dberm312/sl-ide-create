// create-A: setup variants, expired credentials, interruption and recovery.
import test from 'node:test';
import assert from 'node:assert/strict';
import { alive, PROD, sandbox, savedCreds } from './harness.mjs';

const PUBLISH = ['pitch', '--yes', '--team', 'acme'];

// --- formats ---------------------------------------------------------------

test('slides: clones, publishes for the team and installs', (t) => {
  const r = sandbox(t).run(PUBLISH);
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(r.config(), { slug: 'pitch', team: 'acme' });
  for (const step of ['git clone', 'git remote rename origin upstream', 'gh repo create pitch --private', 'gh secret set SL_IDE_PUBLISH_TOKEN --repo tester/pitch', 'git push -q -u origin main', 'pnpm install']) {
    assert.ok(r.ran(step), `${step} should run:\n${r.out}`);
  }
  assert.ok(!r.ran('node scripts/use-format.mjs'));
  assert.equal(r.file('pitch/format.txt'), null);
  assert.match(r.out, /Deck ready\./);
});

test('memo: swaps in the memo starter and commits it before publishing', (t) => {
  const r = sandbox(t).run([...PUBLISH, '--memo']);
  assert.equal(r.status, 0, r.out);
  assert.equal(r.file('pitch/format.txt'), 'memo');
  const commits = r.commands.filter((c) => c.includes('commit')).map((c) => c.at(-1));
  assert.deepEqual(commits, ['Start from the memo starter', 'Publish to sl-ide cloud as pitch (team acme)']);
  assert.match(r.out, /outline the memo/);
  assert.match(r.out, /Memo ready\./);
});

test('memo on a template without formats stops with recovery steps', (t) => {
  const r = sandbox(t, { useFormat: false }).run([...PUBLISH, '--format', 'memo']);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /this sl-ide template has no memo format yet/);
  assert.match(r.out, /Nothing was created on GitHub/);
  assert.ok(!r.ran('gh repo create'));
});

test('an unknown format is rejected before cloning', (t) => {
  const r = sandbox(t).run([...PUBLISH, '--format', 'poster']);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /--format is slides or memo/);
  assert.ok(!r.ran('git clone'));
});

// --- skipped steps ---------------------------------------------------------

test('--github none: no GitHub calls, no publishing, still a working deck', (t) => {
  const r = sandbox(t).run([...PUBLISH, '--github', 'none', '--no-install']);
  assert.equal(r.status, 0, r.out);
  assert.ok(r.ran('git clone'));
  assert.ok(!r.commands.some((c) => c[0] === 'gh' && c[1] !== 'auth'), JSON.stringify(r.commands));
  assert.equal(r.config(), null);
  assert.deepEqual(r.fetches, []);
  assert.match(r.out, /Publishing runs in GitHub Actions/);
  assert.match(r.out, /Not publishing/);
});

// --- preflight -------------------------------------------------------------

test('gh not signed in: stops before the first question with the fix', (t) => {
  const r = sandbox(t, { fail: ['gh auth status'] }).run(['pitch', '--yes', '--no-install']);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /Sign in to GitHub first: gh auth login/);
  assert.match(r.out, /Stuck\? https:\/\/sl-ide\.com\/contact/);
  assert.ok(!r.ran('git clone'));
  assert.deepEqual(r.fetches, []);
});

test('--github private without gh sign-in stops before cloning', (t) => {
  const r = sandbox(t, { fail: ['gh auth status'] }).run([...PUBLISH, '--github', 'private']);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /gh auth login/);
  assert.ok(!r.ran('git clone'));
});

test('gh not installed: stops and says how to install it', (t) => {
  const r = sandbox(t, { missing: ['gh'] }).run(PUBLISH);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /The GitHub CLI \(gh\) is needed: https:\/\/cli\.github\.com/);
  assert.ok(!r.ran('git clone'));
});

test('gh not installed is fine with --github none', (t) => {
  const r = sandbox(t, { missing: ['gh'] }).run([...PUBLISH, '--github', 'none', '--no-install']);
  assert.equal(r.status, 0, r.out);
  assert.ok(r.ran('git clone'));
});

test('pnpm missing: stops with corepack enable pnpm', (t) => {
  const r = sandbox(t, { missing: ['pnpm'] }).run(PUBLISH);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /pnpm is needed: corepack enable pnpm/);
  assert.ok(r.commands.length === 0, JSON.stringify(r.commands));
});

for (const [version, ok] of [['20.11.1', false], ['20.19.0', true], ['21.7.3', false], ['22.11.0', false], ['22.12.0', true], ['24.0.0', true]]) {
  test(`Node ${version} ${ok ? 'passes' : 'stops'} the preflight`, (t) => {
    const r = sandbox(t, { node: version }).run([...PUBLISH, '--github', 'none', '--no-install']);
    if (ok) assert.equal(r.status, 0, r.out);
    else {
      assert.equal(r.status, 1, r.out);
      assert.match(r.out, new RegExp(`Node ${version.replace(/\./g, '\\.')} is too old; sl-ide needs 20\\.19\\+ or 22\\.12\\+`));
      assert.ok(!r.ran('git clone'));
    }
  });
}

test('an unknown --github value is rejected before anything runs', (t) => {
  const r = sandbox(t).run(['pitch', '--yes', '--github', 'bogus']);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /--github is private, public or none/);
  assert.ok(!r.ran('git clone'));
});

test('--no-publish: makes the repo but sets no secret and no config', (t) => {
  const r = sandbox(t).run([...PUBLISH, '--no-publish', '--no-install']);
  assert.equal(r.status, 0, r.out);
  assert.ok(r.ran('gh repo create'));
  assert.ok(!r.ran('gh secret'));
  assert.equal(r.config(), null);
  assert.deepEqual(r.fetches, []);
});

test('--no-install: skips pnpm install and lists it as a next step', (t) => {
  const r = sandbox(t).run([...PUBLISH, '--no-install']);
  assert.equal(r.status, 0, r.out);
  assert.ok(!r.ran('pnpm install'));
  assert.match(r.out, /cd pitch\s[\s\S]*pnpm install[\s\S]*pnpm dev/);
});

test('non-interactive with no saved team skips publishing and says how to start', (t) => {
  const r = sandbox(t, { creds: null }).run(['pitch', '--yes', '--no-install']);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /pass --team <slug>, or run pnpm create sl-ide login/);
  assert.equal(r.config(), null);
  assert.ok(!r.ran('gh secret'));
});

test('an existing non-empty folder stops before anything runs', (t) => {
  const box = sandbox(t);
  box.run(['pitch', '--yes', '--github', 'none', '--no-install']);
  const r = box.run(['pitch', '--yes', '--github', 'none', '--no-install']);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /already exists and isn't empty/);
});

// --- credentials -----------------------------------------------------------

test('a rejected saved token stops before cloning and says to sign in again', (t) => {
  const r = sandbox(t, { cloud: { whoami: { status: 401, json: { error: 'unauthorized' } } } }).run(PUBLISH);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /token for acme was rejected[\s\S]*pnpm create sl-ide login/);
  assert.ok(!r.ran('git clone'));
});

test('an expired sign-in code during setup stops before cloning and saves nothing', (t) => {
  const r = sandbox(t, { creds: null, cloud: { poll: { status: 410, json: { error: 'expired_token' } } } })
    .run(['pitch', '--yes', '--team', 'acme', '--no-open']);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /sign-in code expired; run the command again/);
  assert.equal(r.creds, null);
  assert.ok(!r.ran('git clone'));
});

test('login saves the approved team token privately', (t) => {
  const r = sandbox(t, { creds: null }).run(['login', '--no-open']);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /ABCD-1234/);
  assert.equal(r.creds.servers[PROD].teams.acme.token, 'sli_new');
  assert.equal(r.credsMode, 0o600);
});

test('signing in for --team publishes for the team that was approved', (t) => {
  const r = sandbox(t, { creds: null, cloud: { poll: { status: 200, json: { team: 'globex', token: 'sli_globex' } }, whoami: { status: 200, json: { team: 'globex' } } } })
    .run(['pitch', '--yes', '--team', 'acme', '--no-open', '--no-install']);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /You approved team globex/);
  assert.equal(r.config().team, 'globex');
});

test('a token that belongs to another team stops before cloning', (t) => {
  const r = sandbox(t, { cloud: { whoami: { status: 200, json: { team: 'globex' } } } }).run(PUBLISH);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /token saved for acme belongs to team globex/);
  assert.ok(!r.ran('git clone'));
});

test('credentials in an older layout read as none and are never sent', (t) => {
  const r = sandbox(t, { creds: { url: PROD, teams: { acme: { token: 'old-token' } } } }).run(['pitch', '--yes', '--no-install']);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /pass --team <slug>, or run pnpm create sl-ide login/);
  assert.ok(r.fetches.every((f) => f.auth === null), JSON.stringify(r.fetches));
});

const LOCAL = 'http://localhost:3000';
const TWO_SERVERS = savedCreds({ [PROD]: { acme: 'prod-a', globex: 'prod-g' }, [LOCAL]: { acme: 'local-a' } });

test('logout forgets tokens for this server only', (t) => {
  const box = sandbox(t, { creds: TWO_SERVERS });
  const one = box.run(['logout', 'acme']);
  assert.match(one.out, /Forgot the token for acme on https:\/\/app\.sl-ide\.com/);
  assert.deepEqual(Object.keys(one.creds.servers[PROD].teams), ['globex']);
  assert.equal(one.creds.servers[LOCAL].teams.acme.token, 'local-a');
  const all = box.run(['logout']);
  assert.equal(all.creds.servers[PROD], undefined);
  assert.equal(all.creds.servers[LOCAL].teams.acme.token, 'local-a');
});

test('logout --all forgets every server', (t) => {
  const r = sandbox(t, { creds: TWO_SERVERS }).run(['logout', '--all']);
  assert.match(r.out, /every server/);
  assert.deepEqual(r.creds.servers, {});
});

// --- cloud domain ----------------------------------------------------------

test('setup and sign-in default to app.sl-ide.com', (t) => {
  const r = sandbox(t, { creds: null }).run(['pitch', '--yes', '--team', 'acme', '--no-open', '--no-install']);
  assert.equal(r.status, 0, r.out);
  assert.ok(r.fetches.length >= 3, JSON.stringify(r.fetches));
  for (const { url } of r.fetches) assert.equal(new URL(url).origin, 'https://app.sl-ide.com');
  assert.match(r.out, /https:\/\/app\.sl-ide\.com\/cli\?code=ABCD-1234/);
  assert.match(r.out, /https:\/\/app\.sl-ide\.com\/d\/pitch\//);
});

test('cloud calls never follow redirects', (t) => {
  const r = sandbox(t).run([...PUBLISH, '--no-install']);
  assert.equal(r.status, 0, r.out);
  for (const f of r.fetches) assert.equal(f.redirect, 'error', JSON.stringify(f));
});

test('SL_IDE_URL points every cloud call at another server, with its own token', (t) => {
  const r = sandbox(t, { creds: TWO_SERVERS, env: { SL_IDE_URL: 'HTTP://LOCALHOST:3000/some/path/' } }).run([...PUBLISH, '--no-install']);
  assert.equal(r.status, 0, r.out);
  for (const { url, auth } of r.fetches) {
    assert.equal(new URL(url).origin, LOCAL);
    assert.equal(auth, 'Bearer local-a');
  }
  assert.ok(r.ran('gh secret set SL_IDE_PUBLISH_TOKEN'));
  assert.deepEqual(r.config(), { slug: 'pitch', team: 'acme', url: LOCAL });
  assert.match(r.out, /http:\/\/localhost:3000\/d\/pitch\//);
});

test('a production token is never sent to another server', (t) => {
  const r = sandbox(t, { env: { SL_IDE_URL: LOCAL } }).run(['pitch', '--yes', '--no-install']);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /pass --team <slug>, or run pnpm create sl-ide login/);
  assert.ok(r.fetches.every((f) => f.auth === null), JSON.stringify(r.fetches));
  assert.ok(!r.ran('gh secret'));
});

test('signing in on another server saves the token for that server', (t) => {
  const r = sandbox(t, { env: { SL_IDE_URL: LOCAL } }).run(['login', '--no-open']);
  assert.equal(r.status, 0, r.out);
  assert.equal(r.creds.servers[LOCAL].teams.acme.token, 'sli_new');
  assert.equal(r.creds.servers[PROD].teams.acme.token, 'fake-token');
});

for (const bad of ['http://staging.example.com', 'https://user:pw@app.sl-ide.com', 'not a url']) {
  test(`SL_IDE_URL=${bad} is refused before any cloud call`, (t) => {
    const r = sandbox(t, { env: { SL_IDE_URL: bad } }).run(PUBLISH);
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /SL_IDE_URL: /);
    assert.deepEqual(r.fetches, []);
    assert.ok(!r.ran('git clone'));
  });
}

// --- failures and recovery -------------------------------------------------

test('a failed clone says nothing reached GitHub and how to start over', (t) => {
  const r = sandbox(t, { fail: ['git clone'] }).run(PUBLISH);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /Nothing was created on GitHub/);
  assert.match(r.out, /Delete pitch, then run:[\s│]*pnpm create sl-ide pitch --yes --team acme/);
});

test('a failed repo create asks to check GitHub before starting over', (t) => {
  const r = sandbox(t, { fail: ['gh repo create'] }).run(PUBLISH);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /Check github\.com\/tester\/pitch[\s\S]*gh repo delete tester\/pitch/);
  assert.ok(!r.ran('git push'));
});

test('a failed secret explains how to finish publishing by hand', (t) => {
  const r = sandbox(t, { fail: ['gh secret set'] }).run(PUBLISH);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /gh secret set SL_IDE_PUBLISH_TOKEN --repo tester\/pitch failed \(test\)/);
  assert.match(r.out, /https:\/\/app\.sl-ide\.com\/tokens[\s\S]*cd pitch[\s\S]*gh secret set SL_IDE_PUBLISH_TOKEN --repo tester\/pitch[\s\S]*git push -u origin main/);
  assert.ok(!r.ran('git push'), 'never pushes without the publish secret');
  assert.doesNotMatch(r.out, /fake-token/);
});

test('a failed push says to push again', (t) => {
  const r = sandbox(t, { fail: ['git push'] }).run(PUBLISH);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /github\.com\/tester\/pitch exists[\s\S]*cd pitch[\s\S]*git push -u origin main/);
  assert.ok(!r.ran('pnpm install'));
});

test('a failed install leaves a published deck and says to install', (t) => {
  const r = sandbox(t, { fail: ['pnpm install'] }).run(PUBLISH);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /Only the install is left[\s\S]*cd pitch[\s\S]*pnpm install/);
});

test('in-place setup recovery says to empty the folder, not cd', (t) => {
  const box = sandbox(t, { fail: ['git clone'] });
  const r = box.run(['.', '--yes', '--team', 'acme']);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /Empty this folder, then run:[\s│]*pnpm create sl-ide \. --yes --team acme/);
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
