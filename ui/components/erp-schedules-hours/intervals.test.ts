// schedules#8 — the weekly hours are 0..N intervals per day, edited as the market does it
// (Google Business Profile «Add hours» per day, Fresha «add another shift», Square «add hours»):
// the seven days are always listed (no «add a day»), each day is edited in the side panel with a
// list of intervals, «+ add interval» and a remove button per interval, a «Closed» switch and an
// «Open 24 hours» shortcut. Saving REPLACES the day's intervals (`schedules.business_hours.set`
// with `intervals[]`); the list shows «10:00–14:00 · 17:00–20:00», «Closed», «Open 24 hours» or
// «Not set».
import { beforeEach, describe, expect, it } from 'vitest';

const commands: { name: string; payload: Record<string, unknown> }[] = [];

let hoursRows: Record<string, unknown>[] = [];

beforeEach(() => {
  commands.length = 0;
  hoursRows = [
    { id: 'm1', day_of_week: 0, position: 0, open_time: '10:00', close_time: '14:00', is_closed: 0, break_start: null, break_end: null },
    { id: 'm2', day_of_week: 0, position: 1, open_time: '17:00', close_time: '20:00', is_closed: 0, break_start: null, break_end: null },
    { id: 't1', day_of_week: 1, position: 0, open_time: '00:00', close_time: '00:00', is_closed: 0, break_start: null, break_end: null },
    { id: 's1', day_of_week: 6, position: 0, open_time: '00:00', close_time: '00:00', is_closed: 1, break_start: null, break_end: null },
  ];
  (globalThis as Record<string, unknown>).erplora = {
    query: async () => null,
    queryAll: async (name: string) => (name === 'schedules.business_hours.list' ? hoursRows : []),
    queryPage: async (name: string) => (name === 'schedules.business_hours.list' ? { rows: hoursRows, total: hoursRows.length } : { rows: [], total: 0 }),
    command: async (name: string, payload: Record<string, unknown>) => {
      commands.push({ name, payload });
      return {};
    },
    on: () => () => {},
    locale: 'en',
    t: (_catalog: unknown, key: string) => key,
  };
});

type Wc = HTMLElement & {
  shadowRoot: ShadowRoot;
  updateComplete: Promise<unknown>;
  bhDay: number;
  bhClosed: boolean;
  bhIntervals: { open_time: string; close_time: string }[];
  addInterval: () => void;
  removeInterval: (i: number) => void;
  setAllDay: () => void;
  saveBusinessHours: (e: Event) => Promise<void>;
  weekRows: Record<string, unknown>[];
};

async function mount(): Promise<Wc> {
  window.history.replaceState({}, '', '/m/schedules/hours');
  await import('./erp-schedules-hours');
  const el = document.createElement('erp-schedules-hours') as Wc;
  document.body.appendChild(el);
  await el.updateComplete;
  await new Promise((r) => setTimeout(r, 0));
  await el.updateComplete;
  return el;
}

const table = (el: Wc) => el.shadowRoot.querySelector('#tbl-hours') as (HTMLElement & { rows: Record<string, unknown>[]; addable: boolean; columns: { key: string; format?: (r: Record<string, unknown>) => string }[] }) | null;

describe('the seven days are always listed, with their intervals', () => {
  it('the table has one row per weekday, in order, and no «+» (there is no eighth day)', async () => {
    const el = await mount();
    const rows = table(el)!.rows;
    expect(rows.map((r) => r.day_of_week)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(table(el)!.addable).toBe(false);
  });

  it('formats split shifts, 24 h, closed and unset days', async () => {
    const el = await mount();
    const col = table(el)!.columns.find((c) => c.key === 'hours')!;
    const rows = table(el)!.rows;
    expect(col.format!(rows[0])).toBe('10:00–14:00 · 17:00–20:00');
    expect(col.format!(rows[1])).toBe('ui.open24h');
    expect(col.format!(rows[6])).toBe('ui.closed');
    expect(col.format!(rows[2])).toBe('ui.notSet');
  });
});

describe('editing a day: a list of intervals with add/remove, closed and 24 h', () => {
  it('the edit action loads the day\'s intervals into the panel', async () => {
    const el = await mount();
    table(el)!.dispatchEvent(new CustomEvent('rowAction', { detail: { actionId: 'edit', row: table(el)!.rows[0] } }));
    await el.updateComplete;
    expect(el.bhDay).toBe(0);
    expect(el.bhClosed).toBe(false);
    expect(el.bhIntervals).toEqual([
      { open_time: '10:00', close_time: '14:00' },
      { open_time: '17:00', close_time: '20:00' },
    ]);
    const inputs = el.shadowRoot.querySelectorAll('form[slot="create"] ion-input[type="time"]');
    expect(inputs.length, 'two intervals → four time inputs').toBe(4);
  });

  it('«+ add interval» appends one and the remove button drops it', async () => {
    const el = await mount();
    table(el)!.dispatchEvent(new CustomEvent('rowAction', { detail: { actionId: 'edit', row: table(el)!.rows[0] } }));
    await el.updateComplete;
    (el.shadowRoot.querySelector('form[slot="create"] [data-action="add-interval"]') as HTMLElement).click();
    await el.updateComplete;
    expect(el.bhIntervals.length).toBe(3);
    (el.shadowRoot.querySelectorAll('form[slot="create"] [data-action="remove-interval"]')[0] as HTMLElement).click();
    await el.updateComplete;
    expect(el.bhIntervals).toEqual([
      { open_time: '17:00', close_time: '20:00' },
      { open_time: '', close_time: '' },
    ]);
  });

  it('saving sends intervals[] (not open/close/break) and replaces the day', async () => {
    const el = await mount();
    el.bhDay = 3;
    el.bhClosed = false;
    el.bhIntervals = [
      { open_time: '10:00', close_time: '14:00' },
      { open_time: '17:00', close_time: '20:00' },
    ];
    await el.saveBusinessHours(new Event('submit'));
    expect(commands[0]).toEqual({
      name: 'schedules.business_hours.set',
      payload: { day_of_week: 3, is_closed: false, intervals: [{ open_time: '10:00', close_time: '14:00' }, { open_time: '17:00', close_time: '20:00' }] },
    });
  });

  it('a closed day sends is_closed without intervals; 24 h sends 00:00–00:00', async () => {
    const el = await mount();
    el.bhDay = 6;
    el.bhClosed = true;
    el.bhIntervals = [{ open_time: '10:00', close_time: '14:00' }];
    await el.saveBusinessHours(new Event('submit'));
    expect(commands[0].payload).toEqual({ day_of_week: 6, is_closed: true, intervals: [] });

    el.bhDay = 1;
    el.bhClosed = false;
    el.setAllDay();
    await el.saveBusinessHours(new Event('submit'));
    expect(commands[1].payload).toEqual({ day_of_week: 1, is_closed: false, intervals: [{ open_time: '00:00', close_time: '00:00' }] });
  });

  it('an open day with an incomplete interval is not sent and the error is explained', async () => {
    const el = await mount();
    el.bhDay = 2;
    el.bhClosed = false;
    el.bhIntervals = [{ open_time: '10:00', close_time: '' }];
    await el.saveBusinessHours(new Event('submit'));
    expect(commands).toEqual([]);
    expect((el as unknown as { formError: string }).formError).toBe('ui.errorHoursRequired');
  });
});
