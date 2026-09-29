// schedules#50 — the opening hours follow the HUB's language, not the browser's.
//
// With the hub in Spanish, the panel that edits a day read «09:00 AM» / «02:00 PM» while the list
// of the same week read «09:00–14:00». The panel fields were native `<input type="time">`:
// Chromium paints that control with the BROWSER's (operating system's) locale and ignores the hub
// language — the same finding appointments#214 closed for the time of an appointment. The fix is
// the same one: the module paints the time itself, in the hub clock (24 h in Spanish), as a text
// field read back by `parseWallTime`; and the lists use that very clock, so panel and list agree
// on every screen of the module (weekly hours, special days, temporary changes).
import { beforeEach, describe, expect, it } from 'vitest';
import esLocale from '../../../locales/es.json';
import enLocale from '../../../locales/en.json';

const CATALOGS: Record<string, unknown> = { es: esLocale, en: enLocale };

function lookup(catalog: unknown, key: string): string | undefined {
  const value = key
    .split('.')
    .reduce<unknown>((node, part) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined), catalog);
  return typeof value === 'string' ? value : undefined;
}

const commands: { name: string; payload: Record<string, unknown> }[] = [];

const HOURS = [
  { id: 'm1', day_of_week: 0, position: 0, open_time: '09:00', close_time: '14:00', is_closed: 0, break_start: null, break_end: null },
  { id: 'm2', day_of_week: 0, position: 1, open_time: '17:00', close_time: '20:30', is_closed: 0, break_start: null, break_end: null },
  { id: 't1', day_of_week: 1, position: 0, open_time: '10:00', close_time: '18:00', is_closed: 0, break_start: null, break_end: null },
];
const SPECIAL = [{ id: 'sd1', date: '2026-12-24', name: 'Nochebuena', is_closed: 0, open_time: '10:00', close_time: '13:00', recurring_yearly: 0, notes: '' }];
const OVERRIDES = [{ id: 'ov1', start_date: '2026-08-01', end_date: '2026-08-31', reason: 'Verano', is_closed: 0, open_time: '08:00', close_time: '15:00' }];
const INTERVALS = [
  { id: 'i1', exception_kind: 'special_day', exception_id: 'sd1', position: 0, open_time: '10:00', close_time: '13:00' },
  { id: 'i2', exception_kind: 'special_day', exception_id: 'sd1', position: 1, open_time: '17:00', close_time: '19:00' },
];

function install(locale: 'es' | 'en') {
  commands.length = 0;
  document.body.innerHTML = '';
  const page = (name: string) => {
    const rows =
      name === 'schedules.business_hours.list' ? HOURS
      : name === 'schedules.special_days.list' ? SPECIAL
      : name === 'schedules.overrides.list' ? OVERRIDES
      : name === 'schedules.exception_intervals.list' ? INTERVALS
      : [];
    return { rows, total: rows.length };
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
    locale,
    // The real resolution the shell does: active language, then English, then the key.
    t: (_catalog: unknown, key: string) => lookup(CATALOGS[locale], key) ?? lookup(CATALOGS.en, key) ?? key,
  };
}

type Interval = { open_time: string; close_time: string };
type Wc = HTMLElement & {
  shadowRoot: ShadowRoot;
  updateComplete: Promise<unknown>;
  bhDay: number;
  bhIntervals: Interval[];
  sdClosed: boolean;
  sdIntervals: Interval[];
  ovClosed: boolean;
  ovIntervals: Interval[];
  saveBusinessHours: (e: Event) => Promise<void>;
};

type Table = HTMLElement & {
  rows: Record<string, unknown>[];
  columns: { key: string; format?: (r: Record<string, unknown>) => string }[];
};

