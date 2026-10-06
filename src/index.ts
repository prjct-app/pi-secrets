import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { createLocalBashOperations, isToolCallEventType } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { brand, completer, openPanel, openSecretPrompt, panelText, type CommandOption, repairToolArgs } from '@prjct.app/pi-tui-kit';
import { sight } from './detect.ts';
import { discard, envFile, privateDir, sweep } from './inject.ts';
import { NAME_RULE, mentions, tail, toName, validName, valueProblem } from './names.ts';
import { secretPanelSpec, scopeText, type SecretIntent } from './panel.ts';
import { createRedactor, createStreamRedactor, marker, type Known, type Redactor } from './redact.ts';
import { createVault, inScope, projectOf, type Entry, type KeyStore, type Scope } from './vault.ts';
import { createPrivacyGuard, maskSensitiveData } from './privacy.ts';

export type InstallSecretsOptions = {
  /** Index folder; defaults to ${PRJCT_HOME:-~/.prjct}/pi-secrets. */
  readonly root?: string;
  /** Where values live; defaults to the OS keychain. */
  readonly keys?: KeyStore;
  /** Folder for the one-shot environment files; defaults to the OS temp folder. */
  readonly tmp?: string;
  readonly now?: () => Date;
};

type Pending = { readonly file?: string; readonly withheld: readonly string[] };
type Slot = {
  /** Index mtime the values were loaded at; another terminal's change moves it. */
  readonly stamp: number;
  readonly values: ReadonlyMap<string, string>;
  /** Values replaced or deleted while this process ran: still hidden, since old output may carry them. */
  readonly retired: readonly Known[];
  readonly redactor: Redactor;
  readonly pending: ReadonlyMap<string, Pending>;
  readonly files: ReadonlySet<string>;
};

/** Names a secret must not take: overriding them would break every command. */
const RESERVED = new Set(['PATH', 'HOME', 'SHELL', 'USER', 'LOGNAME', 'PWD', 'OLDPWD', 'IFS', 'PS1', 'PS2', 'TERM', 'LANG', 'TMPDIR', 'SHLVL', 'HOSTNAME']);
const nameProblem = (name: string): string | undefined =>
  !validName(name) ? `${name || 'That'} is not a valid name. ${NAME_RULE}`
    : RESERVED.has(name) || name.startsWith('PI_') ? `${name} is reserved by the shell or Pi; pick another name.`
      : undefined;

const SCOPE_HERE = 'Only this project';
const SCOPE_ALL = 'Every project';
const HELP = [
  '/secret                      manage stored secrets (replace, delete, scope, last 6 characters)',
  '/secret set NAME [about]     store or replace a secret; the value is typed into a masked prompt',
  '/secret remove NAME          delete a secret from the keychain',
  '/secret list                 names and where each one is available',
].join('\n');

