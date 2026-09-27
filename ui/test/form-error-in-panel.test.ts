// pm#513 (out of pm#478) — on a phone, a refused save in Schedules showed NOTHING: the person
// pressed «Save day», «Add day» or «Add override» and the screen stayed as it was.
//
// The refusal did arrive; it was painted in the wrong place. The three forms of this module (the
// weekly day, the special day and the override) live in the `create` panel of their
// `ok-data-table`, and under 834 px that panel is a FULL-SCREEN sheet (`position: fixed; inset: 0;
// z-index: 1000`, outfitkit#75). The error banner was a child of the PAGE, so on a phone and a
// tablet it sat under the sheet, out of sight (bench: hub:stable 1.1.30, 390 and 820 px, ios and md
// — the banner was in the DOM, inside the viewport, and not on top; 6 of 12 panel cases hidden).
//
// The rule this file fixes — the same one Customers (customers#97), Services (services#115),
// Inventory (inventory#118), Appointments (appointments#227), Tables (tables#93) and Reservations
// (reservations#73) follow:
//
//   · what goes wrong while SAVING a panel's form (a server refusal, or the check that every open
//     interval has both hours) is painted INSIDE that form, next to the button that was pressed,
//     and scrolled into view ONCE — it travels with the panel whatever the width;
//   · what goes wrong OUTSIDE a panel's save (confirming the default week, deleting a special day
//     or an override, saving the Settings tab, loading the week) stays on the PAGE: no panel is
//     open then, and a message inside a closed panel is just as invisible;
//   · a later save clears the page refusal too: it is the next thing the person did.
//
// The Special days tab carries TWO forms (special day, override), each in its own table's panel:
// the refusal of one must not show up in — nor be wiped by — the other.
import { beforeEach, describe, expect, it, vi } from 'vitest';

class DomainError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

const SPECIAL = { id: 's1', date: '2026-12-24', name: 'Christmas Eve', is_closed: 1 };
const OVERRIDE = { id: 'o1', start_date: '2026-08-01', end_date: '2026-08-31', reason: 'Summer', is_closed: 1 };
/** A week somebody has not confirmed yet: it is what paints the «confirm the week» action. */
const SEEDED_DAY = { id: 'h1', day_of_week: 0, is_closed: 0, open_time: '09:00', close_time: '18:00', created_by: 'system' };

let refusal: Error | null = null;
/** When set, every command waits for it: a save is caught IN FLIGHT. */
let inFlight: Promise<void> | null = null;
let hoursLoadFails = false;
/** Every element the component scrolled into view AFTER it had painted itself, in order. Scrolling a
 *  banner that has not rendered yet measures a 0-px box: the sheet stops with the banner still half
 *  under the tab bar (seen in the staff#72 bench at 390 px). */
let revealed: Element[] = [];

beforeEach(() => {
  refusal = null;
  inFlight = null;
  hoursLoadFails = false;
  revealed = [];
  vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(function (this: HTMLElement) {
    if ((this as HTMLElement & { hasUpdated?: boolean }).hasUpdated !== false) revealed.push(this);
  });
  (globalThis as Record<string, unknown>).erplora = {
    timezone: 'Europe/Madrid',
    query: async () => [],
    queryAll: async (name: string) => {
      if (name === 'schedules.business_hours.list') {
        if (hoursLoadFails) throw new DomainError('bench.load_failed', 'load failed');
        return [SEEDED_DAY];
      }
      return [];
    },
    queryPage: async () => ({ rows: [], total: 0 }),
    command: async () => {
      if (inFlight) await inFlight;
      if (refusal) throw refusal;
      return {};
    },
    on: () => () => {},
    locale: 'es',
    t: (_c: unknown, key: string) => key,
  };
});

type Wc = HTMLElement & { shadowRoot: ShadowRoot; updateComplete: Promise<unknown> } & Record<string, any>;

async function mount(tab: 'hours' | 'special_days' | 'settings'): Promise<Wc> {
  window.history.replaceState({}, '', `/m/schedules/${tab}`);
  await import('../components/erp-schedules-hours/erp-schedules-hours');
  const el = document.createElement('erp-schedules-hours') as Wc;
  document.body.appendChild(el);
  await settle(el);
  return el;
}

async function settle(el: Wc): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await el.updateComplete;
    await new Promise((r) => setTimeout(r, 0));
  }
}

const submitEvent = (): Event => new Event('submit', { cancelable: true });
const rowAction = (actionId: string, row: object): CustomEvent =>
  new CustomEvent('rowAction', { detail: { actionId, row } });
