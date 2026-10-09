import assert from 'node:assert/strict';
import { randomInt } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createBashTool, SessionManager, type ExtensionAPI, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import { installSecrets } from '../src/index.ts';
import { memoryKeys } from './keys.ts';
import { PRIVACY_CHOICES } from '../src/privacy.ts';
import { PRIVACY_MODES } from '../src/privacy-settings.ts';

const VALUE = 'sk_test_51HxYzAbCdEfGhIjKlMnOp';
type Handler = (event: any, ctx: any) => any;

function harness(ui: { value?: string; select?: string; confirm?: boolean; input?: string } = {}) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'pi-secrets-ext-')));
  const cwd = join(base, 'project');
  const keys = memoryKeys();
  const sessionManager = SessionManager.inMemory(cwd);
  const handlers = new Map<string, Handler[]>();
  const tools = new Map<string, ToolDefinition>();
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
  const notices: string[] = [];
  const levels: string[] = [];
  const prompts: string[] = [];
  const editor: string[] = [];
  const aborted = { count: 0 };
  const ctx = {
    cwd, mode: 'tui', hasUI: true, sessionManager,
    model: { provider: 'offline', id: 'fixture', baseUrl: 'http://localhost' },
    abort: () => { aborted.count++; },
    ui: {
      notify: (text: string, level: string) => { notices.push(text); levels.push(level); },
      select: async (title: string) => { prompts.push(title); return ui.select; },
      confirm: async (title: string) => { prompts.push(title); return ui.confirm ?? false; },
      input: async (title: string) => { prompts.push(title); return ui.input; },
      custom: async () => ui.value,
      setEditorText: (text: string) => editor.push(text),
    },
  };
  const pi = {
    appendEntry: (customType: string, data: unknown) => sessionManager.appendCustomEntry(customType, data),
    on: (name: string, handler: Handler) => handlers.set(name, [...handlers.get(name) ?? [], handler]),
    registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
    registerCommand: (name: string, command: { handler: (args: string, ctx: unknown) => Promise<void> }) => commands.set(name, command),
  } as unknown as ExtensionAPI;
  installSecrets(pi, { root: join(base, 'index'), keys, tmp: join(base, 'tmp') });
  const emit = async (name: string, event: unknown, where = cwd) => {
    const results = [];
    for (const handler of handlers.get(name) ?? []) results.push(await handler(event, { ...ctx, cwd: where }));
    return results[0];
  };
  return {
    base, cwd, keys, notices, levels, prompts, editor, ctx, emit, aborted,
    tool: (name: string, params: unknown) => tools.get(name)!.execute('call', params as never, undefined, undefined, ctx as never),
    command: (text: string) => commands.get('secret')!.handler(text, ctx),
    tools,
    reload: () => {
      handlers.clear(); tools.clear(); commands.clear();
      installSecrets(pi, { root: join(base, 'index'), keys, tmp: join(base, 'tmp') });
    },
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
}

const text = (result: { content: { type: string; text?: string }[] }): string =>
  result.content.map(part => part.text ?? '').join('');

