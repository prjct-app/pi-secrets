import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { PRIVACY_CHOICES } from '../src/privacy.ts';

test('real SDK HTTP boundary: consent, cancellation, RPC and reload without repeated dialogs', async () => {
  const wire: string[] = [];
  const protocol = { type: 'reasoning', id: 'rs_04f9f4111111111111111b535', encrypted_content: 'ciphertext-must-remain-exact' };
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    wire.push(Buffer.concat(chunks).toString());
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.end('data: {"id":"offline","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"done"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  const base = await mkdtemp(join(tmpdir(), 'pi-privacy-sdk-'));
  const extension = join(base, 'fixture.ts');
  await writeFile(extension, `
import { installSecrets } from ${JSON.stringify(resolve('src/index.ts'))};
export default function(pi) {
  pi.on('before_provider_request', event => ({ ...event.payload, audit_protocol: ${JSON.stringify(protocol)} }));
  installSecrets(pi, { root: ${JSON.stringify(join(base, 'vault'))}, keys: { get: async () => undefined, set: async () => {}, delete: async () => {} } });
  pi.registerProvider('privacy-fixture', { baseUrl: 'http://127.0.0.1:${address.port}/v1', apiKey: 'fixture-only', api: 'openai-completions',
    models: [{ id: 'offline', name: 'Offline privacy fixture', reasoning: false, input: ['text'], contextWindow: 32000, maxTokens: 64,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] });
  pi.on('before_agent_start', event => event.prompt === 'context fixture' ? { message: { customType: 'privacy-fixture', content: 'person@example.com', display: false } } : undefined);
}`);
  try {
    for (const scenario of [
      { choice: undefined, prompt: 'person@example.com', sent: true, original: false, mode: 'tui', default: true },
      { choice: undefined, prompt: 'context fixture', sent: true, original: false, mode: 'tui', default: true },
      { choice: undefined, prompt: 'person@example.com', sent: true, original: false, mode: 'rpc', default: true },
      { choice: PRIVACY_CHOICES[0], prompt: 'person@example.com', sent: true, original: false, mode: 'tui' },
      { choice: PRIVACY_CHOICES[1], prompt: 'person@example.com', sent: true, original: true, mode: 'tui' },
      { choice: PRIVACY_CHOICES[3], prompt: 'person@example.com', sent: true, original: false, mode: 'tui' },
      { choice: undefined, prompt: 'person@example.com', sent: false, original: false, mode: 'tui' },
      { choice: undefined, prompt: 'context fixture', sent: false, original: false, mode: 'tui' },
      { choice: PRIVACY_CHOICES[0], prompt: 'context fixture', sent: true, original: false, mode: 'tui' },
      { choice: PRIVACY_CHOICES[1], prompt: 'person@example.com', sent: true, original: false, mode: 'rpc' },
      { choice: undefined, prompt: 'person@example.com', sent: true, original: false, mode: 'tui', persistent: true },
    ] as const) {
      wire.length = 0;
      await rm(join(base, 'vault', 'privacy.json'), { force: true });
      const settings = SettingsManager.inMemory({ packages: [], extensions: ['-builtin:mcp'], compaction: { enabled: false }, cacheWarming: 'off' });
      const loader = new DefaultResourceLoader({ cwd: base, agentDir: base, settingsManager: settings, noContextFiles: true, noSkills: true, noThemes: true, noPromptTemplates: true, additionalExtensionPaths: [extension] });
      await loader.reload();
      assert.deepEqual(loader.getExtensions().errors, []);
      const runtime = await ModelRuntime.create({ authPath: join(base, 'auth.json'), modelsPath: join(base, 'models.json'), allowModelNetwork: false });
      const { session } = await createAgentSession({ cwd: base, agentDir: base, settingsManager: settings, resourceLoader: loader, modelRuntime: runtime, sessionManager: SessionManager.inMemory(base) });
      const errors: unknown[] = [];
      const recordError = (error: unknown): void => { errors.push(error); };
      const prompts: string[] = [];
      const notices: { message: string; type: string }[] = [];
      try {
        await session.bindExtensions({ mode: scenario.mode, onError: recordError, uiContext: {
          select: async (title: string) => { prompts.push(title); return scenario.choice; }, confirm: async () => false,
          notify: (message: string, type: string) => notices.push({ message, type }), setStatus() {}, setWidget() {}, setWorkingMessage() {},
        } as never });
        const model = runtime.getModel('privacy-fixture', 'offline');
        assert.ok(model);
        await session.setModel(model);
        const persistent = 'persistent' in scenario;
        const automatic = persistent || 'default' in scenario;
        if (persistent) await session.prompt('/secret privacy always');
        else if (!automatic) await session.prompt('/secret privacy ask');
        notices.length = 0;
        await session.prompt(scenario.prompt, { source: scenario.mode === 'tui' ? 'interactive' : 'rpc' });
        assert.deepEqual(errors, []);
        assert.equal(wire.length > 0, scenario.sent, JSON.stringify(scenario));
        if (scenario.sent) {
          assert.deepEqual(JSON.parse(wire[0]!).audit_protocol, protocol);
          assert.equal(wire[0]!.includes('person@example.com'), scenario.original);
          if (!scenario.original) assert.ok(wire[0]!.includes('p**********@****.com'));
          const asked = prompts.length;
          assert.equal(asked, scenario.mode === 'tui' && !automatic ? 1 : 0);
          if (automatic) {
            assert.equal(notices.length, 1, 'one native info for a send, across every SDK hook');
            assert.equal(notices[0]!.type, 'info');
            assert.match(notices[0]!.message, /ofuscados/i);
            assert.ok(!wire[0]!.includes(notices[0]!.message), 'native info never reaches the model');
            assert.ok(!JSON.stringify(session.sessionManager.getBranch()).includes(notices[0]!.message), 'native info never becomes a session message');
          }
          await session.reload();
          await session.prompt(scenario.prompt, { source: scenario.mode === 'tui' ? 'interactive' : 'rpc' });
          assert.equal(wire.length, 2);
          assert.equal(prompts.length, asked, 'reload and repeated provider hooks preserve the choice');
          assert.equal(wire[1]!.includes('person@example.com'), scenario.original);
          assert.deepEqual(JSON.parse(wire[1]!).audit_protocol, protocol);
          assert.ok(!wire[1]!.includes('pi-secrets-privacy'), 'consent entries are local state, not model context');
          if (automatic) assert.equal(notices.length, 2, 'the next send receives its own info after reload');
          if ('default' in scenario) {
            await session.prompt('next@example.com', { source: scenario.mode === 'tui' ? 'interactive' : 'rpc' });
            assert.equal(prompts.length, 0);
            assert.equal(notices.length, 3, 'SDK settlement resets the info without needing a reload');
            assert.ok(!wire[2]!.includes('next@example.com'));
          }
          if (scenario.choice === PRIVACY_CHOICES[3]) {
            await session.prompt('different@example.com', { source: 'interactive' });
            assert.equal(prompts.length, 1, 'the selected session policy handles new values without another prompt');
            assert.ok(!wire[2]!.includes('different@example.com'));
            assert.ok(wire[2]!.includes('d**********@****.com'));
          }
          if (persistent) {
            await loader.reload();
            const { session: fresh } = await createAgentSession({ cwd: base, agentDir: base, settingsManager: settings, resourceLoader: loader, modelRuntime: runtime, sessionManager: SessionManager.inMemory(base) });
            try {
              await fresh.bindExtensions({ mode: 'tui', onError: recordError, uiContext: {
                select: async (title: string) => { prompts.push(title); return undefined; },
                confirm: async () => { assert.fail('automatic mode must not offer credential storage'); },
                notify() {}, setStatus() {}, setWidget() {}, setWorkingMessage() {},
              } as never });
              await fresh.setModel(model);
              await fresh.prompt('different@example.com', { source: 'interactive' });
              assert.equal(prompts.length, 0, 'persistent mode needs no consent after reload or a new session');
              assert.ok(!wire[2]!.includes('different@example.com'));
              assert.ok(wire[2]!.includes('d**********@****.com'));
              await fresh.prompt('/secret privacy ask');
              const before = wire.length;
              await fresh.prompt('another@example.com', { source: 'interactive' });
              assert.equal(prompts.length, 1, 'turning automatic mode off restores consent');
              assert.equal(wire.length, before, 'dismissing renewed consent sends nothing');
            } finally { await fresh.abort(); fresh.dispose(); }
          }
        }
        assert.ok(!prompts.join('').includes('person@example.com'));
        if (scenario.mode === 'rpc') assert.equal(prompts.length, 0);
        assert.deepEqual(errors, []);
      } finally { await session.abort(); session.dispose(); }
    }
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(base, { recursive: true, force: true });
  }
});
