// A split special day must not read as a single span when its intervals could not be read
// (schedules#63, from schedules#60).
//
// The two exception tables (special days, temporary changes) fold every exception's intervals
// from `schedules.exception_intervals.list` (schedules#23). That read swallowed ANY failure into
// «no intervals», so each row fell back to its legacy open/close pair — only the FIRST span — and a
// day open 10:00–14:00 · 17:00–20:00 showed as 10:00–14:00, with no notice and no way back: the
// person reads that the afternoon is gone. The query and its migration ship in the same package as
// this screen (schedules#23), so a failure is the hub not answering, never an older hub.
//
// Now the failure is the tables' own error (the shell's `<ok-data-table>` paints the reason and
// Retry), their rows stay out until the intervals are read, and on a shell whose table cannot
// paint the error a single banner says it — once, not on top of a list banner with the same reason.
//
// The shell's table is stood in for by a bare element registered BEFORE the screen loads; its
// `error` property is added or removed per test, which is what `dataTableShowsLoadError()` reads.
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import esLocale from '../../locales/es.json';
import enLocale from '../../locales/en.json';

class ShellTable extends HTMLElement {}
const errors = new WeakMap<HTMLElement, unknown>();

function shellTableKnowsErrors(yes: boolean) {
  if (yes) {
    Object.defineProperty(ShellTable.prototype, 'error', {
      configurable: true,
      get(this: HTMLElement) { return errors.get(this) ?? ''; },
      set(this: HTMLElement, v: unknown) { errors.set(this, v); },
    });
  } else {
    delete (ShellTable.prototype as { error?: unknown }).error;
  }
}

const TAG = 'erp-schedules-hours';
const REASON = 'The hub is not responding.';
const INTERVALS = 'schedules.exception_intervals.list';
const SPECIAL = 'schedules.special_days.list';
const OVERRIDE = 'schedules.overrides.list';

// A holiday with a split shift and a summer change with a split shift: the pair on each row is only
// its FIRST span, the second lives in the interval rows.
const SPECIAL_ROWS = [
  { id: 'sd1', date: '2026-12-24', name: 'Christmas Eve', is_closed: 0, open_time: '10:00', close_time: '14:00', recurring_yearly: 0, notes: '' },
];
const OVERRIDE_ROWS = [
  { id: 'ov1', start_date: '2026-08-01', end_date: '2026-08-31', reason: 'Summer', is_closed: 0, open_time: '09:00', close_time: '13:00' },
];
const INTERVAL_ROWS = [
  { id: 'i1', exception_kind: 'special_day', exception_id: 'sd1', position: 0, open_time: '10:00', close_time: '14:00' },
  { id: 'i2', exception_kind: 'special_day', exception_id: 'sd1', position: 1, open_time: '17:00', close_time: '20:00' },
  { id: 'i3', exception_kind: 'override', exception_id: 'ov1', position: 0, open_time: '09:00', close_time: '13:00' },
  { id: 'i4', exception_kind: 'override', exception_id: 'ov1', position: 1, open_time: '16:00', close_time: '19:00' },
];

/** The queries the hub does not answer right now. */
let failing = new Set<string>();
/** What the interval query answers when it does answer. */
let intervalRows: Record<string, unknown>[] = INTERVAL_ROWS;
let queryCalls: string[] = [];
let commandCalls: string[] = [];
/** When set, the interval query waits for this before answering (the loading state). */
let intervalsGate: Promise<void> | null = null;

beforeAll(async () => {
  customElements.define('ok-data-table', ShellTable);
  await import('../components/erp-schedules-hours/erp-schedules-hours');
});