test('default privacy masks 50 concurrent sends with one native info and no conversation entry', async () => {
  const h = harness();
  try {
    const results = await Promise.all(Array.from({ length: 50 }, (_, i) =>
      h.emit('input', { text: `person${i}@example.com ${VALUE}`, source: 'interactive' })));
    assert.ok(results.every(result => result.action === 'transform' && !result.text.includes('@example.com') && !result.text.includes(VALUE)));
    assert.deepEqual(h.prompts, []);
    assert.equal(h.notices.length, 1);
    assert.deepEqual(h.levels, ['info']);
    assert.match(h.notices[0]!, /^Secrets obfuscated before sending to the model: 1 credential, 1 email\.$/);
    assert.ok(!JSON.stringify(h.notices).includes('@example.com'));
    assert.ok(!JSON.stringify(h.notices).includes(VALUE));
    assert.equal(h.ctx.sessionManager.getBranch().length, 0, 'native notices are not session or model messages');
    assert.equal(h.keys.map.size, 0, 'no storage offer for pasted credentials');
    for (const name of ['context', 'context_with_system', 'before_provider_request']) {
      const messages = [{ role: 'user', content: 'person@example.com' }];
      const result = await h.emit(name, name === 'before_provider_request' ? { payload: { messages } } : { messages });
      assert.ok(!JSON.stringify(result).includes('person@example.com'));
    }
    assert.equal(h.notices.length, 1, 'repeated outbound hooks share the notice');
    await h.emit('agent_settled', {});
    assert.equal(h.notices.length, 2, 'values masked after the first notice are reported once when the run settles');
    assert.equal(h.notices[1], 'Secrets obfuscated before sending to the model: 1 credential, 51 emails.');
    await h.emit('input', { text: 'next@example.com', source: 'interactive' });
    assert.equal(h.notices.length, 3, 'another send with sensitive data gets its own info');
    assert.equal(h.notices[2], 'Secrets obfuscated before sending to the model: 1 email.');
    await h.emit('agent_settled', {});
    assert.equal(h.notices.length, 3, 'nothing new since the notice: no second one');
    await h.emit('input', { text: 'Mi correo es otra@example.com y la tarjeta 4111 1111 1111 1111', source: 'interactive' });
    assert.equal(h.notices.at(-1), 'Secrets ofuscó antes de enviar al modelo: 1 correo, 1 tarjeta de pago.', 'the language the person typed');
    await h.emit('agent_settled', {});
    await h.emit('before_provider_request', { payload: { messages: [{ role: 'user', content: 'ordinary code' }] } });
    assert.equal(h.notices.length, 4, 'cloning a clean payload is not obfuscation');
  } finally { h.cleanup(); }
});

test('default info covers stored secrets in restored context and preserves opaque protocol', async () => {
  const h = harness({ value: VALUE, select: 'Every project' });
  try {
    await h.tool('secret_request', { name: 'STRIPE_KEY', reason: 'x' });
    h.notices.length = 0; h.levels.length = 0;
    const opaque = { type: 'reasoning', id: 'rs_4111111111111111', encrypted_content: 'person@example.com' };
    const result = await h.emit('before_provider_request', { payload: {
      input: [opaque, { role: 'user', content: VALUE }],
    } });
    assert.deepEqual(result.input[0], opaque);
    assert.equal(result.input[1].content, '[secret:STRIPE_KEY]');
    assert.equal(h.notices.length, 1);
    assert.deepEqual(h.levels, ['info']);
    assert.ok(!JSON.stringify(h.notices).includes(VALUE));
  } finally { h.cleanup(); }
});

test('unreadable privacy settings still mask stored values while cancelling the request', async () => {
  const h = harness({ value: 'opaque-credential-for-fixture', select: 'Every project' });
  try {
    await h.tool('secret_request', { name: 'TOKEN', reason: 'fixture' });
    writeFileSync(join(h.base, 'index/privacy.json'), '{');
    const result = await h.emit('context', { messages: [{ role: 'user', content: 'opaque-credential-for-fixture' }] });
    assert.equal(result.messages[0].content, '[secret:TOKEN]');
    assert.equal(h.aborted.count, 1);
  } finally { h.cleanup(); }
});

test('secret_request stores the typed value and answers with the name only', async () => {
  const h = harness({ value: VALUE, select: 'Only this project' });
  try {
    const result = await h.tool('secret_request', { name: 'STRIPE_KEY', reason: 'Create a test charge' });
    assert.equal(h.keys.map.get('STRIPE_KEY'), VALUE);
    assert.ok(!JSON.stringify(result).includes(VALUE));
    assert.match(text(result as never), /\$STRIPE_KEY/);
    const listed = await h.tool('secret_list', {});
    assert.match(text(listed as never), /Available here[\s\S]*STRIPE_KEY/);
    assert.ok(!JSON.stringify(listed).includes(VALUE.slice(-6)));
    const again = await h.tool('secret_request', { name: 'STRIPE_KEY', reason: 'again' });
    assert.match(text(again as never), /is available/);
  } finally { h.cleanup(); }
});

