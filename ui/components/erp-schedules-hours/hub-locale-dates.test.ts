// schedules#54 — the dates of Special days and Temporary changes follow the HUB's language.
//
// With the hub in Spanish, the «Date» field of a special day and the «From» / «To» fields of a
// temporary change were native `<input type="date">`: Chromium paints that control with the
// BROWSER's (operating system's) locale, so on a US-English laptop they read «12/24/2026» and
// «03/04/2026» typed as the 3rd of April saved the 4th of March. The module paints the date itself
// in the hub order (day/month in Spanish) as a text field read back by `parseCalendarDate`, and
// always saves the ISO date.
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

function install(locale: 'es' | 'en') {
  commands.length = 0;
  document.body.innerHTML = '';
  (globalThis as Record<string, unknown>).erplora = {
    query: async () => null,
    queryAll: async () => [],
    queryPage: async () => ({ rows: [], total: 0 }),
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

type Wc = HTMLElement & {
  shadowRoot: ShadowRoot;
  updateComplete: Promise<unknown>;
  sdDate: string;
  sdName: string;
  ovStart: string;
  ovEnd: string;
  ovReason: string;
  createSpecialDay: (e: Event) => Promise<void>;
  createOverride: (e: Event) => Promise<void>;
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

const field = (el: Wc, testid: string) =>
  el.shadowRoot.querySelector(`[data-testid="${testid}"]`) as (HTMLElement & { value?: string }) | null;

const shown = (el: Wc, testid: string) => String(field(el, testid)?.value ?? '');

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

const DATE_FIELDS = ['schedules-special-date', 'schedules-override-from', 'schedules-override-to'];

const EXPECTED = {
  es: { christmas: '24/12/2026', typed: '03/04/2026', typedIso: '2026-04-03', loose: '3/4/2026', placeholder: 'dd/mm/aaaa' },
  en: { christmas: '12/24/2026', typed: '03/04/2026', typedIso: '2026-03-04', loose: '3/4/2026', placeholder: 'mm/dd/yyyy' },
} as const;

for (const locale of ['es', 'en'] as const) {
  const want = EXPECTED[locale];

  describe(`schedules#54 — the dates of the exceptions in the hub order (${locale})`, () => {
    beforeEach(() => install(locale));

    it('no date field is a native date input, whose order the browser decides', async () => {
      const el = await mount();
      for (const testid of DATE_FIELDS) {
        const input = field(el, testid);
        expect(input, `${testid} must be rendered`).toBeTruthy();
        expect(input!.getAttribute('type'), `${testid}: a native date field paints the browser locale`).toBe('text');
        // The phone keypad of a date: digits (a text keypad hides them behind a second layer).
        expect(input!.getAttribute('inputmode'), testid).toBe('numeric');
        // `fill="outline"` only paints its box in md mode (a no-op in ios).
        expect(input!.getAttribute('mode'), testid).toBe('md');
        expect(input!.getAttribute('autocomplete'), testid).toBe('off');
        expect(input!.getAttribute('placeholder'), testid).toBe(want.placeholder);
      }
    });

    it('a stored date is painted in the hub order', async () => {
      const el = await mount();
      el.sdDate = '2026-12-24';
      el.ovStart = '2026-12-24';
      el.ovEnd = '2026-12-24';
      await el.updateComplete;
      for (const testid of DATE_FIELDS) expect(shown(el, testid), testid).toBe(want.christmas);
    });

    it('a special day typed in the hub order is saved on that very day', async () => {
      const el = await mount();
      await type(el, 'schedules-special-date', want.typed);
      await type(el, 'schedules-special-name', 'Cierre');
      await el.createSpecialDay(new Event('submit'));
      const create = commands.find((c) => c.name === 'schedules.special_days.create');
      expect(create?.payload.date).toBe(want.typedIso);
    });

    it('digits only (the phone keypad has no slash) are read in the hub order', async () => {
      const el = await mount();
      await type(el, 'schedules-special-date', want.typed.replace(/\//g, ''));
      expect(el.sdDate).toBe(want.typedIso);
    });

    it('a temporary change typed in the hub order is saved on those very days', async () => {
      const el = await mount();
      await type(el, 'schedules-override-from', want.typed);
      await type(el, 'schedules-override-to', want.christmas);
      await type(el, 'schedules-override-reason', 'Obras');
      await el.createOverride(new Event('submit'));
      const create = commands.find((c) => c.name === 'schedules.overrides.create');
      expect(create?.payload.start_date).toBe(want.typedIso);
      expect(create?.payload.end_date).toBe('2026-12-24');
    });

    it('a half-typed date stays on screen and is not a date yet (the save stays off)', async () => {
      const el = await mount();
      await type(el, 'schedules-special-name', 'Cierre');
      await type(el, 'schedules-special-date', '24/12');
      expect(shown(el, 'schedules-special-date')).toBe('24/12');
      expect(el.sdDate).toBe('');
      expect(field(el, 'schedules-special-submit')?.hasAttribute('disabled')).toBe(true);
      // She finishes it: the date follows the text again.
      await type(el, 'schedules-special-date', want.loose);
      expect(el.sdDate).toBe(want.typedIso);
      expect(field(el, 'schedules-special-submit')?.hasAttribute('disabled')).toBe(false);
    });

    it('a date that stops being valid never keeps the last valid one', async () => {
      const el = await mount();
      await type(el, 'schedules-override-from', want.typed);
      await type(el, 'schedules-override-from', `${want.typed}9`);
      expect(el.ovStart).toBe('');
    });

    it('leaving the field repaints what she typed in the hub order', async () => {
      const el = await mount();
      for (const testid of DATE_FIELDS) {
        await type(el, testid, want.loose);
        expect(shown(el, testid), testid).toBe(want.loose);
        await leave(el, testid);
        expect(shown(el, testid), testid).toBe(want.typed);
      }
    });

    it('after a save the fields are empty again, not left with the typed text', async () => {
      const el = await mount();
      await type(el, 'schedules-special-date', want.loose);
      await type(el, 'schedules-special-name', 'Cierre');
      await el.createSpecialDay(new Event('submit'));
      expect(shown(el, 'schedules-special-date')).toBe('');

      await type(el, 'schedules-override-from', want.loose);
      await type(el, 'schedules-override-to', want.loose);
      await type(el, 'schedules-override-reason', 'Obras');
      await el.createOverride(new Event('submit'));
      expect(shown(el, 'schedules-override-from')).toBe('');
      expect(shown(el, 'schedules-override-to')).toBe('');
    });
  });
}
