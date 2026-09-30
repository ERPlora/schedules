// The week start that could not be read must not be shown — nor saved — as «Monday»
// (schedules#62).
//
// `loadSettings()` swallowed every failure as «no settings row yet», so when the hub did not answer
// on opening, the Settings tab showed Monday for a business that had saved Sunday, with no notice,
// and «Save» then wrote Monday over it. The Hours tab folded the week from Monday the same way.
// Now an empty answer (no row yet) still means the defaults, but a failed read is an error: the
// Settings tab says so with its own Retry (which only READS) and offers no form until the value
// has been read, and the Hours table holds the week back until it knows where the week starts.
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
const SETTINGS = 'schedules.settings.get';
/** Who the rows planted at install time are written by (schedules#36). */
const SEED = 'system';
const WEEK = [
  { id: 'mon', day_of_week: 0, position: 0, open_time: '09:00', close_time: '18:00', is_closed: 0, break_start: null, break_end: null },
  { id: 'sun', day_of_week: 6, position: 0, open_time: '00:00', close_time: '00:00', is_closed: 1, break_start: null, break_end: null },
];

/** Query names the hub fails; every other query answers. */
let failing = new Set<string>();
/** What `schedules.settings.get` answers when it does answer: the business saved Sunday. */
let storedSettings: unknown = [{ week_starts_on: 7 }];
let queryCalls: string[] = [];
let commandCalls: string[] = [];
/** When set, the settings query waits for this before answering (the loading state). */
let settingsGate: Promise<void> | null = null;
/** The weekly rows the hub answers. */
let week: Record<string, unknown>[] = WEEK;
/** What the screen subscribed to, so a test can fire a live event (another device saved). */
let handlers = new Map<string, () => unknown>();

beforeAll(async () => {
  customElements.define('ok-data-table', ShellTable);
  await import('../components/erp-schedules-hours/erp-schedules-hours');
});

beforeEach(() => {
  window.history.replaceState({}, '', '/m/schedules/settings');
  document.body.innerHTML = '';
  failing = new Set([SETTINGS]);
  storedSettings = [{ week_starts_on: 7 }];
  queryCalls = [];
  commandCalls = [];
  settingsGate = null;
  week = WEEK;
  handlers = new Map();
  const answer = async (name: string) => {
    queryCalls.push(name);
    if (name === SETTINGS && settingsGate) await settingsGate;
    if (failing.has(name)) throw new Error(REASON);
    if (name === SETTINGS) return storedSettings;
    return name === 'schedules.business_hours.list' ? week : [];
  };
  (globalThis as Record<string, unknown>).erplora = {
    query: answer,
    queryOptional: answer,
    queryAll: answer,
    queryPage: async () => ({ rows: [], total: 0 }),
    command: async (name: string) => {
      commandCalls.push(name);
      return {};
    },
    hasPermission: () => true,
    on: (name: string, fn: () => unknown) => {
      handlers.set(name, fn);
      return () => {};
    },
    locale: 'en',
    timezone: 'Europe/Madrid',
    t: (_catalog: unknown, key: string) => key,
    currency: 'EUR',
    currencyDecimals: 2,
    formatMoney: (cents: number) => `${(cents / 100).toFixed(2)} €`,
  };
});

type Screen = HTMLElement & { shadowRoot: ShadowRoot; updateComplete: Promise<unknown> };
type Table = HTMLElement & { error?: string; rows: Record<string, unknown>[]; emptyMessage: string };

const settingsAsked = () => queryCalls.filter((n) => n === SETTINGS).length;

async function settle(el: Screen): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await el.updateComplete;
    await new Promise((r) => setTimeout(r, 0));
  }
}

async function mount(path = '/m/schedules/settings'): Promise<Screen> {
  window.history.replaceState({}, '', path);
  const el = document.createElement(TAG) as Screen;
  document.body.appendChild(el);
  await vi.waitFor(() => {
    if (!settingsAsked()) throw new Error('the settings have not been asked for yet');
  });
  await settle(el);
  return el;
}

const $ = (el: Screen, testid: string) => el.shadowRoot.querySelector<HTMLElement>(`[data-testid="${testid}"]`);
const notice = (el: Screen) => $(el, 'schedules-settings-load-error');
const retry = (el: Screen) => $(el, 'schedules-settings-retry');
const weekStart = (el: Screen) => $(el, 'schedules-settings-week-start') as (HTMLElement & { value?: unknown }) | null;
const submit = (el: Screen) => $(el, 'schedules-settings-submit');

