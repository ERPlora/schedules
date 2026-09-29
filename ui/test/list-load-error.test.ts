// A list that could not load must not read «No special days.»/«No overrides.» + «0 records» (pm#533, hub#2328).
//
// The shell's `<ok-data-table>` (OutfitKit ≥ 0.1.113) paints a failed load itself: «could not
// load», the reason and a Retry button. Every list of this screen hands it its controller's `error`
// and reloads on its `retry` event — and drops its own red banner, which would say the same thing
// twice. But a module paints with the SHELL's OutfitKit (ADR-0451): on a hub whose table has no
// `error` property the banner is the only place the reason is shown, so it stays.
//
// The shell's table is stood in for by a bare element registered BEFORE the screen loads (as the
// shell does at boot; the screen's own `define()` then loses, like in the hub). Its `error`
// property is added or removed per test, which is exactly what `dataTableShowsLoadError()` reads.
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

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
const TABLES = [
  { table: 'schedules-special-table', banner: 'schedules-error-special' },
  { table: 'schedules-override-table', banner: 'schedules-error-override' },
] as const;

let hubAnswers = false;
let pageCalls = 0;
let queryCalls: string[] = [];

beforeAll(async () => {
  customElements.define('ok-data-table', ShellTable);
  await import('../components/erp-schedules-hours/erp-schedules-hours');
});

beforeEach(() => {
  // Both lists live on the «Special days» tab; the screen picks its tab from the route.
  window.history.replaceState({}, '', '/m/schedules/special_days');
  document.body.innerHTML = '';
  hubAnswers = false;
  pageCalls = 0;
  queryCalls = [];
  const answer = async (name: string) => {
    queryCalls.push(name);
    if (!hubAnswers) throw new Error('The hub is not responding.');
    return [];
  };
  (globalThis as Record<string, unknown>).erplora = {
    query: answer,
    queryOptional: answer,
    queryPage: async () => {
      pageCalls++;
      if (!hubAnswers) throw new Error('The hub is not responding.');
      return { rows: [{ id: 'r1', name: 'Christmas' }], total: 1 };
    },
    queryAll: answer,
    command: async () => ({}),
    hasPermission: () => true,
    on: () => () => {},
    locale: 'es',
    t: (_catalog: unknown, key: string) => key,
    currency: 'EUR',
    currencyDecimals: 2,
    formatMoney: (cents: number) => `${(cents / 100).toFixed(2)} €`,
  };
});

type Screen = HTMLElement & { shadowRoot: ShadowRoot; updateComplete: Promise<unknown> };

async function mountFailed(tableId: string): Promise<{ el: Screen; table: HTMLElement }> {
  const el = document.createElement(TAG) as Screen;
  document.body.appendChild(el);
  await vi.waitFor(() => {
    if (pageCalls < TABLES.length) throw new Error('the lists have not asked for their page yet');
  });
  await el.updateComplete;
  await new Promise((r) => setTimeout(r, 0));
  await el.updateComplete;
  const table = el.shadowRoot.querySelector<HTMLElement>(`ok-data-table[testid="${tableId}"]`);
  expect(table, `${TAG} paints ${tableId}`).toBeTruthy();
  return { el, table: table! };
}

describe.each(TABLES)(`${TAG} $table — a list that could not load (pm#533)`, (s) => {
  it('hands the reason to the shell table and paints no second banner', async () => {
    shellTableKnowsErrors(true);
    const { el, table } = await mountFailed(s.table);
    expect((table as unknown as { error: string }).error).toBe('The hub is not responding.');
    expect(el.shadowRoot.querySelector(`[data-testid="${s.banner}"]`), 'the reason would be said twice').toBeNull();
  });

  it('Retry on the table asks the hub again and paints the rows that now arrive', async () => {
    shellTableKnowsErrors(true);
    const { el, table } = await mountFailed(s.table);
    const before = pageCalls;
    hubAnswers = true;
    table.dispatchEvent(new CustomEvent('retry', { detail: {} }));
    await vi.waitFor(() => {
      if (pageCalls === before) throw new Error('Retry did not ask the hub again');
    });
    await vi.waitFor(async () => {
      await el.updateComplete;
      if ((table as unknown as { error: string }).error !== '') throw new Error('the error is still on the table');
    });
    expect((table as unknown as { rows: unknown[] }).rows).toEqual([{ id: 'r1', name: 'Christmas' }]);
  });

  it('on a shell whose table cannot paint the error, keeps its own banner with the reason', async () => {
    shellTableKnowsErrors(false);
    const { el } = await mountFailed(s.table);
    const banner = el.shadowRoot.querySelector(`[data-testid="${s.banner}"]`);
    expect(banner, 'an older hub would show the failure nowhere').toBeTruthy();
    expect(banner!.textContent).toContain('The hub is not responding.');
  });
});

describe('erp-schedules-hours — Retry of an exception list (pm#533)', () => {
  it.each(TABLES)('Retry on $table also asks again for the exception intervals the failure left out', async (s) => {
    // The two tables fold every exception's intervals (schedules#23), loaded with the lists when
    // the screen opens: rows back without them would read as exceptions with no hours.
    shellTableKnowsErrors(true);
    const { table } = await mountFailed(s.table);
    const asked = () => queryCalls.filter((n) => n === 'schedules.exception_intervals.list').length;
    const before = asked();
    hubAnswers = true;
    table.dispatchEvent(new CustomEvent('retry', { detail: {} }));
    await vi.waitFor(() => {
      if (asked() === before) throw new Error('the exception intervals were not asked again');
    });
  });
});