const confirmDelete = (): CustomEvent => new CustomEvent('ionAlertDidDismiss', { detail: { role: 'confirm' } });

const PAGE_ERROR = 'schedules-error-page';

/** The error banner INSIDE the given panel form, or null. */
const inForm = (el: Wc, form: string, testid: string): Element | null =>
  el.shadowRoot.querySelector(`form[slot="create"][data-testid="${form}"] [data-testid="${testid}"]`);

/** The banner inside the form AND scrolled into view: pressing the button at the foot of a long
 *  form, the banner that appears above it is pushed half off a phone screen otherwise. */
const inFormAndRevealed = (el: Wc, form: string, testid: string): Element | null => {
  const banner = inForm(el, form, testid);
  return banner && revealed.includes(banner) ? banner : null;
};

/** The error banner on the PAGE (outside every panel), or null. */
const onPage = (el: Wc, testid: string = PAGE_ERROR): Element | null => {
  const banner = el.shadowRoot.querySelector(`[data-testid="${testid}"]`);
  return banner && !banner.closest('form[slot="create"]') ? banner : null;
};

/** How each panel form is driven: fill a valid row, save it, and run the action OUTSIDE the panel
 *  that the server can refuse on the same tab. */
interface Screen {
  surface: string;
  tab: 'hours' | 'special_days';
  form: string;
  formError: string;
  fill: (el: Wc) => void;
  /** Fill it the way the client check refuses: open, with an interval missing its closing hour. */
  fillIncomplete: (el: Wc) => void;
  /** Correct one field of the form, the way typing into it does (one `@ionInput` = one render). */
  edit: (el: Wc) => void;
  save: (el: Wc) => Promise<void>;
  pageAct: (el: Wc) => Promise<void>;
}

const SCREENS: Screen[] = [
  {
    surface: 'weekly day',
    tab: 'hours',
    form: 'schedules-hours-form',
    formError: 'schedules-hours-form-error',
    fill: (el) => { el.bhDay = 0; el.bhClosed = false; el.bhIntervals = [{ open_time: '09:00', close_time: '18:00' }]; },
    fillIncomplete: (el) => { el.bhDay = 0; el.bhClosed = false; el.bhIntervals = [{ open_time: '09:00', close_time: '' }]; },
    edit: (el) => { el.bhIntervals = [{ open_time: '09:00', close_time: '17:00' }]; },
    save: (el) => el.saveBusinessHours(submitEvent()),
    pageAct: (el) => el.confirmWeek(),
  },
  {
    surface: 'special day',
    tab: 'special_days',
    form: 'schedules-special-form',
    formError: 'schedules-special-form-error',
    fill: (el) => { el.sdDate = '2026-12-24'; el.sdName = 'Christmas Eve'; el.sdClosed = true; },
    fillIncomplete: (el) => { el.sdDate = '2026-12-24'; el.sdName = 'Christmas Eve'; el.sdClosed = false; el.sdIntervals = [{ open_time: '10:00', close_time: '' }]; },
    edit: (el) => { el.sdName = 'Christmas'; },
    save: (el) => el.createSpecialDay(submitEvent()),
    pageAct: async (el) => { el.onSpecialAction(rowAction('delete', SPECIAL)); await el.onDeleteDismiss(confirmDelete()); },
  },
  {
    surface: 'override',
    tab: 'special_days',
    form: 'schedules-override-form',
    formError: 'schedules-override-form-error',
    fill: (el) => { el.ovStart = '2026-08-01'; el.ovEnd = '2026-08-31'; el.ovReason = 'Summer'; el.ovClosed = true; },
    fillIncomplete: (el) => { el.ovStart = '2026-08-01'; el.ovEnd = '2026-08-31'; el.ovReason = 'Summer'; el.ovClosed = false; el.ovIntervals = [{ open_time: '', close_time: '14:00' }]; },
    edit: (el) => { el.ovReason = 'Summer hours'; },
    save: (el) => el.createOverride(submitEvent()),
    pageAct: async (el) => { el.onOverrideAction(rowAction('delete', OVERRIDE)); await el.onDeleteDismiss(confirmDelete()); },
  },
];

/** An action outside every panel that the server refuses. */
async function refusedPageAction(el: Wc, s: Screen): Promise<void> {
  refusal = new DomainError('bench.in_use', 'in use');
  await s.pageAct(el);
  await settle(el);
}

