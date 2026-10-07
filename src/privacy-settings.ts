import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { defaultRoot } from './vault.ts';

export type PrivacyMode = 'ask' | 'always';
export const PRIVACY_MODES = {
  always: 'Always obfuscate, never ask / Ofuscar siempre, sin preguntar',
  ask: 'Ask before sending / Preguntar antes de enviar',
} as const;

/** User preference only: never stores detected data or credentials. */
export function privacySettings(root = defaultRoot()) {
  const file = join(root, 'privacy.json');
  return {
    get(): PrivacyMode {
      try {
        const saved: unknown = JSON.parse(readFileSync(file, 'utf8'));
        return saved && typeof saved === 'object' && 'mode' in saved && saved.mode === 'ask' ? 'ask' : 'always';
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'always';
        throw new Error('Cannot read privacy settings. Use /secret privacy to set the mode again.');
      }
    },
    set(mode: PrivacyMode): void {
      mkdirSync(root, { recursive: true, mode: 0o700 });
      const temporary = `${file}.${randomUUID()}.tmp`;
      writeFileSync(temporary, `${JSON.stringify({ version: 1, mode }, null, 2)}\n`, { mode: 0o600 });
      renameSync(temporary, file);
    },
  };
}
