// schedules#10 — the screen and the MANIFEST must agree about what the server accepts.
//
// The list engine of the runtime is generic and CLOSED: it sorts only by a column the query's
// `list.sort` whitelists, filters only by a declared filter, and searches only when `list.search`
// exists. A column the table offers as sortable or filterable but the manifest does not declare is
// not a degraded feature — the request is refused and the user sees an error where they expected
// rows. Nothing in the module caught that: the component tests mock the SDK, so the browser and the
// manifest could drift apart forever and stay green.
//
// So this file checks the two against each other: the params the component really sends to
// `queryPage`, and `module.json` itself.
import { beforeEach, describe, expect, it } from 'vitest';
import manifest from '../../../module.json';

type ListBlock = {
  sort?: string[];
  search?: string[];
  filters?: Record<string, { op: string }>;
  page_size?: number;
  default_sort?: string;
  default_dir?: string;
};

const listOf = (query: string): ListBlock =>
  ((manifest as { queries: Record<string, { list?: ListBlock }> }).queries[query].list ?? {});

const pages: { name: string; params: Record<string, unknown> }[] = [];

const alls: { name: string; params: Record<string, unknown> }[] = [];

beforeEach(() => {
  pages.length = 0;
  alls.length = 0;
  (globalThis as Record<string, unknown>).erplora = {
    query: async () => null,
    queryAll: async (name: string, params: Record<string, unknown>) => {
      alls.push({ name, params });
      return [];
    },
    queryPage: async (name: string, params: Record<string, unknown>) => {
      pages.push({ name, params });
      return { rows: [], total: 0 };
    },
    command: async () => ({}),
    on: () => () => {},
    locale: 'en',
    t: (_catalog: unknown, key: string) => key,
  };
});

type Wc = HTMLElement & {
  shadowRoot: ShadowRoot;
  updateComplete: Promise<unknown>;
};

type Table = HTMLElement & {
  serverSide: boolean;
  pageSize: number;
  searchable: boolean;
  columns: { key: string; sortable?: boolean; filterable?: boolean; filterType?: string }[];
};

async function mount(path = '/m/schedules/special_days'): Promise<Wc> {
  window.history.replaceState({}, '', path);
  await import('./erp-schedules-hours');
  const el = document.createElement('erp-schedules-hours') as Wc;
  document.body.appendChild(el);
  await el.updateComplete;
  await new Promise((r) => setTimeout(r, 0));
  await el.updateComplete;
  return el;
}

const table = (el: Wc, id: string) => el.shadowRoot.querySelector(`#${id}`) as Table;

const CASES = [
  { id: 'tbl-special', query: 'schedules.special_days.list' },
  { id: 'tbl-override', query: 'schedules.overrides.list' },
] as const;

describe('the tables only offer what the manifest lets the runtime do', () => {
  for (const { id, query } of CASES) {
    it(`${id}: every sortable column is whitelisted in ${query}`, async () => {
      const el = await mount();
      const declared = listOf(query).sort ?? [];
      const offered = table(el, id).columns.filter((c) => c.sortable).map((c) => c.key);
      expect(offered.length, 'a table with no sortable column is not a contract worth checking').toBeGreaterThan(0);
      expect(offered.filter((k) => !declared.includes(k))).toEqual([]);
    });

    it(`${id}: every filterable column is a declared filter of ${query}`, async () => {
      const el = await mount();
      const declared = Object.keys(listOf(query).filters ?? {});
      const offered = table(el, id).columns.filter((c) => c.filterable).map((c) => c.key);
      expect(offered.length).toBeGreaterThan(0);
      expect(offered.filter((k) => !declared.includes(k))).toEqual([]);
    });

    it(`${id}: search is only offered because ${query} declares a search column`, async () => {
      const el = await mount();
      const declaresSearch = (listOf(query).search ?? []).length > 0;
      expect(table(el, id).searchable).toBe(declaresSearch);
    });
  }
});

describe('the pages the component asks for are the ones the manifest describes', () => {
  it('both lists load server-side, with the declared page size and default sort', async () => {
    const el = await mount();
    for (const { id, query } of CASES) {
      const block = listOf(query);
      expect(table(el, id).serverSide, `${id} must page on the server`).toBe(true);
      const asked = pages.find((p) => p.name === query);
      expect(asked, `${query} was never requested`).toBeTruthy();
      expect(asked!.params.limit).toBe(block.page_size);
      expect(asked!.params.offset).toBe(0);
      expect(asked!.params.sort).toBe(block.default_sort);
      expect(asked!.params.dir).toBe(block.default_dir);
    }
  });

  it('the weekly hours and the exception intervals are read WHOLE, never a page', async () => {
    // Folding needs every row: a page of 50 would silently drop a day's later intervals.
    await mount('/m/schedules/hours');
    const names = alls.map((a) => a.name);
    expect(names).toContain('schedules.business_hours.list');
    expect(names).toContain('schedules.exception_intervals.list');
    expect(pages.map((p) => p.name)).not.toContain('schedules.business_hours.list');
    expect(pages.map((p) => p.name)).not.toContain('schedules.exception_intervals.list');
  });
});

