import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { createPrivacyGuard } from './privacy.ts';

const ENTRY = 'pi-secrets-privacy';

/** Consent belongs to a session branch, not the lifetime of a loaded extension. */
export function sessionPrivacy(pi: ExtensionAPI): (ctx: ExtensionContext) => ReturnType<typeof createPrivacyGuard> {
  const current: { id?: string } = {};
  const guard = createPrivacyGuard({ onChange: snapshot => {
    if (current.id) pi.appendEntry(ENTRY, { sessionId: current.id, ...snapshot });
  } });
  const restore = (ctx: ExtensionContext): void => {
    current.id = ctx.sessionManager.getSessionId();
    const entry = ctx.sessionManager.getBranch().filter(item => item.type === 'custom' && item.customType === ENTRY).at(-1);
    const data: unknown = entry?.type === 'custom' ? entry.data : undefined;
    guard.restore(data && typeof data === 'object' && 'sessionId' in data && data.sessionId === current.id ? data : undefined);
  };
  pi.on('session_start', async (_event, ctx) => { restore(ctx); });
  pi.on('session_tree', async (_event, ctx) => { restore(ctx); });
  pi.on('session_shutdown', async () => { current.id = undefined; guard.restore(); });
  return ctx => {
    if (current.id !== ctx.sessionManager.getSessionId()) restore(ctx);
    return guard;
  };
}
