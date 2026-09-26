// pm#450 — editing a weekday titles the side panel as an EDIT, not as «New».
//
// The seven weekdays are fixed rows (schedules#8): the hours panel only ever opens to EDIT a day,
// yet it opened with `open('create')`, so its header read «Nuevo» over a form pre-filled with
// Monday's hours. OutfitKit ≥ 0.1.94 (outfitkit#150) takes `open('edit', { title })` and paints
// that title in the header (and as the dialog's aria-label).
//
// Older shells (hub:stable ships OutfitKit 0.1.73) ignore the title and paint `labels.newRecord`
// for any non-filters panel, `edit` included — so the screen also passes the SAME title as
// `newRecord` (the staff#68 fallback). The table merges `.labels` over its own defaults, so only
// that one label is overridden. This screen has no «Editing …» line in the body to remove.
import { beforeEach, describe, expect, it } from 'vitest';
import esLocale from '../../../locales/es.json';
import enLocale from '../../../locales/en.json';

const hoursRows = [
  { id: 'm1', day_of_week: 0, position: 0, open_time: '10:00', close_time: '14:00', is_closed: 0, break_start: null, break_end: null },
  { id: 'w1', day_of_week: 2, position: 0, open_time: '09:00', close_time: '18:00', is_closed: 0, break_start: null, break_end: null },
];

const lookup = (catalog: Record<string, unknown>, key: string): string => {
  const hit = key.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], catalog);
  return typeof hit === 'string' ? hit : key;
};

beforeEach(() => {
  (globalThis as Record<string, unknown>).erplora = {
    query: async () => null,
    queryAll: async (name: string) => (name === 'schedules.business_hours.list' ? hoursRows : []),
    queryPage: async (name: string) =>
      name === 'schedules.business_hours.list' ? { rows: hoursRows, total: hoursRows.length } : { rows: [], total: 0 },
    command: async () => ({}),
    on: () => () => {},
    locale: 'es',
    t: (catalog: Record<string, Record<string, unknown>>, key: string) => lookup(catalog.es, key),
  };
});

type Table = HTMLElement & {
  labels: Record<string, string>;
  open: (panel?: unknown, opts?: { title?: string }) => void;
};
type Screen = HTMLElement & { tab: string; updateComplete: Promise<unknown>; shadowRoot: ShadowRoot };

async function mount(): Promise<{ el: Screen; table: Table; opens: { panel: unknown; opts?: { title?: string } }[] }> {
  await import('./erp-schedules-hours');
  const el = document.createElement('erp-schedules-hours') as Screen;
  document.body.appendChild(el);
  await el.updateComplete;
  await new Promise((r) => setTimeout(r, 0));
  el.tab = 'hours';
  await el.updateComplete;
  const table = el.shadowRoot.querySelector('#tbl-hours') as Table;
  const opens: { panel: unknown; opts?: { title?: string } }[] = [];
  table.open = (panel?: unknown, opts?: { title?: string }) => {
    opens.push({ panel, opts });
  };
  return { el, table, opens };
}

const editRow = async (el: Screen, table: Table, day: number) => {
  const row = hoursRows.find((r) => r.day_of_week === day) ?? { day_of_week: day };
  table.dispatchEvent(new CustomEvent('rowAction', { detail: { actionId: 'edit', row } }));
  await el.updateComplete;
};

describe('editing a weekday titles the panel header, not «New» (pm#450)', () => {
  it('opens the panel in edit mode with the day in the title', async () => {
    const { el, table, opens } = await mount();
    await editRow(el, table, 0);
    expect(opens).toEqual([{ panel: 'edit', opts: { title: 'Editar horario — Lunes' } }]);
  });

  it('clicking the row opens the same edit title', async () => {
    const { el, table, opens } = await mount();
    table.dispatchEvent(new CustomEvent('rowClick', { detail: { row: hoursRows[1] } }));
    await el.updateComplete;
    expect(opens).toEqual([{ panel: 'edit', opts: { title: 'Editar horario — Miércoles' } }]);
  });

  it('an older shell paints the same title through newRecord, and ONLY newRecord changes', async () => {
    const { el, table } = await mount();
    await editRow(el, table, 2);
    expect(table.labels).toEqual({ newRecord: 'Editar horario — Miércoles' });
  });

  it('changing the day inside the panel re-titles it in both shells', async () => {
    const { el, table, opens } = await mount();
    await editRow(el, table, 0);
    const select = el.shadowRoot.querySelector('[data-testid="schedules-hours-day"]') as HTMLElement & { value: unknown };
    select.value = 4;
    select.dispatchEvent(new CustomEvent('ionChange', { bubbles: true, composed: true }));
    await el.updateComplete;
    expect(opens.at(-1)).toEqual({ panel: 'edit', opts: { title: 'Editar horario — Viernes' } });
    expect(table.labels.newRecord).toBe('Editar horario — Viernes');
  });

  it('the title string exists in en and es with its {day} placeholder', () => {
    expect((enLocale as { ui: Record<string, string> }).ui.editDayTitle).toBe('Edit hours — {day}');
    expect((esLocale as { ui: Record<string, string> }).ui.editDayTitle).toBe('Editar horario — {day}');
  });
});
