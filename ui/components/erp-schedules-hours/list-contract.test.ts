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

// The SINGLETON shape is deliberately NOT asserted here. `schedules.settings.get` is a plain SQL
// query, so the runtime answers `[row]` and `loadSettings()` assigns it as if it were the object —
// that is the bug of schedules#9 (blocked on the core owning the hub timezone, hub#1022), and
// pinning today's behaviour in a test would make it harder to fix, not easier. It is written down
// here so it is not mistaken for something nobody noticed.
describe.todo('settings.get returns [row]: unwrapped safely — schedules#9');