/** Every red notice on the page (outside the panel forms), whatever its testid. */
const redNotices = (el: Screen): Element[] =>
  [...el.shadowRoot.querySelectorAll('ok-inline-feedback[tone="danger"]')].filter((b) => !b.closest('form[slot="create"]'));

const hoursTable = (el: Screen): Table => {
  const table = el.shadowRoot.querySelector<Table>('ok-data-table[testid="schedules-hours-table"]');
  expect(table, 'the Hours tab paints its table').toBeTruthy();
  return table!;
};

describe(`${TAG} — Settings could not be read (schedules#62)`, () => {
  it('says so with the reason and a Retry, instead of showing Monday', async () => {
    const el = await mount();
    const box = notice(el);
    expect(box, 'a failed read looked like «no settings yet»').toBeTruthy();
    expect(box!.getAttribute('tone')).toBe('danger');
    expect(box!.getAttribute('heading')).toBe('ui.settingsLoadFailed');
    expect(box!.textContent).toContain(REASON);
    expect(retry(el), 'the notice carries its own Retry').toBeTruthy();
    expect(retry(el)!.getAttribute('slot')).toBe('actions');
  });

  it('offers no week start to pick and no Save while the stored value was never read', async () => {
    const el = await mount();
    expect(weekStart(el), 'Monday would be shown as if it were the stored value').toBeNull();
    expect(submit(el), 'Save would write Monday over the stored Sunday').toBeNull();
  });

  it('is said once: one red notice on the Settings tab, even when every read failed', async () => {
    failing = new Set([SETTINGS, 'schedules.business_hours.list', 'schedules.exception_intervals.list']);
    shellTableKnowsErrors(true);
    const el = await mount();
    expect(redNotices(el).map((n) => n.getAttribute('data-testid'))).toEqual(['schedules-settings-load-error']);
  });

  it('Retry reads the settings again and then shows the stored Sunday, with Save', async () => {
    const el = await mount();
    const before = settingsAsked();
    failing.delete(SETTINGS);
    retry(el)!.click();
    await vi.waitFor(async () => {
      await el.updateComplete;
      if (notice(el)) throw new Error('the notice is still up');
    });
    expect(settingsAsked()).toBeGreaterThan(before);
    expect(weekStart(el)?.value).toBe(7);
    expect(submit(el)).toBeTruthy();
    expect(submit(el)!.hasAttribute('disabled')).toBe(false);
  });

  it('Retry only READS: it sends no command', async () => {
    const el = await mount();
    failing.delete(SETTINGS);
    retry(el)!.click();
    await settle(el);
    expect(commandCalls).toEqual([]);
  });

  it('Retry that fails again keeps the notice (with its Retry) up', async () => {
    const el = await mount();
    retry(el)!.click();
    await settle(el);
    expect(notice(el)?.textContent).toContain(REASON);
    expect(retry(el)).toBeTruthy();
    expect(retry(el)!.hasAttribute('disabled'), 'a Retry that failed must be tappable again').toBe(false);
    expect(retry(el)!.textContent).toContain('ui.retry');
    expect(retry(el)!.textContent).not.toContain('ui.retrying');
    expect(weekStart(el)).toBeNull();
  });

  it('while Retry is on its way, keeps the notice and its button (disabled) under the finger', async () => {
    const el = await mount();
    let open!: () => void;
    settingsGate = new Promise<void>((r) => (open = r));
    failing.delete(SETTINGS);
    retry(el)!.click();
    await el.updateComplete;
    expect(notice(el), 'the notice vanished while the read was in flight').toBeTruthy();
    expect(retry(el)?.hasAttribute('disabled')).toBe(true);
    expect(retry(el)?.textContent).toContain('ui.retrying');
    open();
    await vi.waitFor(async () => {
      await el.updateComplete;
      if (notice(el)) throw new Error('the notice is still up');
    });
  });

  it('a second tap on Retry while the first is on its way asks the hub only once', async () => {
    const el = await mount();
    let open!: () => void;
    settingsGate = new Promise<void>((r) => (open = r));
    failing.delete(SETTINGS);
    const before = settingsAsked();
    retry(el)!.click();
    retry(el)!.click();
    open();
    await settle(el);
    expect(settingsAsked() - before).toBe(1);
  });

  it('a hub with no settings row yet is NOT an error: the defaults (Monday) and Save are there', async () => {
    failing = new Set();
    storedSettings = [];
    const el = await mount();
    expect(notice(el)).toBeNull();
    expect(weekStart(el)?.value).toBe(1);
    expect(submit(el)).toBeTruthy();
  });

  it('a re-read that fails after a good one takes the form away again (another device may have saved)', async () => {
    failing = new Set();
    const el = await mount();
    expect(weekStart(el)?.value).toBe(7);
    failing.add(SETTINGS);
    const reload = handlers.get('schedules.settings.saved');
    expect(reload, 'the screen listens for settings saved elsewhere').toBeTruthy();
    await reload!();
    await settle(el);
    expect(notice(el)?.textContent, 'the last value read would be offered to Save as if current').toContain(REASON);
    expect(weekStart(el)).toBeNull();
    expect(submit(el)).toBeNull();
  });

  it('while the settings are on their way, offers no Save yet and says «Loading…»', async () => {
    failing = new Set();
    let open!: () => void;
    settingsGate = new Promise<void>((r) => (open = r));
    const el = await mount();
    expect(submit(el)).toBeNull();
    expect($(el, 'schedules-settings-loading')?.textContent).toContain('ui.loading');
    open();
    await vi.waitFor(async () => {
      await el.updateComplete;
      if (!submit(el)) throw new Error('the form has not arrived');
    });
    expect(weekStart(el)?.value).toBe(7);
    expect($(el, 'schedules-settings-loading')).toBeNull();
  });

  it('the business time zone (not a setting of this module) is still shown', async () => {
    const el = await mount();
    expect(el.shadowRoot.querySelector('.settings-core code')?.textContent).toBe('Europe/Madrid');
  });
});

