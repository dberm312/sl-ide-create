import test from 'node:test';
import assert from 'node:assert/strict';
import { browserCommand, CLOUD, signInPage } from '../lib/cloud.mjs';

test('only http(s) pages on the cloud itself are opened', () => {
  assert.equal(signInPage(`${CLOUD}/cli?code=ABCD-1234`), `${CLOUD}/cli?code=ABCD-1234`);
  const other = new URL(CLOUD);
  other.hostname = `evil.${other.hostname}`;
  const downgrade = CLOUD.replace(/^https:/, 'http:');
  for (const link of [other.href, `${CLOUD}.evil.example/cli`, ...(downgrade === CLOUD ? [] : [downgrade]),
    CLOUD.replace('//', '//user:pw@'), 'file:///etc/passwd', 'javascript:alert(1)', 'not a url', '', undefined, null, 42, {}]) {
    assert.equal(signInPage(link), null, String(link));
  }
});

test('the page is normalized: no spaces or quotes reach the command line', () => {
  const href = signInPage(`${CLOUD}/cli?code="a b"&x=^|y#"z w"`);
  assert.ok(href.startsWith(`${CLOUD}/cli?`), href);
  assert.doesNotMatch(href, /[\s"]/);
});

test('no platform opens the browser through a shell', () => {
  const href = `${CLOUD}/cli&calc`;
  assert.deepEqual(browserCommand(href, 'win32'), ['rundll32', ['url.dll,FileProtocolHandler', href]]);
  assert.deepEqual(browserCommand(href, 'darwin'), ['open', [href]]);
  assert.deepEqual(browserCommand(href, 'linux'), ['xdg-open', [href]]);
});
