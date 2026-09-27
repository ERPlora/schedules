// schedules#23 — a special day and an override also carry 0..N intervals, edited with the SAME
// control the weekly hours use (schedules#8): a list of open/close pairs, «+ add interval» and a
// remove button per line. Until now an exception could only say ONE pair, so a holiday with a
// split shift (10–13 and 17–19) had to be declared as one wide 10–19 window — the business read as
// OPEN during the four hours it was shut. Google Business Profile allows several intervals in
// special hours; this brings the exceptions to the same level as the weekly editor.
import { beforeEach, describe, expect, it } from 'vitest';

const commands: { name: string; payload: Record<string, unknown> }[] = [];

let specialRows: Record<string, unknown>[] = [];

let overrideRows: Record<string, unknown>[] = [];

let intervalRows: Record<string, unknown>[] = [];

beforeEach(() => {
  commands.length = 0;
  specialRows = [
    // A holiday with a split shift: two interval rows point at it.
    { id: 'sd1', date: '2026-12-24', name: 'Christmas Eve', is_closed: 0, open_time: '10:00', close_time: '13:00', recurring_yearly: 0, notes: '' },
    // Written before migration 003 (or by the bulk): no interval rows, only its own pair.
    { id: 'sd2', date: '2026-01-06', name: 'Epiphany', is_closed: 0, open_time: '09:00', close_time: '14:00', recurring_yearly: 1, notes: '' },
    { id: 'sd3', date: '2026-12-25', name: 'Christmas', is_closed: 1, open_time: null, close_time: null, recurring_yearly: 1, notes: '' },
  ];
  overrideRows = [
    { id: 'ov1', start_date: '2026-08-01', end_date: '2026-08-31', reason: 'Summer', is_closed: 0, open_time: '10:00', close_time: '13:30' },
  ];
  intervalRows = [
    { id: 'i1', exception_kind: 'special_day', exception_id: 'sd1', position: 0, open_time: '10:00', close_time: '13:00' },
    { id: 'i2', exception_kind: 'special_day', exception_id: 'sd1', position: 1, open_time: '17:00', close_time: '19:00' },
    { id: 'i3', exception_kind: 'override', exception_id: 'ov1', position: 0, open_time: '10:00', close_time: '13:30' },
    { id: 'i4', exception_kind: 'override', exception_id: 'ov1', position: 1, open_time: '18:00', close_time: '21:00' },
  ];
  const page = (name: string) => {
    if (name === 'schedules.special_days.list') return { rows: specialRows, total: specialRows.length };
    if (name === 'schedules.overrides.list') return { rows: overrideRows, total: overrideRows.length };
    if (name === 'schedules.exception_intervals.list') return { rows: intervalRows, total: intervalRows.length };
    return { rows: [], total: 0 };
  };
  (globalThis as Record<string, unknown>).erplora = {
    query: async () => null,
    queryAll: async (name: string) => page(name).rows,
    queryPage: async (name: string) => page(name),
    command: async (name: string, payload: Record<string, unknown>) => {
      commands.push({ name, payload });
      return {};
    },
    on: () => () => {},
    locale: 'en',
    t: (_catalog: unknown, key: string) => key,
  };
});

type Interval = { open_time: string; close_time: string };

type Wc = HTMLElement & {
  shadowRoot: ShadowRoot;
  updateComplete: Promise<unknown>;
  sdClosed: boolean;
  sdDate: string;
  sdName: string;
  sdIntervals: Interval[];
  addSpecialDayInterval: () => void;
  removeSpecialDayInterval: (i: number) => void;
  createSpecialDay: (e: Event) => Promise<void>;
  ovClosed: boolean;
  ovStart: string;
  ovEnd: string;
  ovReason: string;
  ovIntervals: Interval[];
  addOverrideInterval: () => void;
  removeOverrideInterval: (i: number) => void;
  createOverride: (e: Event) => Promise<void>;
  specialFormError: string;
  overrideFormError: string;
};

async function mount(): Promise<Wc> {
  window.history.replaceState({}, '', '/m/schedules/special_days');
  await import('./erp-schedules-hours');
  const el = document.createElement('erp-schedules-hours') as Wc;
  document.body.appendChild(el);
  await el.updateComplete;
  await new Promise((r) => setTimeout(r, 0));
  await el.updateComplete;
  return el;
}

type Table = HTMLElement & {
  rows: Record<string, unknown>[];
  columns: { key: string; format?: (r: Record<string, unknown>) => string }[];
};

const table = (el: Wc, id: string) => el.shadowRoot.querySelector(`#${id}`) as Table;

describe('the list shows EVERY interval of the exception', () => {
  it('a special day with a split shift is not a single wide window', async () => {
    const el = await mount();
    const col = table(el, 'tbl-special').columns.find((c) => c.key === 'is_closed')!;
    expect(col.format!(specialRows[0])).toBe('10:00–13:00 · 17:00–19:00');
  });

  it('an exception with no interval rows still shows its own pair (pre-003 rows, bulk)', async () => {
    const el = await mount();
    const col = table(el, 'tbl-special').columns.find((c) => c.key === 'is_closed')!;
    expect(col.format!(specialRows[1])).toBe('09:00–14:00');
    expect(col.format!(specialRows[2])).toBe('ui.closed');
  });

  it('the overrides table folds its intervals the same way', async () => {
    const el = await mount();
    const col = table(el, 'tbl-override').columns.find((c) => c.key === 'is_closed')!;
    expect(col.format!(overrideRows[0])).toBe('10:00–13:30 · 18:00–21:00');
  });
});