test('short credentials are stored and hidden from results, messages and commands', async () => {
  for (const length of [4, 6]) {
    const value = String(randomInt(0, 1_000)).padStart(length, '0');
    const h = harness({ value, select: 'Only this project' });
    try {
      const stored = await h.tool('secret_request', { name: 'OTP', reason: 'Verify a received code' });
      assert.equal(h.keys.map.get('OTP'), value);
      assert.ok(!JSON.stringify(stored).includes(value));
      assert.ok(!JSON.stringify(await h.tool('secret_list', {})).includes(value));
      const input = { command: 'printf "%s" "$OTP"' };
      await h.emit('tool_call', { type: 'tool_call', toolName: 'bash', toolCallId: 'otp', input });
      assert.ok(!input.command.includes(value));
      const hidden: unknown = await h.emit('tool_result', {
        type: 'tool_result', toolName: 'bash', toolCallId: 'otp', input,
        content: [{ type: 'text', text: value }], details: undefined, isError: false,
      });
      assert.deepEqual(hidden, { content: [{ type: 'text', text: '[secret:OTP]' }], details: undefined });
      const message: unknown = await h.emit('input', { type: 'input', text: value, source: 'interactive' });
      assert.deepEqual(message, { action: 'transform', text: '[secret:OTP]', images: undefined });
      const context: unknown = await h.emit('context', {
        type: 'context', messages: [{ role: 'user', content: [{ type: 'text', text: value }] }],
      });
      assert.deepEqual(context, { messages: [{ role: 'user', content: [{ type: 'text', text: '[secret:OTP]' }] }] });
    } finally { h.cleanup(); }
  }
});

test('secret_request declined leaves nothing stored and tells the agent not to ask in chat', async () => {
  const h = harness({ value: undefined });
  try {
    const result = await h.tool('secret_request', { name: 'STRIPE_KEY', reason: 'x' });
    assert.equal(h.keys.map.size, 0);
    assert.match(text(result as never), /Do not ask for it in chat/);
  } finally { h.cleanup(); }
});

test('a bash command that mentions a name runs with the value, and its output hides it', async () => {
  const h = harness({ value: VALUE, select: 'Only this project' });
  try {
    await h.tool('secret_request', { name: 'STRIPE_KEY', reason: 'x' });
    const written = 'printf "%s" "$STRIPE_KEY" | wc -c; echo "$STRIPE_KEY"';
    const input = { command: written };
    await h.emit('tool_call', { type: 'tool_call', toolName: 'bash', toolCallId: 't1', input });
    assert.notEqual(input.command, written);
    assert.ok(!input.command.includes(VALUE), 'the command line never carries the value');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(h.cwd, { recursive: true });
    const run = await createBashTool(h.cwd).execute('t1', input);
    assert.ok(text(run as never).includes(VALUE), 'the shell really had the value');
    const patched = await h.emit('tool_result', { type: 'tool_result', toolName: 'bash', toolCallId: 't1', input, content: run.content, details: run.details, isError: false });
    const shown = text(patched);
    assert.match(shown, new RegExp(`\\b${VALUE.length}\\b`));
    assert.match(shown, /\[secret:STRIPE_KEY\]/);
    assert.ok(!shown.includes(VALUE));
    assert.deepEqual(readdirSync(join(h.base, 'tmp', `pi-secrets-${process.getuid!()}`)), []);
  } finally { h.cleanup(); }
});

test('a name not given to this project is withheld and the agent is told why', async () => {
  const h = harness({ value: VALUE, select: 'Only this project' });
  try {
    await h.tool('secret_request', { name: 'STRIPE_KEY', reason: 'x' });
    const elsewhere = join(h.base, 'other');
    const input = { command: 'echo "$STRIPE_KEY"' };
    await h.emit('tool_call', { type: 'tool_call', toolName: 'bash', toolCallId: 't2', input }, elsewhere);
    assert.equal(input.command, 'echo "$STRIPE_KEY"');
    const patched = await h.emit('tool_result', { type: 'tool_result', toolName: 'bash', toolCallId: 't2', input, content: [{ type: 'text', text: '\n' }], details: undefined, isError: false }, elsewhere);
    assert.match(text(patched), /STRIPE_KEY was not set[\s\S]*secret_request/);
    const untouched = { command: 'ls' };
    await h.emit('tool_call', { type: 'tool_call', toolName: 'bash', toolCallId: 't3', input: untouched });
    assert.equal(untouched.command, 'ls');
  } finally { h.cleanup(); }
});

