import test from 'node:test';
import assert from 'node:assert/strict';
import { sandbox } from './harness.mjs';
const args = ['pitch','--yes','--no-install','--no-publish','--github','none'];
for (const [option,auto] of [[[],false],[['--feedback','off'],false],[['--feedback','auto'],true]]) {
  test(`feedback consent ${option.join(' ')||'defaults off'}`,t=>{
    const r=sandbox(t).run([...args,...option]);
    assert.equal(r.status,0,r.out);
    const config=JSON.parse(r.file('pitch/.sl-ide/feedback.json'));
    assert.equal(config.auto,auto);
    assert.equal(config.version,1);
    assert.match(config.projectId,/^fb_[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
    assert.match(r.file('pitch/.gitignore'),/^\.sl-ide\/$/m);
    assert.ok(!r.fetches.some(f=>f.url.includes('/api/feedback')));
  });
}
test('new clones get unrelated project IDs',t=>{
  const a=sandbox(t).run(args),b=sandbox(t).run(args);
  assert.notEqual(JSON.parse(a.file('pitch/.sl-ide/feedback.json')).projectId,JSON.parse(b.file('pitch/.sl-ide/feedback.json')).projectId);
});
test('invalid feedback option stops before cloning',t=>{
  const r=sandbox(t).run([...args,'--feedback','yes']);
  assert.equal(r.status,1);assert.match(r.out,/--feedback is auto or off/);
  assert.ok(!r.ran('git clone'));
});
