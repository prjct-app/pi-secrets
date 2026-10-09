import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPrivacyGuard, maskSensitiveData, protectOutboundData } from '../src/privacy.ts';
import { createRedactor } from '../src/redact.ts';
import { createVault } from '../src/vault.ts';
import { memoryKeys } from './keys.ts';

const id = 'rs_04f9f4efdc6bfd71016ac5633a415487d4111111111111111b535';
const opaque = { type: 'reasoning', id, encrypted_content: 'opaque-secret-person@example.com-4111111111111111', summary: [] };

test('provider item IDs and encrypted reasoning survive PII and known-secret guards byte for byte', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pi-protocol-')); t.after(() => rm(root, { recursive: true, force: true }));
  const keys = memoryKeys(); await createVault({ root, keys }).put('TOKEN', 'opaque-secret', { scope: 'all' });
  const signature = JSON.stringify({ id, encrypted_content: opaque.encrypted_content });
  const payload = { input: [opaque, { type: 'message', id: 'msg_4111111111111111', content: [{ type: 'input_text', text: 'person@example.com 4111111111111111 opaque-secret' }] }],
    thinkingSignature: signature, signature, response_id: 'resp_4111111111111111' };
  const protectedValue = await protectOutboundData(payload, { root, keys });
  assert.deepEqual(protectedValue.input[0], opaque);
  assert.equal(protectedValue.input[1]!.id, payload.input[1]!.id);
  assert.equal(protectedValue.signature, signature);
  assert.equal(protectedValue.thinkingSignature, signature);
  assert.equal(protectedValue.response_id, payload.response_id);
  assert.match(JSON.stringify(protectedValue.input[1]), /p\*+@\*+\.com/);
  assert.match(JSON.stringify(protectedValue.input[1]), /\[secret:TOKEN\]/);
  assert.deepEqual(createRedactor([{ name: 'TOKEN', value: 'opaque-secret' }]).deep(opaque), opaque);
});

test('opaque protocol values cause no consent prompt while ordinary ID data remains protected', async () => {
  const result = await createPrivacyGuard().inspect({ input: [opaque] }, { destination: 'fixture', interactive: true,
    choose: async () => { throw new Error('Protocol metadata must not request PII consent'); }, notify: () => {} });
  assert.deepEqual(result.value, { input: [opaque] });
  assert.equal(result.changed, false);
  assert.equal(maskSensitiveData({ id: 'person@example.com' }).id, 'p**********@****.com');
});

test('card-like digit runs inside identifiers are never replaced, even beside a real card', () => {
  assert.equal(maskSensitiveData(`${id} card 4111111111111111`), `${id} card ************1111`);
});

test('unchanged branches keep identity; changed branches never mutate their source', async () => {
  const { mapText } = await import('../src/protocol.ts');
  const stable = Object.freeze({ role: 'user', content: Object.freeze([{ type: 'text', text: 'verified evidence' }]) });
  const mutable = { type: 'text', text: 'original' };
  const source = { input: [stable, mutable], opaque };
  assert.equal(mapText(source, text => text), source);
  const protectedValue = mapText(source, text => text === 'original' ? 'changed' : text);
  assert.notEqual(protectedValue, source);
  assert.equal(protectedValue.input[0], stable);
  assert.equal(protectedValue.opaque, opaque);
  assert.equal(mutable.text, 'original');
  assert.equal((protectedValue.input[1] as typeof mutable).text, 'changed');
  mutable.text = 'person@example.com';
  assert.equal((maskSensitiveData(source).input[1] as typeof mutable).text, 'p**********@****.com', 'mutable input is inspected again');
});

test('protocol traversal preserves sparse arrays and own __proto__ fields', async () => {
  const { mapText } = await import('../src/protocol.ts');
  const sparse = new Array(3); sparse[2] = 'original';
  const changed = mapText(sparse, text => text.toUpperCase());
  assert.equal(0 in changed, false); assert.equal(changed[2], 'ORIGINAL');
  const object = JSON.parse('{"__proto__":"original"}');
  const clean = mapText(object, text => text.toUpperCase());
  assert.equal(Object.getPrototypeOf(clean), Object.prototype);
  assert.equal(Object.getOwnPropertyDescriptor(clean, '__proto__')?.value, 'ORIGINAL');
});
