import { createHash, randomBytes } from 'node:crypto';
import { sightings } from './detect.ts';

export const PRIVACY_CHOICES = ['Obfuscate / Ofuscar', 'Send original / Enviar original', 'Cancel / Cancelar'] as const;
export type Finding = Readonly<{ kind: string; value: string; masked: string }>;
export type PrivacyContext = Readonly<{
  destination: string;
  interactive: boolean;
  choose: (preview: string, choices: readonly string[]) => Promise<string | undefined>;
  notify: (message: string) => void;
}>;

const EMAIL = /[a-zA-Z0-9.!#$%&'+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)+/g;
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
  const emails = [...text.matchAll(EMAIL)].map(match => ({ kind: 'email', value: match[0], masked: maskEmail(match[0]) }));
  const cards = [...text.matchAll(/(?<!\d)(?=(\d{13,19}|\d{4}(?:[ -]\d{4}){3}|\d{4}[ -]\d{6}[ -]\d{5})(?!\d))/g)]
    .map(match => match[1]!).filter(luhn)
    .map(value => ({ kind: 'payment card', value, masked: `************${value.replace(/\D/g, '').slice(-4)}` }));
  const withoutCards = cards.reduce((result, card) => result.replaceAll(card.value, '#'), text);
  const phones = [...withoutCards.matchAll(/(?<![\w+])\+[1-9]\d{0,2}(?:[ ().-]*\d){7,13}(?!\d)/g)]
    .filter(match => match[0].replace(/\D/g, '').length <= 15)
    .map(match => ({ kind: 'international phone', value: match[0], masked: '+************' }));
  return [...new Map([...credentials, ...emails, ...cards, ...phones].map(item => [item.value, item])).values()]
    .sort((a, b) => b.value.length - a.value.length);
}

/** Preserve provider protocol fields and opaque binary/signature data. No image OCR. */
const OPAQUE = new Set(['signature', 'thoughtSignature', 'thinkingSignature', 'encrypted_content', 'mimeType', 'type', 'role', 'call_id', 'tool_call_id', 'model', 'provider', 'api']);
export function mapText<T>(value: T, transform: (text: string) => string): T {
  if (typeof value === 'string') return transform(value) as T;
  if (Array.isArray(value)) return value.map(item => mapText(item, transform)) as T;
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const record = value as Record<string, unknown>;
    if (record.type === 'image' || record.type === 'image_url' || record.type === 'input_image') return value;
    return Object.fromEntries(Object.entries(record).map(([key, item]) => [key, OPAQUE.has(key) ? item : mapText(item, transform)])) as T;
  }
  return value;
}

/** For background SDK consumers that cannot ask for consent. */
export const maskSensitiveData = <T>(value: T): T => mapText(value, text =>
  findSensitive(text).reduce((result, item) => result.replaceAll(item.value, item.masked), text));

/** Background SDK calls have no confirmation UI: redact known keys and detected PII. */
export async function protectOutboundData<T>(value: T, options: Parameters<typeof import('./vault.ts').createVault>[0] = {}): Promise<T> {
  const { createVault } = await import('./vault.ts');
  const { createRedactor } = await import('./redact.ts');
  const vault = createVault(options);
  // An inaccessible keychain fails this call rather than silently dropping protection.
  const known = await Promise.all(vault.list().map(async entry => ({ name: entry.name, value: await vault.value(entry.name) })));
  const redactor = createRedactor(known.filter((item): item is { name: string; value: string } => typeof item.value === 'string'));
  return maskSensitiveData(redactor.deep(value));
}

export function createPrivacyGuard() {
  const salt = randomBytes(32);
  const decisions = new Map<string, 'send' | 'mask'>();
  const key = (destination: string, value: string): string => createHash('sha256').update(salt).update(destination).update('\0').update(value).digest('hex');
  return {
    reset: (): void => { decisions.clear(); },
    async inspect<T>(value: T, ctx: PrivacyContext): Promise<{ value: T; cancelled: boolean; changed: boolean }> {
      const found = new Map<string, Finding>();
      mapText(value, text => { for (const item of findSensitive(text)) found.set(item.value, item); return text; });
      const pending = [...found.values()].filter(item => !decisions.has(key(ctx.destination, item.value)));
      const selected = pending.length && ctx.interactive
        ? await ctx.choose(`Sensitive data / Datos sensibles → ${ctx.destination}\n${pending.slice(0, 8).map(item => `${item.kind}: ${item.masked}`).join('\n')}${pending.length > 8 ? `\n+${pending.length - 8} more` : ''}\nChoice applies to these values and this destination for this session. / La elección aplica a estos datos y destino durante esta sesión.`, PRIVACY_CHOICES)
        : PRIVACY_CHOICES[0];
      const cancelled = pending.length > 0 && ctx.interactive && selected !== PRIVACY_CHOICES[0] && selected !== PRIVACY_CHOICES[1];
      if (!cancelled) for (const item of pending) decisions.set(key(ctx.destination, item.value), selected === PRIVACY_CHOICES[1] ? 'send' : 'mask');
      if (pending.length && !ctx.interactive) ctx.notify(`Obfuscated ${pending.length} sensitive value(s) before sending to ${ctx.destination}; interactive consent is unavailable.`);
      const changes = { value: false };
      const sanitized = mapText(value, text => [...found.values()].sort((a, b) => b.value.length - a.value.length).reduce((result, item) => {
        if (!cancelled && decisions.get(key(ctx.destination, item.value)) === 'send') return result;
        const next = result.replaceAll(item.value, item.masked);
        if (next !== result) changes.value = true;
        return next;
      }, text));
      return { value: sanitized, cancelled, changed: changes.value };
    },
  };
}
