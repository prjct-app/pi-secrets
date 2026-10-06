/** Environment variable names: what the agent writes as $NAME in a command. */
export const NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
export const NAME_RULE = 'Use an environment variable name: A–Z, digits and underscores, starting with a letter, at most 64 characters.';

/** Shorter values would redact ordinary words from every output. */
export const MIN_VALUE = 4;
export const MAX_VALUE = 16_384;

export const validName = (name: string): boolean => NAME_PATTERN.test(name);

export function valueProblem(value: string): string | undefined {
  if (value.length < MIN_VALUE) return `A secret needs at least ${MIN_VALUE} characters.`;
  if (value.length > MAX_VALUE) return `A secret can have at most ${MAX_VALUE} characters.`;
  if (value.includes('\0')) return 'A secret cannot contain a NUL character.';
  return undefined;
}

/** "sk-live key" → "SK_LIVE_KEY", for suggesting a name. */
export const toName = (text: string): string =>
  text.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^[^A-Z]+/, '').replace(/_+$/, '').slice(0, 64);

/** The names a command mentions as a whole word: $NAME, ${NAME}, or NAME alone. */
export function mentions(command: string, names: readonly string[]): readonly string[] {
  return names.filter(name => new RegExp(`(?<![A-Za-z0-9_])${name}(?![A-Za-z0-9_])`).test(command));
}

/**
 * What the person may see of a value: its last six characters, fewer for a
 * short value so most of it always stays hidden.
 */
export function tail(value: string): string {
  const shown = Math.min(6, Math.floor(value.length / 4));
  return `••••${shown ? value.slice(-shown) : ''}`;
}
