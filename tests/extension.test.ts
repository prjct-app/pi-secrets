import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createBashTool, type ExtensionAPI, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import { installSecrets } from '../src/index.ts';
import { memoryKeys } from './keys.ts';

const VALUE = 'sk_test_51HxYzAbCdEfGhIjKlMnOp';
type Handler = (event: any, ctx: any) => any;

function harness(ui: { value?: string; select?: string; confirm?: boolean; input?: string } = {}) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'pi-secrets-ext-')));
  const cwd = join(base, 'project');
  const keys = memoryKeys();
  const handlers = new Map<string, Handler[]>();
  const tools = new Map<string, ToolDefinition>();
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
  const notices: string[] = [];
  const prompts: string[] = [];
  const editor: string[] = [];
  const ctx = {
    cwd, mode: 'tui', hasUI: true,
    ui: {
      notify: (text: string) => notices.push(text),
      select: async (title: string) => { prompts.push(title); return ui.select; },
      confirm: async (title: string) => { prompts.push(title); return ui.confirm ?? false; },
      input: async (title: string) => { prompts.push(title); return ui.input; },
      custom: async () => ui.value,
      setEditorText: (text: string) => editor.push(text),
    },
  };
  const pi = {
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
    base, cwd, keys, notices, prompts, editor, ctx, emit,
    tool: (name: string, params: unknown) => tools.get(name)!.execute('call', params as never, undefined, undefined, ctx as never),
    command: (text: string) => commands.get('secret')!.handler(text, ctx),
    tools,
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
}

const text = (result: { content: { type: string; text?: string }[] }): string =>
  result.content.map(part => part.text ?? '').join('');

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
    const result = await h.emit('input', { type: 'input', text: `push with ${token}`, source: 'interactive' });
    assert.equal(h.keys.map.get('GITHUB_TOKEN'), token);
    assert.equal(result.text, 'push with [secret:GITHUB_TOKEN]');
  } finally { h.cleanup(); }
});

test('declining the offer sends the message unchanged', async () => {
  const token = 'ghp_' + 'Ab1'.repeat(12);
  const h = harness({ confirm: false });
  try {
    const result = await h.emit('input', { type: 'input', text: `push with ${token}`, source: 'interactive' });
    assert.equal(result.action, 'continue');
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