beforeEach(() => {
  window.history.replaceState({}, '', '/m/schedules/special_days');
  document.body.innerHTML = '';
  failing = new Set([INTERVALS]);
  intervalRows = INTERVAL_ROWS;
  queryCalls = [];
  commandCalls = [];
  intervalsGate = null;
  const answer = async (name: string) => {
    queryCalls.push(name);
    if (name === INTERVALS && intervalsGate) await intervalsGate;
    if (failing.has(name)) throw new Error(REASON);
    return name === INTERVALS ? intervalRows : [];
  };
  (globalThis as Record<string, unknown>).erplora = {
    query: answer,
    queryOptional: answer,
    queryAll: answer,
    queryPage: async (name: string) => {
      queryCalls.push(name);
      if (failing.has(name)) throw new Error(REASON);
      if (name === SPECIAL) return { rows: SPECIAL_ROWS, total: SPECIAL_ROWS.length };
      if (name === OVERRIDE) return { rows: OVERRIDE_ROWS, total: OVERRIDE_ROWS.length };
      return { rows: [], total: 0 };
    },
    command: async (name: string) => {
      commandCalls.push(name);
      return {};
    },
    hasPermission: () => true,
    on: () => () => {},
    locale: 'en',
    t: (_catalog: unknown, key: string) => key,
    currency: 'EUR',
    currencyDecimals: 2,
    formatMoney: (cents: number) => `${(cents / 100).toFixed(2)} €`,
  };
});

type Screen = HTMLElement & { shadowRoot: ShadowRoot; updateComplete: Promise<unknown> };
type Column = { key: string; format?: (r: Record<string, unknown>) => string };
type Table = HTMLElement & { error?: string; rows: Record<string, unknown>[]; emptyMessage: string; columns: Column[] };

const intervalsAsked = () => queryCalls.filter((n) => n === INTERVALS).length;

async function settle(el: Screen): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await el.updateComplete;
    await new Promise((r) => setTimeout(r, 0));
  }
}

async function mount(path = '/m/schedules/special_days'): Promise<Screen> {
  window.history.replaceState({}, '', path);
  const el = document.createElement(TAG) as Screen;
  document.body.appendChild(el);
  await vi.waitFor(() => {
    if (!intervalsAsked()) throw new Error('the exception intervals have not been asked for yet');
  });
  await settle(el);
  return el;
}

const TABLES = [
  { table: 'schedules-special-table', rows: SPECIAL_ROWS, split: '10:00 AM–02:00 PM · 05:00 PM–08:00 PM' },
  { table: 'schedules-override-table', rows: OVERRIDE_ROWS, split: '09:00 AM–01:00 PM · 04:00 PM–07:00 PM' },
] as const;

const tableOf = (el: Screen, testid: string): Table => {
  const table = el.shadowRoot.querySelector<Table>(`ok-data-table[testid="${testid}"]`);
  expect(table, `Special days paints ${testid}`).toBeTruthy();
  return table!;
};

/** What the hours column paints for a row (the text without its invisible direction marks). */
const hoursOf = (table: Table, row: Record<string, unknown>): string =>
  table.columns.find((c) => c.key === 'is_closed')!.format!(row).replace(/[‎‏⁦-⁩]/g, '').replace(/ /g, ' ');

/** Every red notice on the page (outside the panel forms), whatever its testid (rv-schedules-61). */
const pageBanners = (el: Screen): Element[] =>
  [...el.shadowRoot.querySelectorAll('ok-inline-feedback[tone="danger"]')].filter((b) => !b.closest('form[slot="create"]'));

/** How many places on the page say the reason: red notices plus tables that paint it. */
const timesSaid = (el: Screen): number =>
  pageBanners(el).filter((b) => b.textContent?.includes(REASON)).length +
  [...el.shadowRoot.querySelectorAll<Table>('ok-data-table')].filter((t) => t.error === REASON).length;

