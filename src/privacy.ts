import { mapText } from './protocol.ts';
export { mapText } from './protocol.ts';
import { createHash, randomBytes } from 'node:crypto';
import { sightings } from './detect.ts';

export const PRIVACY_CHOICES = ['Obfuscate / Ofuscar', 'Send original / Enviar original', 'Cancel / Cancelar', 'Automatically obfuscate for this session / Ofuscar automáticamente en esta sesión'] as const;
export type Finding = Readonly<{ kind: string; value: string; masked: string }>;
export type PrivacyContext = Readonly<{
  destination: string;
  interactive: boolean;
  choose: (preview: string, choices: readonly string[]) => Promise<string | undefined>;
  notify: (message: string) => void;
}>;

// A left boundary avoids retrying every suffix of a long source-code token.
const EMAIL = /(?<![a-zA-Z0-9.!#$%&'+/=?^_`{|}~-])[a-zA-Z0-9.!#$%&'+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)+/g;
const maskEmail = (value: string): string => `${value[0]}**********@****.${value.slice(value.lastIndexOf('.') + 1)}`;
const luhn = (value: string): boolean => {
  const digits = value.replace(/\D/g, '');
  return digits.length >= 13 && digits.length <= 19 && !/^(.)\1+$/.test(digits)
    && [...digits].reverse().reduce((sum, digit, index) => {
      const n = Number(digit) * (index % 2 ? 2 : 1);
      return sum + (n > 9 ? n - 9 : n);
    }, 0) % 10 === 0;
};

/** Local patterns only: no PII is sent to a classifier to decide whether it is PII. */
export function findSensitive(text: string): readonly Finding[] {
  const credentials = sightings(text).map(item => ({ kind: item.label, value: item.value, masked: `[redacted:${item.name}]` }));
  const emails = [...text.matchAll(EMAIL)]
    // Package versions such as typebox@1.3.7 are not email addresses.
    .filter(match => /^(?:[a-z]{2,}|xn--[a-z0-9-]+)$/i.test(match[0].slice(match[0].lastIndexOf('.') + 1)))
    .map(match => ({ kind: 'email', value: match[0], masked: maskEmail(match[0]) }));
  const cards = [...text.matchAll(/(?<![A-Za-z0-9_])(?=(\d{13,19}|\d{4}(?:[ -]\d{4}){3}|\d{4}[ -]\d{6}[ -]\d{5})(?![A-Za-z0-9_]))/g)]
    .map(match => match[1]!).filter(luhn)
    .map(value => ({ kind: 'payment card', value, masked: `************${value.replace(/\D/g, '').slice(-4)}` }));
  const withoutCards = cards.reduce((result, card) => result.replaceAll(card.value, '#'), text);
  const phones = [...withoutCards.matchAll(/(?<![\w+])\+[1-9]\d{0,2}(?:[ ().-]*\d){7,13}(?!\d)/g)]
    .filter(match => match[0].replace(/\D/g, '').length <= 15)
    .map(match => ({ kind: 'international phone', value: match[0], masked: '+************' }));
  return [...new Map([...credentials, ...emails, ...cards, ...phones].map(item => [item.value, item])).values()]
    .sort((a, b) => b.value.length - a.value.length);
}

/** Cache only clean text, never consent or mutable message objects. Bounds are
 * local work limits, not context limits: every cache miss is fully inspected. */
export function createSensitiveScanner(maxCharacters = 4 * 1024 * 1024, maxEntries = 2048) {
  const clean = new Map<string, true>();
  const size = { characters: 0 };
  return (text: string): readonly Finding[] => {
    if (clean.has(text)) return [];
    const found = findSensitive(text);
    if (found.length || !text.length || text.length > maxCharacters || maxEntries < 1) return found;
    while (clean.size && (clean.size >= maxEntries || size.characters + text.length > maxCharacters)) {
      const oldest = clean.keys().next().value!;
      clean.delete(oldest);
      size.characters -= oldest.length;
    }
    clean.set(text, true);
    size.characters += text.length;
    return found;
  };
}

const scanSensitive = createSensitiveScanner();

const replaceFinding = (text: string, item: Finding): string => {
  if (item.kind !== 'payment card') return text.replaceAll(item.value, item.masked);
  const escaped = item.value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text.replace(new RegExp(`(?<![A-Za-z0-9_])${escaped}(?![A-Za-z0-9_])`, 'g'), () => item.masked);
};

/** For background SDK consumers that cannot ask for consent. */
export const maskSensitiveData = <T>(value: T): T => mapText(value, text =>
  scanSensitive(text).reduce((result, item) => replaceFinding(result, item), text));

type VaultOptions = Parameters<typeof import('./vault.ts').createVault>[0];
type Redactor = ReturnType<typeof import('./redact.ts').createRedactor>;
type CachedRedactor = { revision: string; pending: Promise<Redactor> };
const defaultRedactors = new Map<string, CachedRedactor>();
const injectedRedactors = new WeakMap<object, Map<string, CachedRedactor>>();

/** Explicit user-initiated retry; failed background reads never retry themselves. */
export function resetOutboundProtection(): void { defaultRedactors.clear(); }

/** Background SDK calls share one keychain read per index revision, including failures. */
export async function protectOutboundData<T>(value: T, options: VaultOptions = {}): Promise<T> {
  const { createVault, defaultRoot } = await import('./vault.ts');
  const { createRedactor } = await import('./redact.ts');
  const vault = createVault(options);
  const root = options.root ?? defaultRoot();
  const entries = vault.list();
  const revision = JSON.stringify([vault.stamp(), entries]);
  const cache = options.keys ? injectedRedactors.get(options.keys) ?? new Map<string, CachedRedactor>() : defaultRedactors;
  if (options.keys) injectedRedactors.set(options.keys, cache);
  const previous = cache.get(root);
  const pending = previous?.revision === revision ? previous.pending : (async () => {
    // Retain a rejected read too: declining one dialog must not cause one per hook.
    const known = await Promise.all(entries.map(async entry => ({ name: entry.name, value: await vault.value(entry.name) })));
    return createRedactor(known.filter((item): item is { name: string; value: string } => typeof item.value === 'string'));
  })();
  cache.set(root, { revision, pending });
  const redactor = await pending;
  return maskSensitiveData(redactor.deep(value));
}

type Decision = 'send' | 'mask';
export type PrivacySnapshot = Readonly<{
  v: 1;
  salt: string;
  decisions: readonly (readonly [string, Decision])[];
  automatic: readonly string[];
}>;
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const isDecision = (value: unknown): value is readonly [string, Decision] =>
  Array.isArray(value) && value.length === 2 && digest(value[0]) && (value[1] === 'send' || value[1] === 'mask');
const isSnapshot = (value: unknown): value is PrivacySnapshot => {
  if (!value || typeof value !== 'object') return false;
  const data = value as Record<string, unknown>;
  return data.v === 1 && digest(data.salt) && Array.isArray(data.decisions) && data.decisions.every(isDecision)
    && Array.isArray(data.automatic) && data.automatic.every(digest);
};
const newState = (saved?: unknown) => {
  const snapshot = isSnapshot(saved) ? saved : undefined;
  return { salt: snapshot?.salt ?? randomBytes(32).toString('hex'), decisions: new Map<string, Decision>(snapshot?.decisions),
    automatic: new Set(snapshot?.automatic), queue: Promise.resolve<unknown>(undefined), notified: false, generation: 0 };
};

export function createPrivacyGuard(options: { onChange?: (snapshot: PrivacySnapshot) => void } = {}) {
  const cell = { state: newState() };
  const snapshot = (): PrivacySnapshot => ({ v: 1, salt: cell.state.salt, decisions: [...cell.state.decisions], automatic: [...cell.state.automatic] });
  const changed = (): void => { options.onChange?.(snapshot()); };
  const inspect = async <T>(value: T, ctx: PrivacyContext, state: ReturnType<typeof newState>, generation: number): Promise<{ value: T; cancelled: boolean; changed: boolean }> => {
      if (state !== cell.state || generation !== state.generation) return { value: maskSensitiveData(value), cancelled: true, changed: true };
      const key = (value: string): string => createHash('sha256').update(state.salt).update(ctx.destination).update('\0').update(value).digest('hex');
      const found = new Map<string, Finding>();
      mapText(value, text => { for (const item of scanSensitive(text)) found.set(item.value, item); return text; });
      const pending = [...found.values()].filter(item => !state.decisions.has(key(item.value)));
      const automatic = state.automatic.has(key(''));
      const selected = pending.length && ctx.interactive && !automatic
        ? await ctx.choose(`Sensitive data / Datos sensibles → ${ctx.destination}\n${pending.slice(0, 8).map(item => `${item.kind}: ${item.masked}`).join('\n')}${pending.length > 8 ? `\n+${pending.length - 8} more` : ''}\nRemember these values for this session and destination. Automatic obfuscation also covers new values. Reset with /secret privacy reset.\nRecordar estos datos para esta sesión y destino. La ofuscación automática incluye datos nuevos. Restablecer con /secret privacy reset.`, PRIVACY_CHOICES)
        : PRIVACY_CHOICES[0];
      const cancelled = state !== cell.state || (pending.length > 0 && ctx.interactive
        && selected !== PRIVACY_CHOICES[0] && selected !== PRIVACY_CHOICES[1] && selected !== PRIVACY_CHOICES[3]);
      if (cancelled && generation === state.generation) state.generation++;
      if (!cancelled && pending.length) {
        if (selected === PRIVACY_CHOICES[3]) {
          state.automatic.add(key(''));
          changed();
        } else if (!automatic) {
          for (const item of pending) state.decisions.set(key(item.value), selected === PRIVACY_CHOICES[1] ? 'send' : 'mask');
          changed();
        }
      }
      if (!cancelled && pending.length && !ctx.interactive && !automatic && !state.notified) {
        state.notified = true;
        ctx.notify(`Obfuscating sensitive data before sending to ${ctx.destination}; interactive consent is unavailable. Further background notices are suppressed for this session.`);
      }
      const changes = { value: false };
      const replacements = [...found.values()]
        .filter(item => cancelled || state.automatic.has(key('')) || state.decisions.get(key(item.value)) !== 'send')
        .sort((a, b) => b.value.length - a.value.length);
      const sanitized = replacements.length ? mapText(value, text => replacements.reduce((result, item) => {
        const next = replaceFinding(result, item);
        if (next !== result) changes.value = true;
        return next;
      }, text)) : value;
      return { value: sanitized, cancelled, changed: changes.value };
  };
  return {
    snapshot,
    restore: (saved?: unknown): void => { cell.state = newState(saved); },
    reset: (): void => { cell.state = newState(); changed(); },
    inspect<T>(value: T, ctx: PrivacyContext): Promise<{ value: T; cancelled: boolean; changed: boolean }> {
      const state = cell.state;
      const generation = state.generation;
      // Recheck decisions after earlier dialogs finish; simultaneous hooks share
      // consent instead of presenting one dialog per request.
      const next = state.queue.then(() => inspect(value, ctx, state, generation)).catch(error => {
        if (generation === state.generation) state.generation++;
        throw error;
      });
      state.queue = next.catch(() => undefined);
      return next;
    },
  };
}