describe.each(SCREENS)('pm#513 · $surface: save refusal in the form, the rest on the page', (s) => {
  it('a refused save lands in the form, as a danger banner, and is scrolled into view', async () => {
    const el = await mount(s.tab);
    s.fill(el);
    refusal = new DomainError('bench.rejected', 'rejected');
    await s.save(el);
    await settle(el);
    const banner = inForm(el, s.form, s.formError);
    expect(banner, 'on a phone the panel covers the page: the refusal has to travel with the form').not.toBeNull();
    expect(banner?.tagName).toBe('OK-INLINE-FEEDBACK');
    expect(banner?.getAttribute('tone')).toBe('danger');
    expect(inFormAndRevealed(el, s.form, s.formError), 'and it is scrolled into view').not.toBeNull();
    expect(banner?.textContent?.trim()).toBe('rejected');
    expect(onPage(el), 'the page under the sheet shows nothing').toBeNull();
  });

  it('the «every open interval needs both hours» check lands in the form too', async () => {
    const el = await mount(s.tab);
    s.fillIncomplete(el);
    await s.save(el);
    await settle(el);
    expect(inFormAndRevealed(el, s.form, s.formError)?.textContent?.trim()).toBe('ui.errorHoursRequired');
    expect(onPage(el)).toBeNull();
  });

  it('correcting a field after a refusal does not scroll the sheet back to the banner', async () => {
    // The banner is scrolled into view ONCE, when the refusal arrives. Every keystroke re-renders the
    // form: scrolling on every render would yank the sheet away from the field being corrected.
    const el = await mount(s.tab);
    s.fill(el);
    refusal = new DomainError('bench.rejected', 'rejected');
    await s.save(el);
    await settle(el);
    revealed = [];
    s.edit(el);
    await settle(el);
    expect(inForm(el, s.form, s.formError), 'the refusal is still there').not.toBeNull();
    expect(revealed, 'but the sheet stays where the person is typing').toEqual([]);
  });

  it('a new attempt hides the previous refusal of the form while it is in flight', async () => {
    const el = await mount(s.tab);
    s.fill(el);
    refusal = new DomainError('bench.rejected', 'rejected');
    await s.save(el);
    refusal = null;
    let release!: () => void;
    inFlight = new Promise((r) => (release = r));
    s.fill(el);
    const retry = s.save(el);
    await settle(el);
    expect(inForm(el, s.form, s.formError), 'the old refusal no longer describes what is being saved').toBeNull();
    release();
    await retry;
  });

  it('a refused action outside the panel is shown on the page, not in the form', async () => {
    const el = await mount(s.tab);
    await refusedPageAction(el, s);
    const banner = onPage(el);
    expect(banner, 'no panel is open: inside the form it would be invisible').not.toBeNull();
    expect(banner?.textContent?.trim()).toBe('in use');
    expect(inForm(el, s.form, s.formError)).toBeNull();
  });

  it('the page refusal goes away once a later save succeeds', async () => {
    const el = await mount(s.tab);
    await refusedPageAction(el, s);
    refusal = null;
    s.fill(el);
    await s.save(el);
    await settle(el);
    expect(onPage(el), 'a stale refusal must not stay red after a save that worked').toBeNull();
  });

  it('the page refusal goes away once a later save is refused too', async () => {
    const el = await mount(s.tab);
    await refusedPageAction(el, s);
    s.fill(el);
    refusal = new DomainError('bench.rejected', 'rejected');
    await s.save(el);
    await settle(el);
    expect(onPage(el), 'the refusal that matters now is the form one').toBeNull();
    expect(inForm(el, s.form, s.formError)).not.toBeNull();
  });

  it('running the page action again hides the previous refusal', async () => {
    const el = await mount(s.tab);
    await refusedPageAction(el, s);
    refusal = null;
    await s.pageAct(el);
    await settle(el);
    expect(onPage(el)).toBeNull();
  });

  it('a refused action outside the panel does not wipe the refusal still shown in the form', async () => {
    const el = await mount(s.tab);
    s.fill(el);
    refusal = new DomainError('bench.rejected', 'rejected');
    await s.save(el);
    await refusedPageAction(el, s);
    expect(inForm(el, s.form, s.formError)?.textContent?.trim()).toBe('rejected');
  });
});

