import { chmodSync, lstatSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Known } from './redact.ts';

/** Single-quoted for POSIX shells: nothing inside is expanded. */
export const quote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

/** A private folder only this user can enter, for the one-shot environment files. */
export function privateDir(base = tmpdir()): string {
  const dir = join(base, `pi-secrets-${process.getuid?.() ?? 'user'}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const info = lstatSync(dir);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`${dir} is not a private directory.`);
  if (process.getuid && info.uid !== process.getuid()) throw new Error(`${dir} belongs to another user.`);
  chmodSync(dir, 0o700);
  return dir;
}

/**
 * Writes the values to a file only this user can read and returns the command
 * that loads them. The shell deletes the file as soon as it has read it, so
 * the values never appear in the command line (visible in `ps`), in the tool
 * call the model wrote, or in the session.
 */
export function envFile(dir: string, secrets: readonly Known[]): { readonly path: string; readonly prefix: string } {
  const path = join(dir, `${randomUUID()}.sh`);
  const body = secrets.map(secret => `export ${secret.name}=${quote(secret.value)}`).join('\n');
  writeFileSync(path, `${body}\n`, { mode: 0o600, flag: 'wx' });
  return { path, prefix: `. ${quote(path)}; rm -f ${quote(path)}\n` };
}

export const discard = (path: string): void => { rmSync(path, { force: true }); };

/** Files a crashed process left behind; a command reads its file within milliseconds. */
export function sweep(dir: string, olderThanMs = 60_000, now = Date.now()): void {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    try { if (now - statSync(path).mtimeMs > olderThanMs) rmSync(path, { force: true }); } catch { /* gone already */ }
  }
}