describe('creating a special day with several intervals', () => {
  it('the panel shows the interval editor when the day is open, and none when closed', async () => {
    const el = await mount();
    el.sdClosed = true;
    await el.updateComplete;
    expect(el.shadowRoot.querySelectorAll('#tbl-special [data-action="add-interval"]').length).toBe(0);
    el.sdClosed = false;
    await el.updateComplete;
    expect(el.shadowRoot.querySelectorAll('#tbl-special [data-action="add-interval"]').length).toBe(1);
    expect(el.shadowRoot.querySelectorAll('#tbl-special form[slot="create"] ion-input[type="time"]').length).toBe(2);
  });

  it('«+ add interval» appends one and the remove button drops it', async () => {
    const el = await mount();
    el.sdClosed = false;
    await el.updateComplete;
    (el.shadowRoot.querySelector('#tbl-special [data-action="add-interval"]') as HTMLElement).click();
    await el.updateComplete;
    expect(el.sdIntervals.length).toBe(2);
    expect(el.shadowRoot.querySelectorAll('#tbl-special form[slot="create"] ion-input[type="time"]').length).toBe(4);
    (el.shadowRoot.querySelectorAll('#tbl-special [data-action="remove-interval"]')[0] as HTMLElement).click();
    await el.updateComplete;
    expect(el.sdIntervals.length).toBe(1);
  });

  it('saving an open day sends intervals[] with every one of them', async () => {
    const el = await mount();
    el.sdDate = '2026-12-24';
    el.sdName = 'Christmas Eve';
    el.sdClosed = false;
    el.sdIntervals = [
      { open_time: '10:00', close_time: '13:00' },
      { open_time: '17:00', close_time: '19:00' },
    ];
    await el.createSpecialDay(new Event('submit'));
    expect(commands[0].name).toBe('schedules.special_days.create');
    expect(commands[0].payload.intervals).toEqual([
      { open_time: '10:00', close_time: '13:00' },
      { open_time: '17:00', close_time: '19:00' },
    ]);
    // The pair keeps travelling as the FIRST interval, so nothing that reads it breaks.
    expect(commands[0].payload.open_time).toBe('10:00');
    expect(commands[0].payload.close_time).toBe('13:00');
  });

  it('a closed day sends no intervals at all', async () => {
    const el = await mount();
    el.sdDate = '2026-12-25';
    el.sdName = 'Christmas';
    el.sdClosed = true;
    el.sdIntervals = [{ open_time: '10:00', close_time: '13:00' }];
    await el.createSpecialDay(new Event('submit'));
    expect(commands[0].payload.intervals).toEqual([]);
    expect(commands[0].payload.open_time).toBe(null);
  });

  it('an incomplete interval is not sent and the error is explained', async () => {
    const el = await mount();
    el.sdDate = '2026-12-24';
    el.sdName = 'Christmas Eve';
    el.sdClosed = false;
    el.sdIntervals = [{ open_time: '10:00', close_time: '' }];
    await el.createSpecialDay(new Event('submit'));
    expect(commands).toEqual([]);
    expect(el.specialFormError).toBe('ui.errorHoursRequired');
  });
});

describe('creating an override with several intervals', () => {
  it('saving an open override sends intervals[]', async () => {
    const el = await mount();
    el.ovStart = '2026-08-01';
    el.ovEnd = '2026-08-31';
    el.ovReason = 'Summer';
    el.ovClosed = false;
    el.ovIntervals = [
      { open_time: '10:00', close_time: '13:30' },
      { open_time: '18:00', close_time: '21:00' },
    ];
    await el.createOverride(new Event('submit'));
    expect(commands[0].name).toBe('schedules.overrides.create');
    expect(commands[0].payload.intervals).toEqual([
      { open_time: '10:00', close_time: '13:30' },
      { open_time: '18:00', close_time: '21:00' },
    ]);
    expect(commands[0].payload.open_time).toBe('10:00');
  });

  it('the override panel has its own interval editor, independent of the special day one', async () => {
    const el = await mount();
    el.ovClosed = false;
    await el.updateComplete;
    (el.shadowRoot.querySelector('#tbl-override [data-action="add-interval"]') as HTMLElement).click();
    await el.updateComplete;
    expect(el.ovIntervals.length).toBe(2);
    expect(el.sdIntervals.length, 'the special day editor is untouched').toBe(1);
  });

  it('a closed override sends no intervals and an incomplete one is refused', async () => {
    const el = await mount();
    el.ovStart = '2026-08-01';
    el.ovEnd = '2026-08-31';
    el.ovReason = 'Holidays';
    el.ovClosed = true;
    await el.createOverride(new Event('submit'));
    expect(commands[0].payload.intervals).toEqual([]);

    // A successful create empties the form, so the refused one has to fill it again.
    el.ovStart = '2026-09-01';
    el.ovEnd = '2026-09-30';
    el.ovReason = 'Autumn';
    el.ovClosed = false;
    el.ovIntervals = [{ open_time: '', close_time: '21:00' }];
    await el.createOverride(new Event('submit'));
    expect(commands.length).toBe(1);
    expect(el.overrideFormError).toBe('ui.errorHoursRequired');
  });
});