async function mount(path: string): Promise<Wc> {
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

const field = (el: Wc, testid: string) =>
  el.shadowRoot.querySelector(`[data-testid="${testid}"]`) as (HTMLElement & { value?: string }) | null;

/** Blank spaces normalized: `Intl` separates «AM/PM» with a narrow no-break space. */
const shown = (el: Wc, testid: string) => String(field(el, testid)?.value ?? '').replace(/\s/g, ' ');

/** What the browser hands over while she types: `ion-input` re-emits it as `ionInput`. */
async function type(el: Wc, testid: string, value: string) {
  const input = field(el, testid);
  expect(input, `${testid} must be rendered`).toBeTruthy();
  input!.value = value;
  input!.dispatchEvent(new CustomEvent('ionInput', { detail: { value }, bubbles: true, composed: true }));
  await el.updateComplete;
}

/** Leaving the field (blur / Enter): `ion-input` emits `ionChange`. */
async function leave(el: Wc, testid: string) {
  const input = field(el, testid)!;
  input.dispatchEvent(new CustomEvent('ionChange', { detail: { value: input.value }, bubbles: true, composed: true }));
  await el.updateComplete;
}

async function editDay(el: Wc, index: number) {
  const tbl = table(el, 'tbl-hours');
  tbl.dispatchEvent(new CustomEvent('rowAction', { detail: { actionId: 'edit', row: tbl.rows[index] } }));
  await el.updateComplete;
}

const EXPECTED = {
  es: { monday: '09:00–14:00 · 17:00–20:30', nine: '09:00', ten: '10:00', eightThirtyPm: '20:30', afternoon: '14:30', typed: '14:30', special: '10:00–13:00 · 17:00–19:00', override: '08:00–15:00', placeholder: 'hh:mm' },
  en: { monday: '09:00 AM–02:00 PM · 05:00 PM–08:30 PM', nine: '09:00 AM', ten: '10:00 AM', eightThirtyPm: '08:30 PM', afternoon: '02:30 PM', typed: '2:30 pm', special: '10:00 AM–01:00 PM · 05:00 PM–07:00 PM', override: '08:00 AM–03:00 PM', placeholder: 'hh:mm' },
} as const;

const plain = (s: string) => s.replace(/\s/g, ' ');

for (const locale of ['es', 'en'] as const) {
  const want = EXPECTED[locale];

  describe(`schedules#50 — the weekly hours in the hub clock (${locale})`, () => {
    beforeEach(() => install(locale));

    it('the list of the week reads the hub clock', async () => {
      const el = await mount('/m/schedules/hours');
      const col = table(el, 'tbl-hours').columns.find((c) => c.key === 'hours')!;
      expect(plain(col.format!(table(el, 'tbl-hours').rows[0]))).toBe(want.monday);
    });

    it('the day panel is not a native time input, whose clock the browser decides', async () => {
      const el = await mount('/m/schedules/hours');
      await editDay(el, 0);
      for (const testid of ['schedules-interval-open-hours-0', 'schedules-interval-close-hours-0', 'schedules-interval-open-hours-1']) {
        const input = field(el, testid);
        expect(input?.getAttribute('type'), `${testid}: a native time field paints the browser locale`).toBe('text');
        expect(input?.getAttribute('placeholder')).toBe(want.placeholder);
        // The phone opens its numeric keypad (hence «1430» without a colon), and the outline only
        // paints in `md` mode: in `ios` a `fill="outline"` alone leaves loose text (hub#760).
        expect(input?.getAttribute('inputmode'), `${testid}: the phone must open the numeric keypad`).toBe('numeric');
        expect(input?.getAttribute('mode'), `${testid}: fill="outline" is a no-op in ios mode`).toBe('md');
      }
    });

    it('the day panel shows the day\'s hours in the same clock as the list', async () => {
      const el = await mount('/m/schedules/hours');
      await editDay(el, 0);
      expect(shown(el, 'schedules-interval-open-hours-0')).toBe(want.nine);
      expect(shown(el, 'schedules-interval-close-hours-1')).toBe(want.eightThirtyPm);
    });

    it('typing a time the way it is shown sets that hour, and leaving repaints it in the hub clock', async () => {
      const el = await mount('/m/schedules/hours');
      await editDay(el, 0);
      await type(el, 'schedules-interval-close-hours-0', want.typed);
      expect(el.bhIntervals[0].close_time).toBe('14:30');
      expect(field(el, 'schedules-interval-close-hours-0')?.value, 'while typing, the text stays as typed').toBe(want.typed);
      await leave(el, 'schedules-interval-close-hours-0');
      expect(shown(el, 'schedules-interval-close-hours-0')).toBe(want.afternoon);
    });

    it('digits only (the phone keypad has no colon) set the hour too', async () => {
      const el = await mount('/m/schedules/hours');
      await editDay(el, 0);
      await type(el, 'schedules-interval-close-hours-0', '1430');
      expect(el.bhIntervals[0].close_time).toBe('14:30');
      await leave(el, 'schedules-interval-close-hours-0');
      expect(shown(el, 'schedules-interval-close-hours-0')).toBe(want.afternoon);
    });

    it('a half-typed time stays on screen as typed, is not a time yet, and the save refuses it', async () => {
      const el = await mount('/m/schedules/hours');
      await editDay(el, 0);
      await type(el, 'schedules-interval-close-hours-0', '14:');
      expect(field(el, 'schedules-interval-close-hours-0')?.value).toBe('14:');
      expect(el.bhIntervals[0].close_time, 'a half-typed time must not keep the last valid hour').toBe('');
      await el.saveBusinessHours(new Event('submit'));
      expect(commands).toEqual([]);
    });

    it('saving sends the hours typed in the hub clock as HH:MM', async () => {
      const el = await mount('/m/schedules/hours');
      await editDay(el, 1);
      await type(el, 'schedules-interval-close-hours-0', want.typed);
      await el.saveBusinessHours(new Event('submit'));
      expect(commands[0]).toEqual({
        name: 'schedules.business_hours.set',
        payload: { day_of_week: 1, is_closed: false, intervals: [{ open_time: '10:00', close_time: '14:30' }] },
      });
    });

    it('opening another day shows ITS hours, not what was half-typed for the previous one', async () => {
      const el = await mount('/m/schedules/hours');
      await editDay(el, 0);
      await type(el, 'schedules-interval-open-hours-0', '1');
      await editDay(el, 1);
      expect(shown(el, 'schedules-interval-open-hours-0')).toBe(want.ten);
    });

    it('removing an interval does not hand its half-typed text to the next one', async () => {
      const el = await mount('/m/schedules/hours');
      await editDay(el, 0);
      await type(el, 'schedules-interval-open-hours-0', '1');
      (el.shadowRoot.querySelectorAll('form[slot="create"] [data-action="remove-interval"]')[0] as HTMLElement).click();
      await el.updateComplete;
      expect(el.bhIntervals).toEqual([{ open_time: '17:00', close_time: '20:30' }]);
      expect(shown(el, 'schedules-interval-close-hours-0')).toBe(want.eightThirtyPm);
    });

    it('a time pasted into a field repaints it in the hub clock', async () => {
      const el = await mount('/m/schedules/hours');
      await editDay(el, 0);
      await type(el, 'schedules-interval-open-hours-0', '9');
      const paste = new Event('paste', { bubbles: true, composed: true, cancelable: true }) as Event & {
        clipboardData: { getData: () => string };
      };
      paste.clipboardData = { getData: () => '14:30' };
      field(el, 'schedules-interval-open-hours-0')!.dispatchEvent(paste);
      await el.updateComplete;
      expect(el.bhIntervals[0].open_time).toBe('14:30');
      expect(shown(el, 'schedules-interval-open-hours-0')).toBe(want.afternoon);
    });

    it('pasting something that is not a time is left to the browser, not swallowed', async () => {
      const el = await mount('/m/schedules/hours');
      await editDay(el, 0);
      const paste = new Event('paste', { bubbles: true, composed: true, cancelable: true }) as Event & {
        clipboardData: { getData: () => string };
      };
      paste.clipboardData = { getData: () => 'mañana' };
      field(el, 'schedules-interval-open-hours-0')!.dispatchEvent(paste);
      await el.updateComplete;
      expect(paste.defaultPrevented, 'the browser must still paste what the parser cannot read').toBe(false);
      expect(el.bhIntervals[0].open_time).toBe('09:00');
    });
  });

  describe(`schedules#50 — special days and temporary changes in the hub clock (${locale})`, () => {
    beforeEach(() => install(locale));

    it('the special days list reads the hub clock', async () => {
      const el = await mount('/m/schedules/special_days');
      const col = table(el, 'tbl-special').columns.find((c) => c.key === 'is_closed')!;
      expect(plain(col.format!(SPECIAL[0]))).toBe(want.special);
    });

    it('the temporary changes list reads the hub clock, also for a row with no interval rows of its own', async () => {
      const el = await mount('/m/schedules/special_days');
      const col = table(el, 'tbl-override').columns.find((c) => c.key === 'is_closed')!;
      expect(plain(col.format!(OVERRIDES[0]))).toBe(want.override);
    });

    it('the special day panel fields are text in the hub clock and read typed hours back', async () => {
      const el = await mount('/m/schedules/special_days');
      el.sdClosed = false;
      el.sdIntervals = [{ open_time: '09:00', close_time: '' }];
      await el.updateComplete;
      const open = field(el, 'schedules-interval-open-special-0');
      expect(open?.getAttribute('type')).toBe('text');
      expect(shown(el, 'schedules-interval-open-special-0')).toBe(want.nine);
      await type(el, 'schedules-interval-close-special-0', want.typed);
      expect(el.sdIntervals[0]).toEqual({ open_time: '09:00', close_time: '14:30' });
    });

    it('the temporary change panel fields are text in the hub clock and read typed hours back', async () => {
      const el = await mount('/m/schedules/special_days');
      el.ovClosed = false;
      el.ovIntervals = [{ open_time: '09:00', close_time: '' }];
      await el.updateComplete;
      expect(field(el, 'schedules-interval-open-override-0')?.getAttribute('type')).toBe('text');
      expect(shown(el, 'schedules-interval-open-override-0')).toBe(want.nine);
      await type(el, 'schedules-interval-close-override-0', '1430');
      expect(el.ovIntervals[0]).toEqual({ open_time: '09:00', close_time: '14:30' });
    });

    it('a half-typed time stays on screen in the special day and temporary change fields too', async () => {
      const el = await mount('/m/schedules/special_days');
      el.sdClosed = false;
      el.sdIntervals = [{ open_time: '09:00', close_time: '' }];
      el.ovClosed = false;
      el.ovIntervals = [{ open_time: '09:00', close_time: '' }];
      await el.updateComplete;
      await type(el, 'schedules-interval-close-special-0', '14:');
      expect(field(el, 'schedules-interval-close-special-0')?.value, 'the typed text must not vanish while typing').toBe('14:');
      expect(el.sdIntervals[0].close_time).toBe('');
      await type(el, 'schedules-interval-close-override-0', '8');
      expect(field(el, 'schedules-interval-close-override-0')?.value, 'the typed text must not vanish while typing').toBe('8');
    });
  });
}

describe('schedules#50 — changing the language repaints the hours', () => {
  it('the open panel follows the new language without reopening it', async () => {
    install('en');
    const el = await mount('/m/schedules/hours');
    await editDay(el, 0);
    expect(shown(el, 'schedules-interval-close-hours-1')).toBe('08:30 PM');
    (globalThis as { erplora: { locale: string } }).erplora.locale = 'es';
    window.dispatchEvent(new CustomEvent('erplora:locale-changed', { detail: { locale: 'es' } }));
    await el.updateComplete;
    expect(shown(el, 'schedules-interval-close-hours-1')).toBe('20:30');
  });
});
