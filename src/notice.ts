import { createHash } from 'node:crypto';

/** What the person is told was hidden, grouped the way they think about it. */
export type Category = 'stored' | 'credential' | 'email' | 'card' | 'phone';
export type Language = 'en' | 'es';
export type Masked = Readonly<{ category: Category; value: string }>;

const ORDER: readonly Category[] = ['stored', 'credential', 'email', 'card', 'phone'];
const WORDS: Readonly<Record<Language, Readonly<Record<Category, readonly [string, string]>>>> = {
  en: {
    stored: ['stored secret', 'stored secrets'], credential: ['credential', 'credentials'], email: ['email', 'emails'],
    card: ['payment card', 'payment cards'], phone: ['phone number', 'phone numbers'],
  },
  es: {
    stored: ['secreto guardado', 'secretos guardados'], credential: ['credencial', 'credenciales'], email: ['correo', 'correos'],
    card: ['tarjeta de pago', 'tarjetas de pago'], phone: ['teléfono', 'teléfonos'],
  },
};
const LEAD: Readonly<Record<Language, string>> = {
  en: 'Secrets obfuscated before sending to the model',
  es: 'Secrets ofuscó antes de enviar al modelo',
};

/** The category of a privacy finding kind (see findSensitive). Shaped credentials share one. */
export const categoryOf = (kind: string): Category =>
  kind === 'email' ? 'email' : kind === 'payment card' ? 'card' : kind === 'international phone' ? 'phone' : 'credential';

const ES_MARKS = /[ñ¿¡áéíóú]/iu;
const ES_WORDS = new Set(['que', 'de', 'la', 'el', 'en', 'los', 'las', 'por', 'para', 'con', 'una', 'un', 'es', 'no', 'se', 'lo', 'del', 'mi', 'y', 'pero', 'como', 'esto', 'esta', 'hay']);
const EN_WORDS = new Set(['the', 'and', 'to', 'of', 'is', 'in', 'it', 'for', 'you', 'that', 'with', 'this', 'on', 'my', 'are', 'be', 'please', 'can', 'what', 'how']);

/** The language of what the person typed, for UI text only. English unless it reads as Spanish. */
export function detectLanguage(text: string): Language {
  if (ES_MARKS.test(text)) return 'es';
  const words = text.toLowerCase().match(/\p{L}+/gu) ?? [];
  const es = words.filter(word => ES_WORDS.has(word)).length;
  const en = words.filter(word => EN_WORDS.has(word)).length;
  return es > en ? 'es' : 'en';
}

/** Distinct masked values per category. Only hashes are kept, never the values. */
export function createTally() {
  const seen = new Map<Category, Set<string>>();
  const size = (): number => [...seen.values()].reduce((sum, values) => sum + values.size, 0);
  return {
    add(items: readonly Masked[]): void {
      for (const item of items) {
        const values = seen.get(item.category) ?? new Set<string>();
        values.add(createHash('sha256').update(item.value).digest('hex'));
        seen.set(item.category, values);
      }
    },
    size,
    counts: (): ReadonlyMap<Category, number> => new Map([...seen].map(([category, values]) => [category, values.size])),
    clear: (): void => { seen.clear(); },
  };
}

/** "Secrets obfuscated before sending to the model: 2 emails, 1 payment card." */
export function obfuscationNotice(counts: ReadonlyMap<Category, number>, language: Language): string {
  const parts = ORDER.flatMap(category => {
    const count = counts.get(category) ?? 0;
    return count ? [`${count} ${WORDS[language][category][count === 1 ? 0 : 1]}`] : [];
  });
  return `${LEAD[language]}: ${parts.join(', ')}.`;
}
