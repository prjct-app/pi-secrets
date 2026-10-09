import assert from 'node:assert/strict';
import { test } from 'node:test';
import { categoryOf, createTally, detectLanguage, obfuscationNotice } from '../src/notice.ts';

test('the notice counts distinct values per category, in a fixed order, with singular and plural', () => {
  const tally = createTally();
  tally.add([{ category: 'email', value: 'a@example.com' }, { category: 'email', value: 'b@example.com' },
    { category: 'email', value: 'a@example.com' }, { category: 'card', value: '4111111111111111' }, { category: 'stored', value: 'STRIPE_KEY' }]);
  assert.equal(tally.size(), 4);
  assert.equal(obfuscationNotice(tally.counts(), 'en'), 'Secrets obfuscated before sending to the model: 1 stored secret, 2 emails, 1 payment card.');
  assert.equal(obfuscationNotice(tally.counts(), 'es'), 'Secrets ofuscó antes de enviar al modelo: 1 secreto guardado, 2 correos, 1 tarjeta de pago.');
  tally.add([{ category: 'phone', value: '+52 55 1234 5678' }, { category: 'phone', value: '+1 415 555 0100' }, { category: 'credential', value: 'ghp_x' }]);
  assert.equal(obfuscationNotice(tally.counts(), 'en'), 'Secrets obfuscated before sending to the model: 1 stored secret, 1 credential, 2 emails, 1 payment card, 2 phone numbers.');
  tally.clear();
  assert.equal(tally.size(), 0);
});

test('the tally keeps hashes, never the values', () => {
  const tally = createTally();
  tally.add([{ category: 'email', value: 'secret.person@example.com' }]);
  assert.ok(!JSON.stringify([...Object.values(tally)].map(String)).includes('secret.person'));
  assert.equal(tally.counts().get('email'), 1);
});

test('finding kinds map to the categories people use', () => {
  assert.equal(categoryOf('email'), 'email');
  assert.equal(categoryOf('payment card'), 'card');
  assert.equal(categoryOf('international phone'), 'phone');
  assert.equal(categoryOf('GitHub token'), 'credential');
  assert.equal(categoryOf('private key'), 'credential');
});

test('the notice follows the language the person typed, English by default', () => {
  assert.equal(detectLanguage('revisa que no se filtre nada'), 'es');
  assert.equal(detectLanguage('¿Dónde está el archivo?'), 'es');
  assert.equal(detectLanguage('please check that nothing leaks to the model'), 'en');
  assert.equal(detectLanguage('person@example.com sk_test_123'), 'en');
  assert.equal(detectLanguage(''), 'en');
});
