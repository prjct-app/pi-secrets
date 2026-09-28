import { SYMBOL, ago, type PanelAction, type PanelItem, type PanelSpec } from '@prjct.app/pi-tui-kit';
import { tail } from './names.ts';
import { inScope, type Entry } from './vault.ts';

/** What the panel asks the extension to do once it has closed (prompts cannot open over it). */
export type SecretIntent =
  | { readonly action: 'create' }
  | { readonly action: 'replace'; readonly name: string };

export type SecretPanelOps = {
  readonly entries: () => readonly Entry[];
  /** The last characters of the value, or undefined when this process could not read it. */
  readonly value: (name: string) => string | undefined;
  readonly cwd: string;
  readonly project: string;
  readonly remove: (name: string) => Promise<void>;
  readonly rescope: (name: string, scope: Entry['scope']) => void;
  readonly request: (intent: SecretIntent) => void;
  readonly now?: () => number;
};

export const scopeText = (entry: Entry): string =>
  entry.scope === 'all' ? 'every project' : entry.scope.length === 1 ? '1 project' : `${entry.scope.length} projects`;

export function secretPanelSpec(ops: SecretPanelOps, initial?: string): PanelSpec {
  const entryOf = (item: PanelItem | undefined): Entry | undefined =>
    item ? ops.entries().find(entry => entry.name === item.id) : undefined;
  const shown = (entry: Entry): string => {
    const value = ops.value(entry.name);
    return value === undefined ? 'not in keychain' : tail(value);
  };
  const listed = (entry: Entry): boolean => entry.scope !== 'all' && entry.scope.includes(ops.project);
  const ask = (panel: { close(): void }, intent: SecretIntent): void => { panel.close(); ops.request(intent); };

  const actions: PanelAction[] = [
    { key: 'n', label: 'New secret', run: (_item, panel) => ask(panel, { action: 'create' }) },
    {
      key: 'r', label: item => `Replace ${item?.label ?? ''}`.trim(), when: item => !!entryOf(item),
      run: (item, panel) => ask(panel, { action: 'replace', name: entryOf(item)!.name }),
    },
    {
      key: 'a', label: item => listed(entryOf(item)!) ? 'Remove from this project' : 'Allow in this project',
      when: item => { const entry = entryOf(item); return !!entry && entry.scope !== 'all'; },
      run: (item, panel) => {
        const entry = entryOf(item)!;
        const roots = entry.scope === 'all' ? [] : entry.scope;
        const next = listed(entry) ? roots.filter(root => root !== ops.project) : [...roots, ops.project];
        ops.rescope(entry.name, next);
        panel.notice(listed(entry) ? `${entry.name} is no longer given to this project.` : `${entry.name} is now given to this project.`, 'success');
        panel.refresh();
      },
    },
    {
      key: 'g', label: item => entryOf(item)?.scope === 'all' ? 'Only this project' : 'Every project',
      when: item => !!entryOf(item),
      run: (item, panel) => {
        const entry = entryOf(item)!;
        ops.rescope(entry.name, entry.scope === 'all' ? [ops.project] : 'all');
        panel.notice(entry.scope === 'all' ? `${entry.name} is now given only to this project.` : `${entry.name} is now given to every project.`, 'success');
        panel.refresh();
      },
    },
    {
      key: 'x', label: item => `Delete ${item?.label ?? ''}`.trim(), confirm: true, when: item => !!entryOf(item),
      run: async (item, panel) => {
        const name = entryOf(item)!.name;
        await ops.remove(name);
        panel.notice(`${name} deleted from the keychain.`, 'success');
        panel.refresh();
      },
    },
  ];

  return {
    title: 'Secrets',
    summary: () => {
      const entries = ops.entries();
      const here = entries.filter(entry => inScope(entry, ops.cwd)).length;
      return `${entries.length} stored · ${here} available here`;
    },
    items: () => ops.entries().map(entry => {
      const available = inScope(entry, ops.cwd);
      return {
        id: entry.name,
        label: entry.name,
        symbol: available ? SYMBOL.active : SYMBOL.idle,
        tone: available ? 'accent' : 'dim',
        meta: shown(entry),
        search: `${entry.description ?? ''} ${available ? 'available' : 'unavailable'}`,
      } satisfies PanelItem;
    }),
    detail: item => {
      const entry = entryOf(item);
      if (!entry) return { title: item.label, subtitle: 'Deleted.' };
      const available = inScope(entry, ops.cwd);
      const now = ops.now?.() ?? Date.now();
      return {
        title: entry.name,
        subtitle: available ? `${SYMBOL.active} available here as $${entry.name}` : `${SYMBOL.idle} not given to this project`,
        subtitleTone: available ? 'accent' : 'muted',
        fields: [
          { label: 'value', value: shown(entry), tone: ops.value(entry.name) === undefined ? 'warning' : 'text' },
          { label: 'given to', value: scopeText(entry) },
          ...(entry.description ? [{ label: 'about', value: entry.description }] : []),
          { label: 'updated', value: ago(Date.parse(entry.updatedAt), now) },
          { label: 'created', value: ago(Date.parse(entry.createdAt), now) },
        ],
        sections: [
          ...(entry.scope === 'all' ? [] : [{ title: 'Projects', lines: [...entry.scope] }]),
          { title: 'How agents use it', lines: [
            `A bash command that mentions ${entry.name} gets $${entry.name} set; nothing else does.`,
            'The value is replaced by [secret:' + entry.name + '] in every output the model or the session sees.',
          ] },
        ],
      };
    },
    actions,
    empty: 'No secrets yet. Press n to add one; the value goes straight to the OS keychain.',
    initial,
  };
}