test('the value is hidden from every other tool result and from the model context', async () => {
  const h = harness({ value: VALUE, select: 'Every project' });
  try {
    await h.tool('secret_request', { name: 'STRIPE_KEY', reason: 'x' });
    const read = await h.emit('tool_result', { type: 'tool_result', toolName: 'read', toolCallId: 'r1', input: {}, content: [{ type: 'text', text: `STRIPE=${VALUE}\n` }], details: undefined, isError: false });
    assert.equal(text(read), 'STRIPE=[secret:STRIPE_KEY]\n');
    const context = await h.emit('context', { type: 'context', messages: [{ role: 'user', content: [{ type: 'text', text: `k ${encodeURIComponent(VALUE)}` }] }] });
    assert.equal(context.messages[0].content[0].text, 'k [secret:STRIPE_KEY]');
    const untouched = await h.emit('tool_result', { type: 'tool_result', toolName: 'read', toolCallId: 'r2', input: {}, content: [{ type: 'text', text: 'clean' }], details: {}, isError: false });
    assert.equal(untouched, undefined);
  } finally { h.cleanup(); }
});

test('a stored value typed into the chat is replaced before it is sent', async () => {
  const h = harness({ value: VALUE, select: 'Every project' });
  try {
    await h.tool('secret_request', { name: 'STRIPE_KEY', reason: 'x' });
    const result = await h.emit('input', { type: 'input', text: `use ${VALUE}`, source: 'interactive' });
    assert.deepEqual({ action: result.action, text: result.text }, { action: 'transform', text: 'use [secret:STRIPE_KEY]' });
  } finally { h.cleanup(); }
});

test('a new credential pasted into the chat is offered to the keychain', async () => {
  const token = 'ghp_' + 'Ab1'.repeat(12);
  const h = harness({ confirm: true, input: '', select: 'Only this project' });
  try {
    await h.command('privacy ask');
    const result = await h.emit('input', { type: 'input', text: `push with ${token}`, source: 'interactive' });
    assert.equal(h.keys.map.get('GITHUB_TOKEN'), token);
    assert.equal(result.text, 'push with [secret:GITHUB_TOKEN]');
  } finally { h.cleanup(); }
});

test('declining storage is not consent to send a credential', async () => {
  const token = 'ghp_' + 'Ab1'.repeat(12);
  const h = harness({ confirm: false });
  try {
    await h.command('privacy ask');
    const result = await h.emit('input', { type: 'input', text: `push with ${token}`, source: 'interactive' });
    assert.equal(result.action, 'handled');
    assert.equal(h.keys.map.size, 0);
  } finally { h.cleanup(); }
});

test('/secret remove deletes from the keychain after a confirmation', async () => {
  const h = harness({ value: VALUE, select: 'Every project', confirm: true });
  try {
    await h.command('set STRIPE_KEY Stripe test mode');
    assert.equal(h.keys.map.get('STRIPE_KEY'), VALUE);
    assert.ok(h.notices.some(notice => notice.includes('••••KlMnOp')));
    await h.command('remove STRIPE_KEY');
    assert.equal(h.keys.map.size, 0);
    // A value deleted mid-session stays hidden: earlier output may still carry it.
    const read = await h.emit('tool_result', { type: 'tool_result', toolName: 'read', toolCallId: 'r', input: {}, content: [{ type: 'text', text: VALUE }], details: undefined, isError: false });
    assert.equal(text(read), '[secret:STRIPE_KEY]');
  } finally { h.cleanup(); }
});

test('the person\'s ! commands get the value and see it hidden', async () => {
  const h = harness({ value: VALUE, select: 'Every project' });
  try {
    await h.tool('secret_request', { name: 'STRIPE_KEY', reason: 'x' });
    const { mkdirSync } = await import('node:fs');
    mkdirSync(h.cwd, { recursive: true });
    const result = await h.emit('user_bash', { type: 'user_bash', command: 'echo "$STRIPE_KEY"', excludeFromContext: false, cwd: h.cwd });
    const chunks: Buffer[] = [];
    const exit = await result.operations.exec('echo "$STRIPE_KEY"', h.cwd, { onData: (chunk: Buffer) => chunks.push(chunk) });
    assert.equal(exit.exitCode, 0);
    assert.equal(Buffer.concat(chunks).toString('utf8').trim(), '[secret:STRIPE_KEY]');
  } finally { h.cleanup(); }
});

