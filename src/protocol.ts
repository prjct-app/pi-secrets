/** Preserve provider protocol fields and opaque binary/signature data. No image OCR. */
const OPAQUE = new Set(['signature', 'thoughtSignature', 'thinkingSignature', 'encrypted_content', 'mimeType', 'type', 'role', 'call_id', 'tool_call_id', 'toolCallId', 'response_id', 'previous_response_id', 'model', 'provider', 'api']);
export function mapText<T>(value: T, transform: (text: string) => string): T {
  if (typeof value === 'string') return transform(value) as T;
  if (Array.isArray(value)) {
    const state: { copy?: unknown[] } = {};
    value.forEach((item, index) => {
      const next = mapText(item, transform);
      if (next !== item) { state.copy ??= value.slice(); state.copy[index] = next; }
    });
    return (state.copy ?? value) as T;
  }
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const record = value as Record<string, unknown>;
    if ((record.type === 'reasoning' || record.type === 'compaction') && typeof record.encrypted_content === 'string') return value;
    if (record.type === 'thinking' && [record.thinkingSignature, record.thoughtSignature, record.signature].some(item => typeof item === 'string')) return value;
    if (record.type === 'image' || record.type === 'image_url' || record.type === 'input_image') return value;
    const state: { copy?: Record<string, unknown> } = {};
    for (const [key, item] of Object.entries(record)) {
      if (OPAQUE.has(key) || ((key === 'id' || key === 'item_id') && typeof item === 'string' && /^(?:rs|resp|msg|fc|call|comp|item)_[A-Za-z0-9_-]+$/.test(item))) continue;
      const next = mapText(item, transform);
      if (next !== item) { state.copy ??= { ...record }; Object.defineProperty(state.copy, key, { value: next, writable: true, enumerable: true, configurable: true }); }
    }
    return (state.copy ?? value) as T;
  }
  return value;
}
