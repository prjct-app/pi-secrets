import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { validName } from './names.ts';

/** Where values live: the OS keychain in production, a map in tests. */
export type KeyStore = {
  readonly get: (name: string) => Promise<string | undefined>;
  readonly set: (name: string, value: string) => Promise<void>;
  readonly delete: (name: string) => Promise<void>;
};

/** `all` or the project roots the secret is given to. */
export type Scope = 'all' | readonly string[];

/** What is known about a secret without its value. Safe to write to disk and show. */
export type Entry = {
  readonly name: string;
  readonly description?: string;
  readonly scope: Scope;
  readonly createdAt: string;
  readonly updatedAt: string;
};

type Index = { readonly version: 1; readonly secrets: readonly Entry[] };

export const KEYCHAIN_SERVICE = 'app.prjct.pi-secrets';

const missing = (error: unknown): boolean => /not found|no such|not exist|no (matching )?entry/i.test(String(error));
const locked = (): Error => new Error('Cannot reach the OS keychain. Unlock it and try again; values are never kept in a plaintext file.');

export const defaultRoot = (): string => join(process.env.PRJCT_HOME ?? join(homedir(), '.prjct'), 'pi-secrets');

/** The keychain (macOS) or Secret Service (Linux) through @napi-rs/keyring, loaded on first use. */
export function keychain(): KeyStore {
  const entry = async (name: string) => {
    const { AsyncEntry } = await import('@napi-rs/keyring');
    return new AsyncEntry(KEYCHAIN_SERVICE, name);
  };
  return {
    get: async name => {
      try { return (await (await entry(name)).getPassword()) ?? undefined; }
      catch (error) { if (missing(error)) return undefined; throw locked(); }
    },
    set: async (name, value) => { await (await entry(name)).setPassword(value); },
    delete: async name => {
      try { await (await entry(name)).deletePassword(); }
      catch (error) { if (!missing(error)) throw locked(); }
    },
  };
}

/** The folder that holds `.git` above `cwd`, else `cwd` itself. */
export function projectOf(cwd: string): string {
  const real = (() => { try { return realpathSync(cwd); } catch { return cwd; } })();
  const up = (path: string): string | undefined =>
    existsSync(join(path, '.git')) ? path : dirname(path) === path ? undefined : up(dirname(path));
  return up(real) ?? real;
}

export const inScope = (entry: Entry, cwd: string): boolean => {
  if (entry.scope === 'all') return true;
  const real = (() => { try { return realpathSync(cwd); } catch { return cwd; } })();
  return entry.scope.some(root => real === root || real.startsWith(root.endsWith(sep) ? root : root + sep));
};

export type Vault = ReturnType<typeof createVault>;

/**
 * Names, scopes and dates in a private JSON index; values only in the key
 * store. The index never holds a value or any part of one.
 */
export function createVault(options: { readonly root?: string; readonly keys?: KeyStore; readonly now?: () => Date } = {}) {
  const root = options.root ?? defaultRoot();
  const file = join(root, 'index.json');
  const keys = options.keys ?? keychain();
  const now = (): string => (options.now?.() ?? new Date()).toISOString();

  const read = (): Index => {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<Index>;
      const secrets = Array.isArray(parsed.secrets) ? parsed.secrets.filter(isEntry) : [];
      return { version: 1, secrets };
    } catch { return { version: 1, secrets: [] }; }
  };
  const write = (index: Index): void => {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const temporary = `${file}.${randomUUID()}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(index, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, file);
  };
  const update = (change: (secrets: readonly Entry[]) => readonly Entry[]): void => {
    write({ version: 1, secrets: [...change(read().secrets)].sort((a, b) => a.name.localeCompare(b.name)) });
  };

  return {
    list: (): readonly Entry[] => read().secrets,
    find: (name: string): Entry | undefined => read().secrets.find(entry => entry.name === name),
    /** Changes whenever any terminal changes the index, so each process knows to reload values. */
    stamp: (): number => { try { return statSync(file).mtimeMs; } catch { return 0; } },
    value: (name: string): Promise<string | undefined> => keys.get(name),
    async put(name: string, value: string, details: { readonly description?: string; readonly scope: Scope }): Promise<Entry> {
      if (!validName(name)) throw new Error(`${name} is not a valid secret name.`);
      await keys.set(name, value);
      const previous = read().secrets.find(entry => entry.name === name);
      const at = now();
      const entry: Entry = {
        name,
        description: details.description ?? previous?.description,
        scope: details.scope,
        createdAt: previous?.createdAt ?? at,
        updatedAt: at,
      };
      update(secrets => [...secrets.filter(item => item.name !== name), entry]);
      return entry;
    },
    rescope(name: string, scope: Scope): void {
      update(secrets => secrets.map(entry => entry.name === name ? { ...entry, scope, updatedAt: now() } : entry));
    },
    async remove(name: string): Promise<void> {
      await keys.delete(name);
      update(secrets => secrets.filter(entry => entry.name !== name));
    },
  };
}

function isEntry(value: unknown): value is Entry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Partial<Entry>;
  const scope = entry.scope === 'all' || (Array.isArray(entry.scope) && entry.scope.every(path => typeof path === 'string'));
  return typeof entry.name === 'string' && validName(entry.name) && scope
    && typeof entry.createdAt === 'string' && typeof entry.updatedAt === 'string';
}
