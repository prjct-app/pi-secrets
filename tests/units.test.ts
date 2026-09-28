import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { sight } from '../src/detect.ts';
import { envFile, privateDir, quote } from '../src/inject.ts';
import { mentions, tail, toName, valueProblem } from '../src/names.ts';
import { createRedactor, createStreamRedactor, forms } from '../src/redact.ts';
import { createVault, inScope, projectOf } from '../src/vault.ts';
import { memoryKeys } from './keys.ts';

const VALUE = 'sk_test_51HxYzAbCdEfGhIjKlMnOp';


test('every printed form of a value becomes its marker', () => {
  const redactor = createRedactor([{ name: 'STRIPE', value: VALUE }]);
  const base64 = Buffer.from(VALUE).toString('base64');
  for (const form of forms(VALUE)) assert.equal(redactor.text(`a ${form} b`), 'a [secret:STRIPE] b');
  assert.equal(redactor.text(`Authorization: Basic ${base64}`), 'Authorization: Basic [secret:STRIPE]');
  assert.deepEqual(redactor.found(`x ${VALUE} y`), ['STRIPE']);
  assert.equal(redactor.text('nothing here'), 'nothing here');
});

test('deep redaction reaches nested strings and leaves images alone', () => {
  const redactor = createRedactor([{ name: 'K', value: VALUE }]);
  const image = { type: 'image', data: Buffer.from(VALUE).toString('base64'), mimeType: 'image/png' };
  const input = { content: [{ type: 'text', text: `key=${VALUE}` }, image], n: 3 };
  const output = redactor.deep(input);
  assert.deepEqual(output.content[0], { type: 'text', text: 'key=[secret:K]' });
  assert.equal(output.content[1], image);
  assert.equal(output.n, 3);
});

test('a value split across stream chunks is still hidden', () => {
  const redactor = createRedactor([{ name: 'K', value: VALUE }]);
  const out: string[] = [];
  const stream = createStreamRedactor(redactor, chunk => out.push(chunk.toString('utf8')));
  const text = `before ${VALUE} after ñ`;
  for (const char of Buffer.from(text)) stream.write(Buffer.from([char]));
  stream.end();
  assert.equal(out.join(''), 'before [secret:K] after ñ');
  assert.ok(out.every(chunk => !chunk.includes(VALUE.slice(0, 12))));
});

test('names: mentions are whole words, the tail shows at most the last six', () => {
  assert.deepEqual(mentions('curl -H "Bearer $STRIPE_KEY" && echo ${OTHER}', ['STRIPE_KEY', 'OTHER', 'STRIPE']), ['STRIPE_KEY', 'OTHER']);
  assert.deepEqual(mentions('echo $STRIPE_KEYS', ['STRIPE_KEY']), []);
  assert.equal(tail(VALUE), '••••KlMnOp');
  assert.equal(tail('abcdefgh'), '••••gh');
  assert.equal(toName('stripe live-key'), 'STRIPE_LIVE_KEY');
  assert.match(valueProblem('short') ?? '', /at least 8/);
});

test('pasted credentials are recognized by shape', () => {
  assert.equal(sight(`use ${VALUE} please`)?.name, 'STRIPE_SECRET_KEY');
  assert.equal(sight('token ghp_' + 'a'.repeat(36))?.name, 'GITHUB_TOKEN');
  assert.equal(sight('commit 3f9a2b1c4d5e6f708192a3b4c5d6e7f809a1b2c3'), undefined);
});

test('the vault keeps values only in the key store', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-secrets-vault-'));
  try {
    const keys = memoryKeys();
    const vault = createVault({ root, keys });
    const project = realpathSync(root);
    await vault.put('STRIPE_KEY', VALUE, { scope: [project], description: 'test mode' });
    assert.equal(keys.map.get('STRIPE_KEY'), VALUE);
    const index = readFileSync(join(root, 'index.json'), 'utf8');
    assert.ok(!index.includes(VALUE) && !index.includes(VALUE.slice(-6)));
    assert.equal(statSync(join(root, 'index.json')).mode & 0o777, 0o600);
    const entry = vault.find('STRIPE_KEY')!;
    assert.equal(inScope(entry, project), true);
    assert.equal(inScope(entry, join(project, 'sub')), true);
    assert.equal(inScope(entry, `${project}-other`), false);
    vault.rescope('STRIPE_KEY', 'all');
    assert.equal(vault.find('STRIPE_KEY')!.scope, 'all');
    await vault.remove('STRIPE_KEY');
    assert.equal(keys.map.size, 0);
    assert.deepEqual(vault.list(), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('projectOf climbs to the folder holding .git', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pi-secrets-project-')));
  try {
    mkdirSync(join(root, '.git'));
    mkdirSync(join(root, 'a', 'b'), { recursive: true });
    assert.equal(projectOf(join(root, 'a', 'b')), root);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the environment file loads into the shell and deletes itself', () => {
  const base = mkdtempSync(join(tmpdir(), 'pi-secrets-env-'));
  try {
    const dir = privateDir(base);
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    const tricky = `it's $HOME "q" \`x\``;
    const file = envFile(dir, [{ name: 'K', value: VALUE }, { name: 'T', value: tricky }]);
    assert.equal(statSync(file.path).mode & 0o777, 0o600);
    const out = execFileSync('bash', ['-c', `${file.prefix}printf '%s|%s' "$K" "$T"`], { encoding: 'utf8' });
    assert.equal(out, `${VALUE}|${tricky}`);
    assert.equal(existsSync(file.path), false);
    assert.equal(quote("a'b"), `'a'\\''b'`);
  } finally { rmSync(base, { recursive: true, force: true }); }
});
