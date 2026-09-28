import type { KeyStore } from '../src/vault.ts';

/** The OS keychain stand-in: tests never touch the real one. */
export const memoryKeys = (): KeyStore & { readonly map: Map<string, string> } => {
  const map = new Map<string, string>();
  return {
    map,
    get: async name => map.get(name),
    set: async (name, value) => { map.set(name, value); },
    delete: async name => { map.delete(name); },
  };
};