describe('pm#513 · Special days: each form keeps its own refusal', () => {
  const [, SPECIAL_S, OVERRIDE_S] = SCREENS;

  it('a refused special day is not painted in the override form', async () => {
    const el = await mount('special_days');
    SPECIAL_S.fill(el);
    refusal = new DomainError('bench.rejected', 'rejected');
    await SPECIAL_S.save(el);
    await settle(el);
    expect(inForm(el, SPECIAL_S.form, SPECIAL_S.formError)).not.toBeNull();
    expect(el.shadowRoot.querySelector(`[data-testid="${OVERRIDE_S.formError}"]`)).toBeNull();
  });

  it('a refused override is not painted in the special-day form', async () => {
    const el = await mount('special_days');
    OVERRIDE_S.fill(el);
    refusal = new DomainError('bench.rejected', 'rejected');
    await OVERRIDE_S.save(el);
    await settle(el);
    expect(inForm(el, OVERRIDE_S.form, OVERRIDE_S.formError)).not.toBeNull();
    expect(el.shadowRoot.querySelector(`[data-testid="${SPECIAL_S.formError}"]`)).toBeNull();
  });

  it('an override saved after a refused special day keeps the special-day refusal', async () => {
    const el = await mount('special_days');
    SPECIAL_S.fill(el);
    refusal = new DomainError('bench.rejected', 'rejected');
    await SPECIAL_S.save(el);
    refusal = null;
    OVERRIDE_S.fill(el);
    await OVERRIDE_S.save(el);
    await settle(el);
    expect(inForm(el, SPECIAL_S.form, SPECIAL_S.formError)?.textContent?.trim(), 'its fields still hold what was refused').toBe('rejected');
  });

  it('a special day saved after a refused override keeps the override refusal', async () => {
    const el = await mount('special_days');
    OVERRIDE_S.fill(el);
    refusal = new DomainError('bench.rejected', 'rejected');
    await OVERRIDE_S.save(el);
    refusal = null;
    SPECIAL_S.fill(el);
    await SPECIAL_S.save(el);
    await settle(el);
    expect(inForm(el, OVERRIDE_S.form, OVERRIDE_S.formError)?.textContent?.trim(), 'its fields still hold what was refused').toBe('rejected');
  });

  it('a refusal in one form scrolls to THAT form\'s banner only', async () => {
    const el = await mount('special_days');
    OVERRIDE_S.fill(el);
    refusal = new DomainError('bench.rejected', 'rejected');
    await OVERRIDE_S.save(el);
    await settle(el);
    expect(revealed).toEqual([inForm(el, OVERRIDE_S.form, OVERRIDE_S.formError)]);
  });
});

describe('pm#513 · weekly day: editing another day starts from a clean form', () => {
  it('opening another day drops the refusal of the day edited before', async () => {
    // Opening a day REPLACES every field with that day's hours: a refusal about the previous day
    // would now describe hours that are no longer on screen.
    const el = await mount('hours');
    SCREENS[0].fill(el);
    refusal = new DomainError('bench.rejected', 'rejected');
    await SCREENS[0].save(el);
    await settle(el);
    el.onHoursAction(rowAction('edit', { day_of_week: 1, is_closed: 0, intervals: [{ open_time: '10:00', close_time: '14:00' }] }));
    await settle(el);
    expect(inForm(el, SCREENS[0].form, SCREENS[0].formError)).toBeNull();
  });
});

describe('pm#513 · what happens outside the panels stays on the page', () => {
  it('a refused Settings save is on the page (that form lives on the page, not in a panel)', async () => {
    const el = await mount('settings');
    refusal = new DomainError('bench.rejected', 'rejected');
    await el.saveSettings(submitEvent());
    await settle(el);
    expect(onPage(el)?.textContent?.trim()).toBe('rejected');
  });

  it('a Settings save that works clears the refusal of the one before', async () => {
    const el = await mount('settings');
    refusal = new DomainError('bench.rejected', 'rejected');
    await el.saveSettings(submitEvent());
    refusal = null;
    await el.saveSettings(submitEvent());
    await settle(el);
    expect(onPage(el)).toBeNull();
  });

  it('a week that fails to load is reported on the page', async () => {
    hoursLoadFails = true;
    const el = await mount('hours');
    expect(onPage(el)?.textContent?.trim()).toBe('load failed');
    expect(inForm(el, SCREENS[0].form, SCREENS[0].formError)).toBeNull();
  });

  it('the page banner is a danger ok-inline-feedback', async () => {
    const el = await mount('hours');
    await refusedPageAction(el, SCREENS[0]);
    expect(onPage(el)?.tagName).toBe('OK-INLINE-FEEDBACK');
    expect(onPage(el)?.getAttribute('tone')).toBe('danger');
  });
});
