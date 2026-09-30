// The weekly hours that could not load must not read as seven «Not set» days with no way back
// (schedules#60, pm#533).
//
// The week is not a paged list (it is folded from every interval row), so it never went through
// `createListController`: its failure was written into the page-wide banner, painted on EVERY tab,
// and the table below kept folding an empty answer into seven «Not set» rows — the same screen as a
// business with no hours at all — with no Retry. Now the week's failure is its own, handed to the
// shell's `<ok-data-table>` (OutfitKit ≥ 0.1.113 paints «could not load», the reason and Retry), and
// its own banner stays only on a shell whose table cannot paint the error, and only on the Hours tab.
//
// The shell's table is stood in for by a bare element registered BEFORE the screen loads (as the
// shell does at boot); its `error` property is added or removed per test, which is exactly what
// `dataTableShowsLoadError()` reads.
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
const WEEK = [
  { id: 'mon', day_of_week: 0, position: 0, open_time: '09:00', close_time: '18:00', is_closed: 0, break_start: null, break_end: null },
  { id: 'sun', day_of_week: 6, position: 0, open_time: '00:00', close_time: '00:00', is_closed: 1, break_start: null, break_end: null },
];

let hubAnswers = false;
let queryCalls: string[] = [];
let commandCalls: string[] = [];
/** When set, the weekly hours query waits for this before answering (the loading state). */
let hoursGate: Promise<void> | null = null;

beforeAll(async () => {
  customElements.define('ok-data-table', ShellTable);
  await import('../components/erp-schedules-hours/erp-schedules-hours');
});

