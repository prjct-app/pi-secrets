import { mapText } from './protocol.ts';
import { StringDecoder } from 'node:string_decoder';
import { MIN_VALUE } from './names.ts';

/** A secret the process knows the value of. Never leaves this module in any output. */
export type Known = { readonly name: string; readonly value: string };

export type Redactor = {
  /** Every known form of every value replaced by `[secret:NAME]`. */
  readonly text: (input: string) => string;
  /** The same, applied to every string inside plain data (messages, details). Other values pass through untouched. */
  readonly deep: <T>(input: T) => T;
  /** Names whose values occur in the text, for telling the person what was hidden. */
  readonly found: (input: string) => readonly string[];
  /** Longest form of any value, for holding back the tail of a stream. */
  readonly longest: number;
  /** Moves a stream boundary before any known form that crosses it. */
  readonly safeCut: (input: string, limit: number) => number;
};

export const marker = (name: string): string => `[secret:${name}]`;

/**
 * The forms a value takes when a tool prints it: as typed, inside a JSON
 * string, URL-encoded, and base64 (standard, unpadded, URL-safe). A value
 * embedded in a larger encoded blob (Basic auth of `user:key`) is not one of
 * these and is not caught; the README says so.
 */
export function forms(value: string): readonly string[] {
  const base64 = Buffer.from(value, 'utf8').toString('base64');
  const unpadded = base64.replace(/=+$/, '');
  const candidates = [
    value,
    JSON.stringify(value).slice(1, -1),
    encodeURIComponent(value),
    base64,
    unpadded,
    unpadded.replaceAll('+', '-').replaceAll('/', '_'),
  ];
  return [...new Set(candidates)].filter(form => form.length >= MIN_VALUE);
}

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function createRedactor(known: readonly Known[]): Redactor {
  const pairs = known
    .flatMap(secret => forms(secret.value).map(form => ({ name: secret.name, form })))
    .sort((a, b) => b.form.length - a.form.length);
  const byForm = new Map(pairs.map(pair => [pair.form, pair.name]));
  const pattern = pairs.length ? new RegExp(pairs.map(pair => escape(pair.form)).join('|'), 'g') : undefined;
  const text = (input: string): string =>
    pattern && input ? input.replace(pattern, form => marker(byForm.get(form) ?? 'unknown')) : input;
  const deep = <T>(input: T): T => (pattern ? mapText(input, text) : input);
  const found = (input: string): readonly string[] =>
    pattern ? [...new Set([...input.matchAll(pattern)].map(match => byForm.get(match[0]) ?? 'unknown'))] : [];
  const safeCut = (input: string, limit: number): number => {
    const crossing = pattern ? [...input.matchAll(pattern)]
      .find(match => match.index < limit && match.index + match[0].length > limit) : undefined;
    return crossing?.index ?? limit;
  };
  return { text, deep, found, longest: pairs[0]?.form.length ?? 0, safeCut };
}

/**
 * Redacts a byte stream whose chunks may split a value. The tail that could
 * still be the start of a value is held back until the next chunk or the end.
 */
export function createStreamRedactor(redactor: Redactor, emit: (chunk: Buffer) => void) {
  const decoder = new StringDecoder('utf8');
  const pending = { text: '' };
  const hold = Math.max(0, redactor.longest - 1);
  const release = (final: boolean): void => {
    const limit = final ? pending.text.length : Math.max(0, pending.text.length - hold);
    const cut = redactor.safeCut(pending.text, limit);
    const ready = redactor.text(pending.text.slice(0, cut));
    pending.text = pending.text.slice(cut);
    if (ready) emit(Buffer.from(ready, 'utf8'));
  };
  return {
    write(chunk: Buffer): void { pending.text += decoder.write(chunk); release(false); },
    end(): void { pending.text += decoder.end(); release(true); },
  };
}
