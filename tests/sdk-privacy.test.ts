import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { PRIVACY_CHOICES } from '../src/privacy.ts';

test('real SDK HTTP boundary: mask, explicit send, input cancel, context cancel and RPC', async () => {
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
      { choice: PRIVACY_CHOICES[0], prompt: 'person@example.com', sent: true, original: false, mode: 'tui' },
      { choice: PRIVACY_CHOICES[1], prompt: 'person@example.com', sent: true, original: true, mode: 'tui' },
      { choice: undefined, prompt: 'person@example.com', sent: false, original: false, mode: 'tui' },
      { choice: undefined, prompt: 'context fixture', sent: false, original: false, mode: 'tui' },
      { choice: PRIVACY_CHOICES[0], prompt: 'context fixture', sent: true, original: false, mode: 'tui' },
      { choice: PRIVACY_CHOICES[1], prompt: 'person@example.com', sent: true, original: false, mode: 'rpc' },
    ] as const) {
      wire.length = 0;
      const settings = SettingsManager.inMemory({ packages: [], extensions: ['-builtin:mcp'], compaction: { enabled: false }, cacheWarming: 'off' });
      const loader = new DefaultResourceLoader({ cwd: base, agentDir: base, settingsManager: settings, noContextFiles: true, noSkills: true, noThemes: true, noPromptTemplates: true, additionalExtensionPaths: [extension] });
      await loader.reload();
      assert.deepEqual(loader.getExtensions().errors, []);
      const runtime = await ModelRuntime.create({ authPath: join(base, 'auth.json'), modelsPath: join(base, 'models.json'), allowModelNetwork: false });
      const { session } = await createAgentSession({ cwd: base, agentDir: base, settingsManager: settings, resourceLoader: loader, modelRuntime: runtime, sessionManager: SessionManager.inMemory(base) });
      const errors: unknown[] = [];
      const prompts: string[] = [];
      try {
        await session.bindExtensions({ mode: scenario.mode, onError: error => errors.push(error), uiContext: {
          select: async (title: string) => { prompts.push(title); return scenario.choice; }, confirm: async () => false,
          notify() {}, setStatus() {}, setWidget() {}, setWorkingMessage() {},
        } as never });
        const model = runtime.getModel('privacy-fixture', 'offline');
        assert.ok(model);
        await session.setModel(model);
        await session.prompt(scenario.prompt, { source: scenario.mode === 'tui' ? 'interactive' : 'rpc' });
        assert.deepEqual(errors, []);
        assert.equal(wire.length > 0, scenario.sent, JSON.stringify(scenario));
        if (scenario.sent) {
          assert.deepEqual(JSON.parse(wire[0]!).audit_protocol, protocol);
          assert.equal(wire[0]!.includes('person@example.com'), scenario.original);
          if (!scenario.original) assert.ok(wire[0]!.includes('p**********@****.com'));
        }
        assert.ok(!prompts.join('').includes('person@example.com'));
        if (scenario.mode === 'rpc') assert.equal(prompts.length, 0);
      } finally { await session.abort(); session.dispose(); }
    }
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(base, { recursive: true, force: true });
  }
});