beforeEach(() => {
  window.history.replaceState({}, '', '/m/schedules/hours');
  document.body.innerHTML = '';
  hubAnswers = false;
  queryCalls = [];
  commandCalls = [];
  hoursGate = null;
  const answer = async (name: string) => {
    queryCalls.push(name);
    if (name === 'schedules.business_hours.list' && hoursGate) await hoursGate;
    if (!hubAnswers) throw new Error(REASON);
    return name === 'schedules.business_hours.list' ? WEEK : [];
  };
  (globalThis as Record<string, unknown>).erplora = {
    query: answer,
    queryOptional: answer,
    queryAll: answer,
    queryPage: async () => {
      if (!hubAnswers) throw new Error(REASON);
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
type Table = HTMLElement & { error?: string; rows: Record<string, unknown>[]; emptyMessage: string };

const weekAsked = () => queryCalls.filter((n) => n === 'schedules.business_hours.list').length;

async function settle(el: Screen): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await el.updateComplete;
    await new Promise((r) => setTimeout(r, 0));
  }
}

async function mount(path = '/m/schedules/hours'): Promise<Screen> {
  window.history.replaceState({}, '', path);
  const el = document.createElement(TAG) as Screen;
  document.body.appendChild(el);
  await vi.waitFor(() => {
    if (!weekAsked()) throw new Error('the week has not been asked for yet');
  });
  await settle(el);
  return el;
}

const hoursTable = (el: Screen): Table => {
  const table = el.shadowRoot.querySelector<Table>('ok-data-table[testid="schedules-hours-table"]');
  expect(table, 'the Hours tab paints its table').toBeTruthy();
  return table!;
};

/** Every red banner on the page (outside the panel forms), whatever its testid. */
const pageBanners = (el: Screen): Element[] =>
  [...el.shadowRoot.querySelectorAll('ok-inline-feedback[tone="danger"]')].filter((b) => !b.closest('form[slot="create"]'));

describe(`${TAG} — the weekly hours could not load (schedules#60)`, () => {
  it('hands the reason to the hours table and paints no banner that repeats it', async () => {
    shellTableKnowsErrors(true);
    const el = await mount();
    expect(hoursTable(el).error).toBe(REASON);
    expect(pageBanners(el), 'the reason would be said twice').toEqual([]);
  });

  it('never folds the failed answer into seven «Not set» days', async () => {
    shellTableKnowsErrors(true);
    const el = await mount();
    expect(hoursTable(el).rows, 'seven empty days read as a business with no hours').toEqual([]);
  });

  it('Retry on the hours table asks for the week again and paints the seven days that now arrive', async () => {
    shellTableKnowsErrors(true);
    const el = await mount();
    const table = hoursTable(el);
    const before = weekAsked();
    hubAnswers = true;
    table.dispatchEvent(new CustomEvent('retry', { detail: {} }));
    await vi.waitFor(async () => {
      await el.updateComplete;
      if (table.error !== '') throw new Error('the error is still on the table');
    });
    expect(weekAsked()).toBeGreaterThan(before);
    expect(table.rows).toHaveLength(7);
    expect(table.rows[0]).toMatchObject({ day_of_week: 0, configured: 1, is_closed: 0 });
    expect(table.rows[6]).toMatchObject({ day_of_week: 6, is_closed: 1 });
    expect(pageBanners(el)).toEqual([]);
  });

  it('Retry only READS: it sends no command', async () => {
    shellTableKnowsErrors(true);
    const el = await mount();
    hubAnswers = true;
    hoursTable(el).dispatchEvent(new CustomEvent('retry', { detail: {} }));
    await settle(el);
    expect(commandCalls).toEqual([]);
  });

  it('Retry keeps the refusal of an action the person took (it is not the load that failed)', async () => {
    shellTableKnowsErrors(true);
    const el = await mount();
    (el as unknown as { pageError: string }).pageError = 'confirm refused';
    await settle(el);
    hubAnswers = true;
    hoursTable(el).dispatchEvent(new CustomEvent('retry', { detail: {} }));
    await settle(el);
    expect(el.shadowRoot.querySelector('[data-testid="schedules-error-page"]')?.textContent).toContain('confirm refused');
  });

  it('while the week is on its way, says «Loading…» instead of seven «Not set» days', async () => {
    shellTableKnowsErrors(true);
    let open!: () => void;
    hoursGate = new Promise<void>((r) => (open = r));
    hubAnswers = true;
    const el = await mount();
    const table = hoursTable(el);
    expect(table.rows).toEqual([]);
    expect(table.emptyMessage).toBe('ui.loading');
    open();
    await vi.waitFor(async () => {
      await el.updateComplete;
      if (table.rows.length !== 7) throw new Error('the week has not arrived');
    });
    expect(table.emptyMessage).toBe('ui.emptyHours');
  });

  it('on a shell whose table cannot paint the error, keeps a banner with the reason on the Hours tab', async () => {
    shellTableKnowsErrors(false);
    const el = await mount();
    const banner = el.shadowRoot.querySelector('[data-testid="schedules-error-hours"]');
    expect(banner, 'an older hub would show the failure nowhere').toBeTruthy();
    expect(banner!.textContent).toContain(REASON);
    expect(el.shadowRoot.querySelector('[data-testid="schedules-error-page"]')).toBeNull();
    const table = hoursTable(el);
    expect(table.rows).toEqual([]);
    expect(table.emptyMessage, '«No schedule configured» would be a lie').toBe('ui.hoursLoadFailed');
  });

  it.each([
    ['special_days', true],
    ['special_days', false],
    ['settings', true],
    ['settings', false],
  ] as const)('on the %s tab (table paints errors: %s), the week\'s failure paints no banner', async (tab, knows) => {
    shellTableKnowsErrors(knows);
    const el = await mount(`/m/schedules/${tab}`);
    const texts = pageBanners(el).map((b) => b.getAttribute('data-testid'));
    expect(texts).not.toContain('schedules-error-hours');
    expect(texts).not.toContain('schedules-error-page');
  });

  it('on Special days, after both lists come back through Retry, no red banner is left on the page', async () => {
    shellTableKnowsErrors(true);
    const el = await mount('/m/schedules/special_days');
    expect(pageBanners(el), 'the week\'s failure does not belong on this tab').toEqual([]);
    hubAnswers = true;
    for (const id of ['schedules-special-table', 'schedules-override-table']) {
      el.shadowRoot.querySelector(`ok-data-table[testid="${id}"]`)!.dispatchEvent(new CustomEvent('retry', { detail: {} }));
    }
    await settle(el);
    expect(pageBanners(el)).toEqual([]);
  });

  it('on an older shell, the exception lists\' banners stay on Special days, not on Hours', async () => {
    shellTableKnowsErrors(false);
    const el = await mount();
    const ids = pageBanners(el).map((b) => b.getAttribute('data-testid'));
    expect(ids).toEqual(['schedules-error-hours']);
  });
});

describe(`${TAG} — the week's load states speak both languages (schedules#60)`, () => {
  it.each(['hoursLoadFailed', 'loading', 'emptyHours'])('ui.%s is in the English source and translated into Spanish', (key) => {
    const en = (enLocale as { ui: Record<string, string> }).ui[key];
    const es = (esLocale as { ui: Record<string, string> }).ui[key];
    expect(en, `en ui.${key}`).toBeTruthy();
    expect(es, `es ui.${key}`).toBeTruthy();
    expect(es, `es ui.${key} is still the English text`).not.toBe(en);
  });
});