describe(`${TAG} — the exceptions' intervals could not load (schedules#63)`, () => {
  it.each(TABLES)('hands the reason to $table', async (s) => {
    shellTableKnowsErrors(true);
    const el = await mount();
    expect(tableOf(el, s.table).error).toBe(REASON);
  });

  it.each(TABLES)('$table never shows a split exception as its first span alone', async (s) => {
    shellTableKnowsErrors(true);
    const el = await mount();
    expect(tableOf(el, s.table).rows, 'a row would read as the first span only, as if saved that way').toEqual([]);
  });

  it('paints no red banner on top of the tables that already say it', async () => {
    shellTableKnowsErrors(true);
    const el = await mount();
    expect(pageBanners(el)).toEqual([]);
  });

  it.each(TABLES)('Retry on $table reads the intervals again and both tables paint every span', async (s) => {
    shellTableKnowsErrors(true);
    const el = await mount();
    const before = intervalsAsked();
    failing = new Set();
    tableOf(el, s.table).dispatchEvent(new CustomEvent('retry', { detail: {} }));
    await vi.waitFor(async () => {
      await el.updateComplete;
      if (TABLES.some((t) => tableOf(el, t.table).error !== '')) throw new Error('an error is still on a table');
    });
    expect(intervalsAsked()).toBeGreaterThan(before);
    for (const t of TABLES) {
      const table = tableOf(el, t.table);
      expect(table.rows).toHaveLength(1);
      expect(hoursOf(table, table.rows[0])).toBe(t.split);
    }
    expect(pageBanners(el)).toEqual([]);
  });

  it.each(TABLES)('Retry on $table only READS: it sends no command and opens no confirmation', async (s) => {
    shellTableKnowsErrors(true);
    const el = await mount();
    failing = new Set();
    tableOf(el, s.table).dispatchEvent(new CustomEvent('retry', { detail: {} }));
    await settle(el);
    expect(commandCalls).toEqual([]);
    expect((el.shadowRoot.querySelector('ion-alert') as { isOpen?: boolean } | null)?.isOpen ?? false).toBe(false);
  });

  it('a hub with no interval rows at all is not a failure: each exception keeps its own pair', async () => {
    shellTableKnowsErrors(true);
    failing = new Set();
    intervalRows = [];
    const el = await mount();
    const table = tableOf(el, 'schedules-special-table');
    expect(table.error).toBe('');
    expect(table.rows).toHaveLength(1);
    expect(hoursOf(table, table.rows[0])).toBe('10:00 AM–02:00 PM');
    expect(pageBanners(el)).toEqual([]);
  });

  it('a re-read that fails after a good one takes the rows out again (a new split day would read as one span)', async () => {
    shellTableKnowsErrors(true);
    failing = new Set();
    const el = await mount();
    const special = tableOf(el, 'schedules-special-table');
    expect(special.rows).toHaveLength(1);
    failing = new Set([INTERVALS]);
    special.dispatchEvent(new CustomEvent('retry', { detail: {} }));
    await vi.waitFor(async () => {
      await el.updateComplete;
      if (special.error !== REASON) throw new Error('the failed re-read is not on the table');
    });
    for (const t of TABLES) {
      const table = tableOf(el, t.table);
      expect(table.error).toBe(REASON);
      expect(table.rows).toEqual([]);
    }
  });

  it('with the intervals read and no exceptions at all, each table says it has none', async () => {
    shellTableKnowsErrors(true);
    failing = new Set();
    const el = await mount();
    const answerNothing = async () => ({ rows: [], total: 0 });
    (globalThis as { erplora: { queryPage: unknown } }).erplora.queryPage = answerNothing;
    for (const t of TABLES) tableOf(el, t.table).dispatchEvent(new CustomEvent('retry', { detail: {} }));
    await settle(el);
    expect(tableOf(el, 'schedules-special-table').emptyMessage).toBe('ui.emptySpecialDays');
    expect(tableOf(el, 'schedules-override-table').emptyMessage).toBe('ui.emptyOverrides');
  });

  it('while the intervals are on their way, says «Loading…» instead of first spans', async () => {
    shellTableKnowsErrors(true);
    failing = new Set();
    let open!: () => void;
    intervalsGate = new Promise<void>((r) => (open = r));
    const el = await mount();
    for (const t of TABLES) {
      const table = tableOf(el, t.table);
      expect(table.rows, `${t.table} would show a first span as the whole day`).toEqual([]);
      expect(table.emptyMessage).toBe('ui.loading');
    }
    open();
    await vi.waitFor(async () => {
      await el.updateComplete;
      if (tableOf(el, 'schedules-special-table').rows.length !== 1) throw new Error('the intervals have not arrived');
    });
    for (const t of TABLES) {
      const table = tableOf(el, t.table);
      expect(hoursOf(table, table.rows[0])).toBe(t.split);
    }
  });

  it('on a shell whose table cannot paint the error, says it once on Special days, outside any panel', async () => {
    shellTableKnowsErrors(false);
    const el = await mount();
    const banners = pageBanners(el);
    expect(banners.map((b) => b.getAttribute('data-testid'))).toEqual(['schedules-error-intervals']);
    expect(banners[0].textContent).toContain(REASON);
    expect(banners[0].closest('[slot="create"]')).toBeNull();
    for (const t of TABLES) {
      const table = tableOf(el, t.table);
      expect(table.rows).toEqual([]);
      expect(table.emptyMessage, '«No special days» would be a lie').toBe('ui.exceptionHoursLoadFailed');
    }
  });

  it('on an older shell with the lists down too, the intervals add no banner repeating their reason', async () => {
    shellTableKnowsErrors(false);
    failing = new Set([INTERVALS, SPECIAL, OVERRIDE]);
    const el = await mount();
    const ids = pageBanners(el).map((b) => b.getAttribute('data-testid'));
    expect(ids).not.toContain('schedules-error-intervals');
    expect(ids).toEqual(['schedules-error-special', 'schedules-error-override']);
  });

  it.each([
    { list: SPECIAL, banner: 'schedules-error-special' },
    { list: OVERRIDE, banner: 'schedules-error-override' },
  ])('on an older shell with $list down too, the reason is said once, not again for the intervals', async ({ list, banner }) => {
    shellTableKnowsErrors(false);
    failing = new Set([INTERVALS, list]);
    const el = await mount();
    expect(pageBanners(el).map((b) => b.getAttribute('data-testid'))).toEqual([banner]);
  });

  it('with the intervals read but the lists still on their way, each table says «Loading…», never «none»', async () => {
    shellTableKnowsErrors(true);
    failing = new Set();
    let open!: () => void;
    const listsGate = new Promise<void>((r) => (open = r));
    const erp = (globalThis as { erplora: { queryPage: (name: string) => Promise<unknown> } }).erplora;
    const answerPage = erp.queryPage;
    erp.queryPage = async (name: string) => {
      await listsGate;
      return answerPage(name);
    };
    const el = await mount();
    for (const t of TABLES) {
      expect(tableOf(el, t.table).emptyMessage, `${t.table} would say it has none while its list loads`).toBe('ui.loading');
    }
    open();
    await vi.waitFor(async () => {
      await el.updateComplete;
      if (tableOf(el, 'schedules-special-table').rows.length !== 1) throw new Error('the lists have not arrived');
    });
  });

  it('on the tables that paint errors, with everything down, the reason is said once per table and nowhere else', async () => {
    shellTableKnowsErrors(true);
    failing = new Set([INTERVALS, SPECIAL, OVERRIDE]);
    const el = await mount();
    expect(pageBanners(el)).toEqual([]);
    expect(timesSaid(el)).toBe(2);
  });

  it.each([
    ['hours', true],
    ['hours', false],
    ['settings', true],
    ['settings', false],
  ] as const)('on the %s tab (table paints errors: %s), the intervals\' failure paints no banner', async (tab, knows) => {
    shellTableKnowsErrors(knows);
    const el = await mount(`/m/schedules/${tab}`);
    expect(pageBanners(el)).toEqual([]);
  });
});

describe(`${TAG} — the exceptions' load states speak both languages (schedules#63)`, () => {
  it.each(['exceptionHoursLoadFailed', 'loading', 'emptySpecialDays', 'emptyOverrides'])(
    'ui.%s is in the English source and translated into Spanish',
    (key) => {
      const en = (enLocale as { ui: Record<string, string> }).ui[key];
      const es = (esLocale as { ui: Record<string, string> }).ui[key];
      expect(en, `en ui.${key}`).toBeTruthy();
      expect(es, `es ui.${key}`).toBeTruthy();
      expect(es, `es ui.${key} is still the English text`).not.toBe(en);
    },
  );
});
