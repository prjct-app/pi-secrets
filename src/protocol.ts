/** Preserve provider protocol fields and opaque binary/signature data. No image OCR. */
const OPAQUE = new Set(['signature', 'thoughtSignature', 'thinkingSignature', 'encrypted_content', 'mimeType', 'type', 'role', 'call_id', 'tool_call_id', 'toolCallId', 'response_id', 'previous_response_id', 'model', 'provider', 'api']);
export function mapText<T>(value: T, transform: (text: string) => string): T {
  if (typeof value === 'string') return transform(value) as T;
  if (Array.isArray(value)) return value.map(item => mapText(item, transform)) as T;
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const record = value as Record<string, unknown>;
    if ((record.type === 'reasoning' || record.type === 'compaction') && typeof record.encrypted_content === 'string') return value;
    if (record.type === 'thinking' && [record.thinkingSignature, record.thoughtSignature, record.signature].some(item => typeof item === 'string')) return value;
    if (record.type === 'image' || record.type === 'image_url' || record.type === 'input_image') return value;
    return Object.fromEntries(Object.entries(record).map(([key, item]) => [key, OPAQUE.has(key) || ((key === 'id' || key === 'item_id') && typeof item === 'string' && /^(?:rs|resp|msg|fc|call|comp|item)_[A-Za-z0-9_-]+$/.test(item)) ? item : mapText(item, transform)])) as T;
  }
  return value;
}