export function installSecrets(pi: ExtensionAPI, options: InstallSecretsOptions = {}): void {
  repairToolArgs(pi);
  const vault = createVault({ root: options.root, keys: options.keys, now: options.now });
  const privacy = createPrivacyGuard();
  const availability = { blocked: false };
  const protect = async <T>(value: T, ctx: ExtensionContext, interactive = ctx.hasUI && ctx.mode === 'tui') => {
    if (availability.blocked) {
      ctx.ui.notify('Sending blocked: unlock the keychain to restore secret protection.', 'error');
      return { value: maskSensitiveData(value), cancelled: true, changed: true };
    }
    const origin = (() => { try { return new URL(ctx.model?.baseUrl ?? '').origin; } catch { return 'configured endpoint'; } })();
    try { return await privacy.inspect(value, {
    destination: ctx.model ? `${ctx.model.provider}/${ctx.model.id} (${origin})` : 'selected model',
    interactive,
    choose: (preview, choices) => ctx.ui.select(preview, [...choices], { signal: ctx.signal }),
    notify: message => ctx.ui.notify(message, 'warning'),
    }); } catch {
      ctx.ui.notify('Sending cancelled: privacy confirmation could not be completed.', 'error');
      return { value: maskSensitiveData(value), cancelled: true, changed: true };
    }
  };
  pi.on('session_start', async () => { privacy.reset(); });
  pi.on('session_before_switch', async () => { privacy.reset(); });
  pi.on('session_shutdown', async () => { privacy.reset(); });
  const cell = {
    value: {
      stamp: -1, values: new Map(), retired: [], redactor: createRedactor([]), pending: new Map(), files: new Set(),
    } as Slot,
  };
  const store = { get: (): Slot => cell.value, set: (next: (current: Slot) => Slot): void => { cell.value = next(cell.value); } };
  const serial = { value: Promise.resolve() as Promise<unknown> };
  const queue = <T>(action: () => Promise<T>): Promise<T> => {
    const next = serial.value.then(action); serial.value = next.catch(() => {}); return next;
  };
  const tmp = (): string => privateDir(options.tmp);

  const known = (slot: Pick<Slot, 'values' | 'retired'>): Known[] =>
    [...[...slot.values].map(([name, value]) => ({ name, value })), ...slot.retired];

  /** Loads every stored value once per index change, so any of them can be hidden in any output. */
  const refresh = (force = false): Promise<void> => queue(async () => {
    const stamp = vault.stamp();
    if (!force && !availability.blocked && stamp === store.get().stamp) return;
    availability.blocked = false;
    const loaded = await Promise.all(vault.list().map(async entry => {
      try { return [entry.name, await vault.value(entry.name)] as const; } catch { availability.blocked = true; return [entry.name, undefined] as const; }
    }));
    const values = new Map(loaded.filter((pair): pair is readonly [string, string] => typeof pair[1] === 'string'));
    store.set(slot => {
      const gone = [...slot.values].filter(([name, value]) => values.get(name) !== value).map(([name, value]) => ({ name, value }));
      const retired = [...slot.retired, ...gone];
      return { ...slot, stamp, values, retired, redactor: createRedactor(known({ values, retired })) };
    });
  });

  const redact = (text: string): string => store.get().redactor.text(text);

  const put = async (name: string, value: string, scope: Scope, description?: string): Promise<Entry> => {
    const entry = await vault.put(name, value, { scope, description });
    await refresh(true);
    return entry;
  };
  const remove = async (name: string): Promise<void> => {
    await vault.remove(name);
    await refresh(true);
  };
  const rescope = (name: string, scope: Scope): void => { vault.rescope(name, scope); };

  const chooseScope = async (ctx: ExtensionContext, name: string): Promise<Scope | undefined> => {
    const choice = await ctx.ui.select(`Where may agents use ${name}?`, [SCOPE_HERE, SCOPE_ALL]);
    return choice === SCOPE_ALL ? 'all' : choice === SCOPE_HERE ? [projectOf(ctx.cwd)] : undefined;
  };

  /** The masked prompt: the value goes from the keyboard to the keychain and nowhere else. */
  const askValue = (ctx: ExtensionContext, name: string, message: string): Promise<string | undefined> =>
    openSecretPrompt(ctx, {
      title: `Secret ${name}`,
      message,
      label: name,
      placeholder: 'paste the value',
      validate: value => valueProblem(value),
    });

  const describe = (entry: Entry): string =>
    `given to ${scopeText(entry)} · stored in the OS keychain · ${tail(store.get().values.get(entry.name) ?? '')}`;

  // ── Agent tools ─────────────────────────────────────────────────────────────

  pi.registerTool({
    name: 'secret_list',
    label: 'Secrets',
    description: 'List the secrets (API keys, tokens, passwords) the person stored for agents, by name only. '
      + 'A bash command that mentions a name gets it as an environment variable: write "$NAME", never the value.',
    promptSnippet: 'List stored credentials by name; use them as $NAME in bash',
    parameters: Type.Object({}, { additionalProperties: false }),
    execute: async (_id, _input, _signal, _update, ctx) => {
      await refresh();
      const entries = vault.list();
      const here = entries.filter(entry => inScope(entry, ctx.cwd));
      const elsewhere = entries.filter(entry => !inScope(entry, ctx.cwd));
      const line = (entry: Entry): string => `${entry.name}${entry.description ? ` — ${entry.description}` : ''}`;
      const text = [
        here.length ? `Available here (use as $NAME in bash):\n${here.map(line).join('\n')}` : 'No secret is available in this project.',
        ...(elsewhere.length ? [`Stored but not given to this project (secret_request asks the person to allow one):\n${elsewhere.map(entry => entry.name).join(', ')}`] : []),
      ].join('\n\n');
      return { content: [{ type: 'text', text }], details: {} };
    },
  });

  pi.registerTool({
    name: 'secret_request',
    label: 'Request a secret',
    description: 'Ask the person for a credential (API key, token, password) through a masked prompt in their terminal. '
      + 'The value goes to the OS keychain and you only ever receive its name; then use it as $NAME in bash. '
      + 'If the secret is stored but not given to this project, this asks the person to allow it here.',
    promptSnippet: 'Ask the person for a credential through a masked prompt; you get only its name',
    promptGuidelines: [
      'When a task needs an API key, token, password or other credential, check secret_list and call secret_request for any that is missing. Never ask for a credential in chat, and never ask the person to paste one.',
      'Use a secret only as $NAME inside a bash command, for example curl -H "Authorization: Bearer $NAME". Never print, echo or log it, and never write it into a tracked file. Outputs show [secret:NAME] in place of the value.',
    ],
    parameters: Type.Object({
      name: Type.String({ minLength: 1, maxLength: 64, description: 'Environment variable name, for example STRIPE_SECRET_KEY.' }),
      reason: Type.String({ minLength: 1, maxLength: 300, description: 'One sentence the person reads: what the credential is for.' }),
      description: Type.Optional(Type.String({ maxLength: 120, description: 'Short note stored with the secret, for example "Stripe test mode".' })),
    }, { additionalProperties: false }),
    execute: async (_id, input, _signal, _update, ctx) => {
      const reply = (text: string) => ({ content: [{ type: 'text' as const, text }], details: {} });
      const name = input.name.trim();
      const problem = nameProblem(name);
      if (problem) throw new Error(problem);
      await refresh();
      const entry = vault.find(name);
      if (entry && inScope(entry, ctx.cwd) && store.get().values.has(name)) return reply(`${name} is available. Use it as $${name} in bash.`);
      if (!ctx.hasUI) throw new Error(`${name} is ${entry ? 'not given to this project' : 'not stored'}, and there is no terminal to ask in. Tell the person to run /secret set ${name} in an interactive Pi. Do not ask for the value in chat.`);
      if (entry && store.get().values.has(name)) {
        const allowed = await ctx.ui.confirm(`Give ${name} to this project?`, `${input.reason}\n\nThe agent gets it as $${name} in bash commands that mention it, never the value.`);
        if (!allowed) return reply(`The person did not give ${name} to this project. Do not ask for it in chat; continue without it or stop.`);
        rescope(name, entry.scope === 'all' ? 'all' : [...entry.scope, projectOf(ctx.cwd)]);
        await refresh(true);
        return reply(`${name} is available. Use it as $${name} in bash.`);
      }
      const value = await askValue(ctx, name, `${input.reason}\n\nStored in the OS keychain. The agent gets only the name.`);
      if (!value) return reply(`The person did not provide ${name}. Do not ask for it in chat; continue without it or stop.`);
      const scope = entry?.scope ?? await chooseScope(ctx, name);
      if (!scope) return reply(`The person did not provide ${name}. Do not ask for it in chat; continue without it or stop.`);
      await put(name, value, scope, input.description);
      return reply(`${name} stored. Use it as $${name} in bash.`);
    },
  });

  // ── Injection: a bash command that mentions a name gets its value ──────────

  pi.on('tool_call', async (event, ctx) => {
    if (!isToolCallEventType('bash', event)) return undefined;
    await refresh();
    const entries = vault.list();
    const named = mentions(event.input.command, entries.map(entry => entry.name));
    if (!named.length) return undefined;
    const slot = store.get();
    const given = named.filter(name => inScope(entries.find(entry => entry.name === name)!, ctx.cwd) && slot.values.has(name));
    const withheld = named.filter(name => !given.includes(name));
    const file = given.length ? envFile(tmp(), given.map(name => ({ name, value: slot.values.get(name)! }))) : undefined;
    // The model's own tool call is a clone of these arguments: the session and the UI keep the command it wrote.
    if (file) event.input.command = `${file.prefix}${event.input.command}`;
    store.set(current => ({
      ...current,
      pending: new Map([...current.pending, [event.toolCallId, { file: file?.path, withheld }]]),
      files: file ? new Set([...current.files, file.path]) : current.files,
    }));
    return undefined;
  });

  // ── Redaction: nothing a tool returns carries a value ──────────────────────

  pi.on('tool_result', async event => {
    await refresh();
    const pending = store.get().pending.get(event.toolCallId);
    if (pending) {
      if (pending.file) discard(pending.file);
      store.set(slot => ({
        ...slot,
        pending: new Map([...slot.pending].filter(([id]) => id !== event.toolCallId)),
        files: new Set([...slot.files].filter(path => path !== pending.file)),
      }));
    }
    const { redactor } = store.get();
    // A truncated bash output keeps the whole output in a temp file the model may read later.
    const fullOutput = (event.details as { fullOutputPath?: unknown } | undefined)?.fullOutputPath;
    if (typeof fullOutput === 'string' && existsSync(fullOutput)) {
      const raw = readFileSync(fullOutput, 'utf8');
      const clean = redactor.text(raw);
      if (clean !== raw) writeFileSync(fullOutput, clean);
    }
    const content = redactor.deep(event.content);
    const details = redactor.deep(event.details);
    const note = pending?.withheld.length
      ? [{ type: 'text' as const, text: `\n${pending.withheld.join(', ')} ${pending.withheld.length === 1 ? 'was' : 'were'} not set: not stored or not given to this project. Call secret_request; do not ask for the value in chat.` }]
      : [];
    const changed = JSON.stringify(content) !== JSON.stringify(event.content) || JSON.stringify(details) !== JSON.stringify(event.details);
    if (!changed && !note.length) return undefined;
    return { content: [...content, ...note], details };
  });

  /** Last line: whatever reached the history some other way is hidden before each model call. */
  pi.on('context', async (event, ctx) => {
    await refresh();
    const result = await protect(store.get().redactor.deep(event.messages), ctx);
    if (result.cancelled) { ctx.abort(); ctx.ui.notify('Sending cancelled / Envío cancelado.', 'info'); }
    return { messages: result.value };
  });
  // Includes system instructions restored by Pi after ordinary context handlers.
  pi.on('context_with_system', async (event, ctx) => {
    await refresh();
    const result = await protect(store.get().redactor.deep(event.messages), ctx);
    if (result.cancelled) ctx.abort();
    return { messages: result.value };
  });
  // Final SDK boundary: also covers data introduced by another extension/provider.
  pi.on('before_provider_request', async (event, ctx) => {
    await refresh();
    const result = await protect(store.get().redactor.deep(event.payload), ctx);
    if (result.cancelled) ctx.abort();
    return result.value;
  });

  // ── The person's own ! commands get the same values and the same redaction ──

  pi.on('user_bash', async (event, ctx) => {
    await refresh();
    const entries = vault.list();
    const slot = store.get();
    const given = mentions(event.command, entries.map(entry => entry.name))
      .filter(name => inScope(entries.find(entry => entry.name === name)!, ctx.cwd) && slot.values.has(name));
    if (!given.length && !slot.values.size) return undefined;
    const local = createLocalBashOperations();
    return {
      operations: {
        async exec(command, cwd, execOptions) {
          const stream = createStreamRedactor(store.get().redactor, execOptions.onData);
          const env = { ...(execOptions.env ?? process.env), ...Object.fromEntries(given.map(name => [name, slot.values.get(name)!])) };
          try { return await local.exec(command, cwd, { ...execOptions, env, onData: chunk => stream.write(chunk) }); }
          finally { stream.end(); }
        },
      },
    };
  });

  // ── A credential typed or pasted into the chat never reaches the model ────

  pi.on('input', async (event, ctx) => {
    await refresh();
    const redactor = store.get().redactor;
    const hidden = redactor.found(event.text);
    const text = redactor.text(event.text);
    const finish = async (candidate: string) => {
      const result = await protect(candidate, ctx, event.source === 'interactive' && ctx.hasUI && ctx.mode === 'tui');
      if (result.cancelled) {
        ctx.ui.notify('Sending cancelled / Envío cancelado.', 'info');
        return { action: 'handled' as const };
      }
      return result.value !== event.text ? { action: 'transform' as const, text: result.value, images: event.images } : { action: 'continue' as const };
    };
    if (hidden.length) ctx.ui.notify(`Hid the value of ${hidden.join(', ')} from your message; the agent sees ${hidden.map(marker).join(', ')}.`, 'info');
    const seen = event.source === 'interactive' && ctx.hasUI ? sight(text) : undefined;
    if (!seen) return finish(text);
    const keep = await ctx.ui.confirm(`That looks like a ${seen.label}`, `Store it in the OS keychain instead of sending it? The agent will get only its name.`);
    if (!keep) return finish(text);
    const suggested = freeName(seen.name);
    const typed = (await ctx.ui.input('Name for this secret', suggested))?.trim();
    const name = typed ? toName(typed) : suggested;
    const problem = nameProblem(name) ?? valueProblem(seen.value);
    if (problem) {
      ctx.ui.notify(`${problem} Your message was not sent.`, 'error');
      ctx.ui.setEditorText(text);
      return { action: 'handled' as const };
    }
    const scope = vault.find(name)?.scope ?? await chooseScope(ctx, name);
    if (!scope) {
      ctx.ui.notify('Not stored. Your message was not sent.', 'warning');
      ctx.ui.setEditorText(text);
      return { action: 'handled' as const };
    }
    await put(name, seen.value, scope);
    ctx.ui.notify(`${name} stored in the OS keychain. Your message now says ${marker(name)}.`, 'info');
    return finish(text.replaceAll(seen.value, marker(name)));
  });

  const freeName = (base: string): string => {
    const taken = new Set(vault.list().map(entry => entry.name));
    if (!taken.has(base)) return base;
    const suffix = [2, 3, 4, 5, 6, 7, 8, 9].find(n => !taken.has(`${base}_${n}`));
    return suffix ? `${base}_${suffix}` : `${base}_NEW`;
  };

  // ── /secret ────────────────────────────────────────────────────────────────

  const output = (ctx: ExtensionCommandContext, text: string, level: 'info' | 'warning' | 'error' = 'info'): void => {
    if (ctx.hasUI) ctx.ui.notify(text, level);
    else console.log(text);
  };

  const set = async (ctx: ExtensionCommandContext, name: string, description?: string): Promise<string | undefined> => {
    const problem = nameProblem(name);
    if (problem) { output(ctx, problem, 'error'); return undefined; }
    if (!ctx.hasUI) { output(ctx, 'Secrets are typed into a masked prompt; run /secret set in an interactive Pi.', 'error'); return undefined; }
    const existing = vault.find(name);
    const value = await askValue(ctx, name, existing
      ? `Replaces the stored value (${tail(store.get().values.get(name) ?? '')}). Agents keep using $${name}; nothing else changes.`
      : 'Stored in the OS keychain. Agents get only the name.');
    if (!value) return undefined;
    const scope = existing?.scope ?? await chooseScope(ctx, name);
    if (!scope) return undefined;
    const entry = await put(name, value, scope, description);
    output(ctx, `${name} ${existing ? 'replaced' : 'stored'} · ${describe(entry)}`);
    return name;
  };

  const create = async (ctx: ExtensionCommandContext): Promise<string | undefined> => {
    const typed = (await ctx.ui.input('Name for the new secret', 'STRIPE_SECRET_KEY'))?.trim();
    if (!typed) return undefined;
    return set(ctx, toName(typed));
  };

  const manage = async (ctx: ExtensionCommandContext, initial?: string): Promise<void> => {
    await refresh();
    const intent = { value: undefined as SecretIntent | undefined };
    await openPanel(ctx, secretPanelSpec({
      entries: () => vault.list(),
      value: name => store.get().values.get(name),
      cwd: ctx.cwd,
      project: projectOf(ctx.cwd),
      remove,
      rescope,
      request: next => { intent.value = next; },
    }, initial));
    const next = intent.value;
    if (!next) return;
    const name = next.action === 'create' ? await create(ctx) : await set(ctx, next.name);
    return manage(ctx, name ?? (next.action === 'replace' ? next.name : initial));
  };

  const listText = (ctx: ExtensionCommandContext): string => panelText(secretPanelSpec({
    entries: () => vault.list(), value: name => store.get().values.get(name), cwd: ctx.cwd, project: projectOf(ctx.cwd),
    remove, rescope, request: () => {},
  }));

  const names = (): readonly CommandOption[] => vault.list().map(entry => ({ value: entry.name, description: scopeText(entry) }));

  pi.registerCommand('secret', {
    description: brand('secrets for agents: stored in the keychain, used by name, never shown'),
    getArgumentCompletions: completer(() => [
      { value: 'set', description: 'store or replace a secret through a masked prompt', options: names },
      { value: 'remove', description: 'delete a secret from the keychain', options: names },
      { value: 'list', description: 'names and where each one is available' },
      { value: 'help', description: 'usage' },
    ]),
    handler: async (args, ctx) => {
      const [verb = '', name = '', ...rest] = args.trim().split(/\s+/).filter(Boolean);
      try {
        if (!verb) {
          if (ctx.mode === 'tui' && ctx.hasUI) await manage(ctx);
          else { await refresh(); output(ctx, listText(ctx)); }
          return;
        }
        if (verb === 'set') { await refresh(); if (!name) { output(ctx, 'Usage: /secret set NAME [about]', 'error'); return; } await set(ctx, name, rest.join(' ') || undefined); return; }
        if (verb === 'list') { await refresh(); output(ctx, listText(ctx)); return; }
        if (verb === 'remove') {
          if (!vault.find(name)) { output(ctx, `No secret named ${name || '(none)'}.`, 'error'); return; }
          if (ctx.hasUI && !await ctx.ui.confirm(`Delete ${name}?`, 'Removes it from the OS keychain. Agents lose $' + name + ' in every project.')) return;
          await remove(name);
          output(ctx, `${name} deleted from the keychain.`);
          return;
        }
        output(ctx, HELP, verb === 'help' ? 'info' : 'warning');
      } catch (error) {
        output(ctx, error instanceof Error ? error.message : String(error), 'error');
      }
    },
  });

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  pi.on('session_start', async () => {
    try { sweep(tmp()); } catch { /* the next command recreates the folder */ }
    await refresh(true).catch(() => {});
  });

  pi.on('session_shutdown', async () => {
    for (const file of store.get().files) discard(file);
    store.set(slot => ({ ...slot, files: new Set(), pending: new Map() }));
  });
}

export default function secretsExtension(pi: ExtensionAPI): void {
  installSecrets(pi);
}