describe('sorting, filtering and searching travel to the SERVER', () => {
  it('a sort change re-asks the runtime instead of reordering in the browser', async () => {
    const el = await mount();
    pages.length = 0;
    table(el, 'tbl-special').dispatchEvent(new CustomEvent('sortChange', { detail: { sort: 'date', dir: 'desc' } }));
    await new Promise((r) => setTimeout(r, 0));
    const asked = pages.find((p) => p.name === 'schedules.special_days.list');
    expect(asked!.params.sort).toBe('date');
    expect(asked!.params.dir).toBe('desc');
    expect(asked!.params.offset, 'a new sort goes back to the first page').toBe(0);
  });

  it('a filter and a search travel as declared params', async () => {
    const el = await mount();
    pages.length = 0;
    table(el, 'tbl-special').dispatchEvent(new CustomEvent('filterChange', { detail: { col: 'is_closed', value: '1' } }));
    table(el, 'tbl-special').dispatchEvent(new CustomEvent('searchChange', { detail: 'christmas' }));
    await new Promise((r) => setTimeout(r, 0));
    const last = pages.filter((p) => p.name === 'schedules.special_days.list').pop()!;
    expect((last.params.filters as Record<string, unknown>).is_closed).toBe('1');
    expect(last.params.search).toBe('christmas');
  });
});

// The SINGLETON shape, which the rest of this file could not check: `schedules.settings.get` is a
// plain SQL query, so the runtime answers a ROW ARRAY — `[row]` — never the bare object. The screen
// used to assign that array straight into `this.settings`, so every control on the settings tab
// (week start, slot duration, auto-close) rendered EMPTY while the server had the values: the bug
// of schedules#9. The tests mocked a bare object, which is exactly why nothing caught it.
//
// Retiring `timezone` from this screen is the OTHER half of schedules#9 and stays blocked on
// hub#1022 (the core owns the business zone since hub#731 and has no door to it yet), so it is not
// asserted here — this is only about reading the answer the runtime really sends.
describe('settings.get answers [row]: the screen unwraps it safely — schedules#9', () => {
  const STORED = { timezone: 'Europe/Madrid', week_starts_on: 6, slot_duration: 45, auto_close_enabled: 1 };

  const mountWithSettings = async (answer: unknown) => {
    (globalThis as Record<string, unknown>).erplora = {
      ...((globalThis as Record<string, { erplora: object }>).erplora as object),
      query: async (name: string) => (name === 'schedules.settings.get' ? answer : null),
    };
    return mount('/m/schedules/settings');
  };

  const settingsOf = (el: Wc) =>
    (el as unknown as { settings: Record<string, unknown> }).settings;

  it('a one-row array is unwrapped into the object the form reads', async () => {
    const el = await mountWithSettings([STORED]);
    expect(settingsOf(el), 'the row inside the array is what the form must show').toMatchObject(STORED);
  });

  it('a bare object still works — the shape is not asserted, it is normalised', async () => {
    const el = await mountWithSettings(STORED);
    expect(settingsOf(el)).toMatchObject(STORED);
  });

  it('an empty answer leaves the defaults, it does not blank the form', async () => {
    const el = await mountWithSettings([]);
    const s = settingsOf(el);
    expect(s.slot_duration, 'no stored row is not a reason to show an empty control').toBe(30);
    expect(s.week_starts_on).toBe(1);
  });

  it('a corrupt answer is ignored instead of poisoning the form', async () => {
    for (const answer of [null, 'nope', [null], [42]]) {
      const el = await mountWithSettings(answer);
      expect(settingsOf(el).slot_duration, `answer ${JSON.stringify(answer)}`).toBe(30);
    }
  });

  it('the settings tab renders its controls with the stored values, not empty ones', async () => {
    const el = await mountWithSettings([STORED]);
    const input = el.shadowRoot.querySelector('ion-input[type="number"]') as HTMLElement & { value: unknown };
    expect(input, 'the settings tab must be the one rendered').toBeTruthy();
    expect(input.value, 'the control shows what the server stored').toBe(45);
  });
});
