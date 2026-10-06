import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPrivacyGuard, findSensitive, maskSensitiveData, PRIVACY_CHOICES } from '../src/privacy.ts';

test('email, international phone, Luhn cards and multiple credentials are detected locally', () => {
  const first = 'ghp_' + 'Ab1'.repeat(12);
  const second = 'sk_test_' + 'Cd2'.repeat(8);
  const input = `person+tag@example.com +52 998 123 4567 4111 1111 1111 1111 ${first} ${second}`;
  const clean = maskSensitiveData(input);
  for (const raw of ['person+tag@example.com', '+52 998 123 4567', '4111 1111 1111 1111', first, second]) assert.ok(!clean.includes(raw));
  assert.ok(clean.includes('p**********@****.com'));
  assert.ok(clean.includes('************1111'));
  assert.equal(findSensitive('commit abcdef1234 version 1.2.3 count 1234567890123').length, 0);
});

test('clean data, message order, tool declarations and opaque signatures survive', () => {
  const value = { messages: [{ role: 'system', content: 'Preserve the task', tools: [{ name: 'read', parameters: { type: 'object' } }] }], signature: 'person@example.com', image: { type: 'image', data: 'person@example.com' } };
  assert.deepEqual(maskSensitiveData(value), value);
  assert.equal(maskSensitiveData({ data: 'person@example.com' }).data, 'p**********@****.com');
});

test('dismissed consent cancels, produces only masked data, and is not remembered', async () => {
  const guard = createPrivacyGuard();
  const context = { destination: 'provider/model', interactive: true, choose: async () => undefined, notify: () => {} };
  const cancelled = await guard.inspect('person@example.com', context);
  assert.equal(cancelled.cancelled, true);
  assert.equal(cancelled.value, 'p**********@****.com');
  const next = await guard.inspect('person@example.com', { ...context, choose: async () => PRIVACY_CHOICES[1] });
  assert.equal(next.value, 'person@example.com');
});

test('background SDK guard hides keychain values and fails if the keychain is unavailable', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { createVault } = await import('../src/vault.ts');
  const { protectOutboundData } = await import('../src/privacy.ts');
  const { memoryKeys } = await import('./keys.ts');
  const root = await mkdtemp(join(tmpdir(), 'pi-privacy-background-'));
  const keys = memoryKeys();
  try {
    const vault = createVault({ root, keys });
    const value = 'ordinary-' + Math.random().toString(36).slice(2);
    await vault.put('SERVICE_PASSWORD', value, { scope: 'all' });
    const output = await protectOutboundData({ content: `${value} person@example.com` }, { root, keys });
    assert.equal(output.content, '[secret:SERVICE_PASSWORD] p**********@****.com');
    await assert.rejects(protectOutboundData(value, { root, keys: { ...keys, get: async () => { throw new Error('Locked'); } } }), /Locked/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