describe(`${TAG} — Hours tab when the week start could not be read (schedules#62)`, () => {
  it('holds the week back and tells its table why, instead of folding it from Monday', async () => {
    shellTableKnowsErrors(true);
    const el = await mount('/m/schedules/hours');
    const table = hoursTable(el);
    expect(table.rows, 'the week would be ordered from Monday').toEqual([]);
    expect(table.error).toBe(REASON);
    expect(redNotices(el), 'the table already says it').toEqual([]);
  });

  it('Retry on the hours table reads the week start again and folds the week from Sunday', async () => {
    shellTableKnowsErrors(true);
    const el = await mount('/m/schedules/hours');
    const table = hoursTable(el);
    const before = settingsAsked();
    failing.delete(SETTINGS);
    table.dispatchEvent(new CustomEvent('retry', { detail: {} }));
    await vi.waitFor(async () => {
      await el.updateComplete;
      if (table.rows.length !== 7) throw new Error('the week has not arrived');
    });
    expect(settingsAsked()).toBeGreaterThan(before);
    expect(table.error).toBe('');
    expect(table.rows[0]).toMatchObject({ day_of_week: 6 });
    expect(commandCalls).toEqual([]);
  });

  it('on a shell whose table cannot paint the error, keeps a banner with the reason on the Hours tab', async () => {
    shellTableKnowsErrors(false);
    const el = await mount('/m/schedules/hours');
    expect(redNotices(el).map((n) => n.getAttribute('data-testid'))).toEqual(['schedules-error-hours']);
    expect($(el, 'schedules-error-hours')?.textContent).toContain(REASON);
    expect(hoursTable(el).emptyMessage).toBe('ui.hoursLoadFailed');
  });

  it('does not ask to confirm a planted week the person cannot see', async () => {
    shellTableKnowsErrors(true);
    week = WEEK.map((r) => ({ ...r, created_by: SEED }));
    const el = await mount('/m/schedules/hours');
    expect(hoursTable(el).rows).toEqual([]);
    expect($(el, 'schedules-hours-default-week'), '«check it matches your business» over a week that is not there').toBeNull();
    failing.delete(SETTINGS);
    hoursTable(el).dispatchEvent(new CustomEvent('retry', { detail: {} }));
    await vi.waitFor(async () => {
      await el.updateComplete;
      if (!$(el, 'schedules-hours-default-week')) throw new Error('the notice has not come back with the week');
    });
  });

  it('a week start read fine does not hold the week back', async () => {
    shellTableKnowsErrors(true);
    failing = new Set();
    const el = await mount('/m/schedules/hours');
    expect(hoursTable(el).rows).toHaveLength(7);
    expect(hoursTable(el).rows[0]).toMatchObject({ day_of_week: 6 });
  });
});

describe(`${TAG} — the Settings load states speak both languages (schedules#62)`, () => {
  it.each(['settingsLoadFailed', 'retry', 'retrying', 'loading'])('ui.%s is in the English source and translated into Spanish', (key) => {
    const en = (enLocale as { ui: Record<string, string> }).ui[key];
    const es = (esLocale as { ui: Record<string, string> }).ui[key];
    expect(en, `en ui.${key}`).toBeTruthy();
    expect(es, `es ui.${key}`).toBeTruthy();
    expect(es, `es ui.${key} is still the English text`).not.toBe(en);
  });
});