test('the panel shows names with the last six characters and nothing more', async () => {
  const { secretPanelSpec } = await import('../src/panel.ts');
  const entry = { name: 'STRIPE_KEY', scope: 'all' as const, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  const spec = secretPanelSpec({
    entries: () => [entry], value: () => VALUE, cwd: '/tmp', project: '/tmp',
    remove: async () => {}, rescope: () => {}, request: () => {},
  });
  const [item] = spec.items();
  assert.equal(item!.meta, '••••KlMnOp');
  const rendered = JSON.stringify([spec.items(), spec.detail(item!)]);
  assert.ok(!rendered.includes(VALUE.slice(0, -6)));
  assert.deepEqual(spec.actions!.filter(action => !action.when || action.when(item)).map(action => action.key), ['n', 'r', 'g', 'x']);
});

test('PII input offers masked previews and explicit value or session choices', async () => {
  for (const choice of PRIVACY_CHOICES) {
    const h = harness({ select: choice });
    const email = 'person@example.com';
    try {
    await h.command('privacy ask');
      const result = await h.emit('input', { type: 'input', text: `Contact ${email}`, source: 'interactive' });
      const masks = choice === PRIVACY_CHOICES[0] || choice === PRIVACY_CHOICES[3];
      assert.equal(result.action, masks ? 'transform' : choice === PRIVACY_CHOICES[1] ? 'continue' : 'handled');
      if (masks) assert.equal(result.text, 'Contact p**********@****.com');
      assert.ok(h.prompts.some(prompt => prompt.includes('p**********@****.com')));
      assert.ok(!JSON.stringify(h.prompts).includes(email));
    } finally { h.cleanup(); }
  }
});

test('tool output, restored system context and provider payload require consent', async () => {
  for (const event of ['context', 'context_with_system', 'before_provider_request']) {
    const h = harness({ select: PRIVACY_CHOICES[0] });
    try {
    await h.command('privacy ask');
      const messages = [{ role: 'toolResult', content: [{ type: 'text', text: 'person@example.com' }] }];
      const result = await h.emit(event, event === 'before_provider_request' ? { payload: { messages } } : { messages });
      assert.ok(!JSON.stringify(result).includes('person@example.com'));
      assert.ok(JSON.stringify(result).includes('p**********@****.com'));
    } finally { h.cleanup(); }
  }
});

test('cancel during outbound context aborts and never returns the raw data', async () => {
  const h = harness();
  try {
    await h.command('privacy ask');
    const result = await h.emit('context', { messages: [{ role: 'user', content: 'person@example.com' }] });
    assert.equal(h.aborted.count, 1);
    assert.ok(!JSON.stringify(result).includes('person@example.com'));
  } finally { h.cleanup(); }
});

test('consent persists only for the same destination and session', async () => {
  const h = harness({ select: PRIVACY_CHOICES[1] });
  const event = { messages: [{ role: 'user', content: 'person@example.com' }] };
  try {
    await h.command('privacy ask');
    await h.emit('context', event);
    await h.emit('context', event);
    assert.equal(h.prompts.length, 1);
    h.ctx.model.provider = 'different-provider';
    await h.emit('context', event);
    assert.equal(h.prompts.length, 2);
    await h.emit('session_before_switch', {});
    await h.emit('context', event);
    assert.equal(h.prompts.length, 2, 'a cancelled switch must not erase consent');
    h.ctx.sessionManager.newSession();
    await h.emit('session_start', {});
    await h.emit('context', event);
    assert.equal(h.prompts.length, 3);
  } finally { h.cleanup(); }
});

test('headless and RPC requests obfuscate without a confirmation dialog', async () => {
  const h = harness({ select: PRIVACY_CHOICES[1] });
  try {
    h.ctx.mode = 'rpc';
    const result = await h.emit('input', { text: 'person@example.com', source: 'rpc' });
    assert.equal(result.text, 'p**********@****.com');
    assert.equal(h.prompts.length, 0);
    assert.ok(h.notices.includes('Secrets obfuscated before sending to the model: 1 email.'), JSON.stringify(h.notices));
  } finally { h.cleanup(); }
});

test('consent survives all outbound hooks and an extension reload through SDK session entries', async () => {
  const h = harness({ select: PRIVACY_CHOICES[1] });
  const messages = [{ role: 'user', content: 'person@example.com' }];
  try {
    await h.command('privacy ask');
    const previousEntries = h.ctx.sessionManager.getBranch().length;
    await h.emit('input', { text: 'person@example.com', source: 'interactive' });
    for (const event of ['context', 'context_with_system', 'before_provider_request']) {
      await h.emit(event, event === 'before_provider_request' ? { payload: { messages } } : { messages });
    }
    assert.equal(h.prompts.length, 1);
    const entries = h.ctx.sessionManager.getBranch().filter(entry => entry.type === 'custom' && entry.customType === 'pi-secrets-privacy');
    assert.equal(entries.length, previousEntries + 1);
    assert.ok(!JSON.stringify(entries).includes('person@example.com'));
    h.reload();
    await h.emit('session_start', {});
    const result = await h.emit('context', { messages });
    assert.deepEqual(result.messages, messages);
    assert.equal(h.prompts.length, 1, 'reload restores the choice rather than asking again');
    h.ctx.model.baseUrl = 'https://another-endpoint.invalid';
    await h.emit('context', { messages });
    assert.equal(h.prompts.length, 2, 'another endpoint still needs consent');
    await h.command('privacy reset');
    await h.emit('context', { messages });
    assert.equal(h.prompts.length, 3, 'the user can revoke stored choices');
  } finally { h.cleanup(); }
});

test('automatic session masking survives reload and does not authorize another session', async () => {
  const h = harness({ select: PRIVACY_CHOICES[3] });
  try {
    await h.command('privacy ask');
    await h.emit('input', { text: 'first@example.com', source: 'interactive' });
    h.reload();
    await h.emit('session_start', {});
    const result = await h.emit('input', { text: 'second@example.com', source: 'interactive' });
    assert.equal(result.text, 's**********@****.com');
    assert.equal(h.prompts.length, 1);
    h.ctx.sessionManager.newSession();
    await h.emit('session_start', {});
    await h.emit('input', { text: 'second@example.com', source: 'interactive' });
    assert.equal(h.prompts.length, 2);
  } finally { h.cleanup(); }
});

test('persistent automatic mode masks new data concurrently across reloads, sessions and destinations with no dialogs and native info', async () => {
  const h = harness({ select: PRIVACY_CHOICES[1] });
  try {
    await h.command('privacy ask');
    await h.emit('input', { text: 'person@example.com', source: 'interactive' });
    await h.command('privacy always');
    h.prompts.length = 0; h.notices.length = 0;
    const results = await Promise.all(Array.from({ length: 50 }, (_, i) =>
      h.emit('input', { text: `person${i}@example.com ${VALUE}`, source: 'interactive' })));
    assert.ok(results.every(result => result.action === 'transform' && !result.text.includes('@example.com') && !result.text.includes(VALUE)));
    assert.equal(h.keys.map.size, 0, 'automatic mode does not offer to store pasted credentials');
    h.reload();
    h.ctx.sessionManager.newSession();
    h.ctx.model = { provider: 'other', id: 'other', baseUrl: 'https://other.invalid' };
    await h.emit('session_start', {});
    for (const event of ['context', 'context_with_system', 'before_provider_request']) {
      const messages = [{ role: 'user', content: 'person@example.com different@example.com' }];
      const result = await h.emit(event, event === 'before_provider_request' ? { payload: { messages } } : { messages }, join(h.base, 'another-project'));
      assert.ok(!JSON.stringify(result).includes('@example.com'));
    }
    await h.command('privacy reset');
    h.notices.length = 0;
    await h.emit('input', { text: 'after-reset@example.com', source: 'interactive' });
    assert.deepEqual(h.prompts, []);
    assert.ok(h.notices.length <= 1, 'at most one masking info per run');
    const config = join(h.base, 'index', 'privacy.json');
    assert.deepEqual(JSON.parse(readFileSync(config, 'utf8')), { version: 1, mode: 'always' });
    assert.equal(statSync(config).mode & 0o777, 0o600);
    assert.equal(h.aborted.count, 0);
  } finally { h.cleanup(); }
});

test('the TUI can enable and disable persistent masking, including an earlier automatic session choice', async () => {
  const ui = { select: PRIVACY_CHOICES[3] as string };
  const h = harness(ui);
  try {
    await h.command('privacy ask');
    await h.emit('input', { text: 'person@example.com', source: 'interactive' });
    ui.select = PRIVACY_MODES.always;
    await h.command('privacy');
    h.reload();
    const before = h.prompts.length;
    await h.emit('input', { text: 'person@example.com', source: 'interactive' });
    assert.equal(h.prompts.length, before);
    ui.select = PRIVACY_MODES.ask;
    await h.command('privacy');
    ui.select = PRIVACY_CHOICES[1];
    const result = await h.emit('input', { text: 'person@example.com', source: 'interactive' });
    assert.equal(result.action, 'continue');
    assert.equal(h.prompts.length, before + 2, 'settings selection and renewed consent');
    assert.equal(JSON.parse(readFileSync(join(h.base, 'index/privacy.json'), 'utf8')).mode, 'ask');
  } finally { h.cleanup(); }
});

test('Secrets exposes privacy settings through a visible row, Enter and p even with an empty vault', async () => {
  const { secretPanelSpec } = await import('../src/panel.ts');
  const { createPanel } = await import('@prjct.app/pi-tui-kit');
  const { visibleWidth } = await import('@earendil-works/pi-tui');
  const requests: unknown[] = [];
  const closed = { count: 0 };
  const spec = secretPanelSpec({
    entries: () => [], value: () => undefined, cwd: '/tmp', project: '/tmp',
    remove: async () => {}, rescope: () => {}, request: intent => requests.push(intent), privacyMode: () => 'always',
  });
  const row = spec.items()[0]!;
  assert.equal(row.id, '__privacy__');
  assert.match(spec.detail(row).subtitle!, /Ofuscar siempre/);
  assert.ok(spec.activate?.when?.(row));
  for (const [key, width] of [['\r', 120], ['p', 60]] as const) {
    const panel = createPanel(spec, { terminal: { rows: 30, columns: width }, requestRender() {} } as never,
      { fg: (_tone: string, text: string) => text, bold: (text: string) => text } as never, () => { closed.count++; });
    try {
      const lines = panel.render(width);
      assert.match(lines.join('\n'), /Privacy/);
      assert.ok(lines.every(line => visibleWidth(line) <= width), 'privacy settings fit a narrow terminal');
      panel.handleInput!(key);
      await new Promise(resolve => setImmediate(resolve));
    } finally { panel.dispose(); }
  }
  assert.equal(closed.count, 2);
  assert.deepEqual(requests, [{ action: 'privacy' }, { action: 'privacy' }]);
});

test('consent to PII never reveals stored credentials and notices contain no raw PII', async () => {
  const ui = { value: VALUE, select: 'Every project' };
  const h = harness(ui);
  try {
    await h.command('privacy ask');
    await h.tool('secret_request', { name: 'STRIPE_KEY', reason: 'x' });
    ui.select = PRIVACY_CHOICES[1];
    const result = await h.emit('input', { text: `${VALUE} person@example.com`, source: 'interactive' });
    assert.equal(result.text, '[secret:STRIPE_KEY] person@example.com');
    assert.ok(!JSON.stringify([...h.prompts, ...h.notices]).includes('person@example.com'));
    assert.ok(!JSON.stringify([...h.prompts, ...h.notices]).includes(VALUE));
  } finally { h.cleanup(); }
});

test('a failed consent dialog cancels instead of failing open', async () => {
  const h = harness();
  try {
    await h.command('privacy ask');
    h.ctx.ui.select = async () => { throw new Error('UI disconnected'); };
    const input = await h.emit('input', { text: 'person@example.com', source: 'interactive' });
    assert.equal(input.action, 'handled');
    const result = await h.emit('context', { messages: [{ role: 'user', content: 'person@example.com' }] });
    assert.equal(h.aborted.count, 1);
    assert.ok(!JSON.stringify(result).includes('person@example.com'));
  } finally { h.cleanup(); }
});
