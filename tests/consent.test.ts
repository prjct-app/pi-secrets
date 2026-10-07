import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPrivacyGuard, findSensitive, PRIVACY_CHOICES, type PrivacySnapshot } from '../src/privacy.ts';

const destination = 'fixture/model (https://fixture.invalid)';
const context = { destination, interactive: true, choose: async () => PRIVACY_CHOICES[0], notify() {} };

test('50 simultaneous inspections of one value share one consent dialog', async () => {
  for (const choice of [PRIVACY_CHOICES[0], PRIVACY_CHOICES[1]]) {
    const guard = createPrivacyGuard();
    const count = { dialogs: 0 };
    const outputs = await Promise.all(Array.from({ length: 50 }, () => guard.inspect('person@example.com', {
      ...context, choose: async () => { count.dialogs++; await new Promise(resolve => setImmediate(resolve)); return choice; },
    })));
    assert.equal(count.dialogs, 1);
    assert.ok(outputs.every(result => !result.cancelled && result.value === (choice === PRIVACY_CHOICES[1] ? 'person@example.com' : 'p**********@****.com')));
  }
});

test('package versions never prompt or rewrite code while real email remains protected', () => {
  const code = '@prjct.app/pi-secrets@0.2.3 typebox@1.3.7 package@1.2.3-beta';
  assert.deepEqual(findSensitive(code), []);
  assert.deepEqual(findSensitive(code + ' person+tag@example.com').map(item => item.value), ['person+tag@example.com']);
});

test('cancelling one dialog cancels queued inspections without 49 more prompts', async () => {
  const guard = createPrivacyGuard();
  const count = { dialogs: 0 };
  const ctx = { ...context, choose: async () => { count.dialogs++; return PRIVACY_CHOICES[2]; } };
  const results = await Promise.all(Array.from({ length: 50 }, () => guard.inspect('person@example.com', ctx)));
  assert.equal(count.dialogs, 1);
  assert.ok(results.every(result => result.cancelled && result.value === 'p**********@****.com'));
  await guard.inspect('person@example.com', ctx);
  assert.equal(count.dialogs, 2, 'a later user retry gets a fresh decision');
});

test('automatic masking is opt-in, remembers new values, and stays bound to its destination', async () => {
  const snapshots: PrivacySnapshot[] = [];
  const guard = createPrivacyGuard({ onChange: value => snapshots.push(value) });
  const count = { dialogs: 0, notices: 0 };
  const ctx = { ...context, choose: async () => { count.dialogs++; return PRIVACY_CHOICES[3]; }, notify: () => { count.notices++; } };
  await guard.inspect('first@example.com', ctx);
  for (const n of Array.from({ length: 50 }, (_, n) => n)) {
    const output = await guard.inspect(`next${n}@example.com`, ctx);
    assert.equal(output.value, 'n**********@****.com');
    assert.equal(output.cancelled, false);
  }
  assert.equal(count.dialogs, 1);
  assert.equal(count.notices, 0);
  assert.equal(snapshots.length, 1, 'the automatic policy needs one entry, not one per new value');
  assert.equal(snapshots[0]!.decisions.length, 0);
  await guard.inspect('first@example.com', { ...ctx, destination: 'another-provider' });
  assert.equal(count.dialogs, 2);
  guard.reset();
  await guard.inspect('first@example.com', ctx);
  assert.equal(count.dialogs, 3);
});

test('ordinary masking asks again for new data; automatic masking overrides previous send choices', async () => {
  const guard = createPrivacyGuard();
  const count = { dialogs: 0 };
  const ctx = { ...context, choose: async () => { count.dialogs++; return PRIVACY_CHOICES[0]; } };
  await guard.inspect('first@example.com', ctx);
  await guard.inspect('second@example.com', ctx);
  assert.equal(count.dialogs, 2);
  await guard.inspect('third@example.com', { ...ctx, choose: async () => PRIVACY_CHOICES[1] });
  await guard.inspect('fourth@example.com', { ...ctx, choose: async () => PRIVACY_CHOICES[3] });
  const after = await guard.inspect('third@example.com', ctx);
  assert.equal(after.value, 't**********@****.com');
  assert.equal(count.dialogs, 2);
});

test('saved consent contains fingerprints only and restores without another dialog', async () => {
  const snapshots: PrivacySnapshot[] = [];
  const guard = createPrivacyGuard({ onChange: value => snapshots.push(value) });
  await guard.inspect('person@example.com', { ...context, choose: async () => PRIVACY_CHOICES[1] });
  assert.equal(snapshots.length, 1);
  assert.ok(!JSON.stringify(snapshots).includes('person@example.com'));
  const reloaded = createPrivacyGuard();
  reloaded.restore(JSON.parse(JSON.stringify(snapshots[0])));
  const restored = await reloaded.inspect('person@example.com', { ...context, choose: async () => { throw Error('Unexpected dialog'); } });
  assert.equal(restored.value, 'person@example.com');
  const another = await reloaded.inspect('person@example.com', { ...context, destination: 'different/model', choose: async () => PRIVACY_CHOICES[2] });
  assert.equal(another.cancelled, true);
  reloaded.restore({ v: 1, salt: 'invalid', decisions: [] });
  const invalid = await reloaded.inspect('person@example.com', { ...context, choose: async () => PRIVACY_CHOICES[2] });
  assert.equal(invalid.cancelled, true);
});

test('reset during a pending dialog cannot authorize the old request or the next session', async () => {
  const guard = createPrivacyGuard();
  const gate: { approve?: (choice: string) => void; opened?: () => void } = {};
  const pending = new Promise<string>(resolve => { gate.approve = resolve; });
  const opened = new Promise<void>(resolve => { gate.opened = resolve; });
  const old = guard.inspect('person@example.com', { ...context, choose: async () => { gate.opened?.(); return pending; } });
  await opened;
  guard.reset();
  gate.approve?.(PRIVACY_CHOICES[1]);
  assert.equal((await old).cancelled, true);
  const current = await guard.inspect('person@example.com', { ...context, choose: async () => PRIVACY_CHOICES[2] });
  assert.equal(current.cancelled, true);
});

test('background masking emits one notice for the session instead of one per value', async () => {
  const guard = createPrivacyGuard();
  const count = { notices: 0 };
  for (const n of Array.from({ length: 50 }, (_, n) => n)) {
    const result = await guard.inspect(`person${n}@example.com`, { ...context, interactive: false,
      choose: async () => { throw Error('Background must not prompt'); }, notify: () => { count.notices++; } });
    assert.equal(result.value, 'p**********@****.com');
  }
  assert.equal(count.notices, 1);
});
