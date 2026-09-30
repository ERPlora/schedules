// schedules#57 — a mistyped date (or hour) is kept on screen with the field's own error.
//
// Leaving a date field of Special days / Temporary changes with a text that is not a real date
// («31/02/2026», a half-typed «24/12») emptied the field without a word: the draft was dropped on
// `ionChange` and the stored value was '' — the «Add» button stayed off and nobody said why. The
// hour fields of the three interval panels did the same («25:00» vanished on blur). The common
// form pattern (Shopify, Square): the text stays as typed and the field says it is not valid until
// it is fixed; while she is still typing, no error.
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
  { id: 't1', day_of_week: 1, position: 0, open_time: '10:00', close_time: '18:00', is_closed: 0, break_start: null, break_end: null },
];

function install(locale: 'es' | 'en') {
  commands.length = 0;
  document.body.innerHTML = '';
  const page = (name: string) => {
    const rows = name === 'schedules.business_hours.list' ? HOURS : [];
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
  sdDate: string;
  ovStart: string;
  ovEnd: string;
  sdClosed: boolean;
  ovClosed: boolean;
  bhIntervals: Interval[];
  sdIntervals: Interval[];
  createSpecialDay: (e: Event) => Promise<void>;
};

type Table = HTMLElement & { rows: Record<string, unknown>[] };

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

/** The field's own error as Ionic paints it: `error-text` shows only on `.ion-invalid.ion-touched`. */
function errorOf(el: Wc, testid: string): string | null {
  const input = field(el, testid)!;
  const flagged = input.classList.contains('ion-invalid') && input.classList.contains('ion-touched');
  const text = input.getAttribute('error-text');
  if (!flagged) {
    expect(text ?? '', `${testid}: an error-text without .ion-invalid is never shown`).toBe('');
    return null;
  }
  return text;
}

async function editDay(el: Wc, index: number) {
  const tbl = el.shadowRoot.querySelector('#tbl-hours') as Table;
  tbl.dispatchEvent(new CustomEvent('rowAction', { detail: { actionId: 'edit', row: tbl.rows[index] } }));
  await el.updateComplete;
}

const DATE_FIELDS = ['schedules-special-date', 'schedules-override-from', 'schedules-override-to'];

const EXPECTED = {
  // `hubOrderOnly` is a real date ONLY in the hub's day/month order: read the other way it is not one.
  es: { typed: '03/04/2026', loose: '3/4/2026', hubOrderOnly: '25/12/2026' },
  en: { typed: '03/04/2026', loose: '3/4/2026', hubOrderOnly: '12/25/2026' },
} as const;

describe('schedules#57 — the field errors are in both catalogs', () => {
  for (const key of ['ui.dateInvalid', 'ui.timeInvalid']) {
    it(`${key} is written in English and translated to Spanish`, () => {
      const en = lookup(enLocale, key);
      const es = lookup(esLocale, key);
      expect(en?.trim(), `${key} missing in en.json`).toBeTruthy();
      expect(es?.trim(), `${key} missing in es.json`).toBeTruthy();
      expect(es, `${key} left in English in es.json`).not.toBe(en);
    });
  }
});

for (const locale of ['es', 'en'] as const) {
  const want = EXPECTED[locale];
  const dateError = lookup(CATALOGS[locale], 'ui.dateInvalid');
  const timeError = lookup(CATALOGS[locale], 'ui.timeInvalid');

  describe(`schedules#57 — a mistyped date stays with its error (${locale})`, () => {
    beforeEach(() => install(locale));

    for (const bad of ['31/02/2026', '24/12']) {
      it(`«${bad}» stays on screen after leaving each date field, and the field says it is not a date`, async () => {
        const el = await mount('/m/schedules/special_days');
        for (const testid of DATE_FIELDS) {
          await type(el, testid, bad);
          await leave(el, testid);
          expect(shown(el, testid), `${testid}: what she typed must not vanish`).toBe(bad);
          expect(errorOf(el, testid), testid).toBe(dateError);
        }
        expect(el.sdDate).toBe('');
        expect(el.ovStart).toBe('');
        expect(el.ovEnd).toBe('');
      });
    }

    it('while she is still typing, no error yet', async () => {
      const el = await mount('/m/schedules/special_days');
      for (const testid of DATE_FIELDS) {
        await type(el, testid, '24/12');
        expect(errorOf(el, testid), testid).toBeNull();
      }
    });

    it('the Add button stays off while the date is wrong', async () => {
      const el = await mount('/m/schedules/special_days');
      await type(el, 'schedules-special-name', 'Cierre');
      await type(el, 'schedules-special-date', '31/02/2026');
      await leave(el, 'schedules-special-date');
      expect(field(el, 'schedules-special-submit')?.hasAttribute('disabled')).toBe(true);
    });

    it('fixing the date clears the error, and leaving repaints it in the hub order', async () => {
      const el = await mount('/m/schedules/special_days');
      for (const testid of DATE_FIELDS) {
        await type(el, testid, '31/02/2026');
        await leave(el, testid);
        await type(el, testid, want.loose);
        expect(errorOf(el, testid), `${testid}: a real date is no longer an error`).toBeNull();
        await leave(el, testid);
        expect(shown(el, testid), testid).toBe(want.typed);
        expect(errorOf(el, testid), testid).toBeNull();
      }
    });

    it('retyping a still-wrong date keeps the error; once fixed and left, the field starts fresh', async () => {
      const el = await mount('/m/schedules/special_days');
      for (const testid of DATE_FIELDS) {
        await type(el, testid, '31/02/2026');
        await leave(el, testid);
        await type(el, testid, '31/02/202');
        expect(errorOf(el, testid), `${testid}: still not a date, still said`).toBe(dateError);
        await type(el, testid, want.loose);
        await leave(el, testid);
        await type(el, testid, '24/12');
        expect(errorOf(el, testid), `${testid}: a new date being typed is not an error yet`).toBeNull();
      }
    });

    it('a date that is only real in the hub order is not an error', async () => {
      const el = await mount('/m/schedules/special_days');
      for (const testid of DATE_FIELDS) {
        await type(el, testid, want.hubOrderOnly);
        await leave(el, testid);
        expect(shown(el, testid), testid).toBe(want.hubOrderOnly);
        expect(errorOf(el, testid), `${testid}: read in the hub order, it is a date`).toBeNull();
      }
      expect(el.sdDate).toBe('2026-12-25');
      expect(el.ovStart).toBe('2026-12-25');
      expect(el.ovEnd).toBe('2026-12-25');
    });

    it('two wrong dates at once each keep their own error', async () => {
      const el = await mount('/m/schedules/special_days');
      for (const testid of DATE_FIELDS) {
        await type(el, testid, '31/02/2026');
        await leave(el, testid);
      }
      for (const testid of DATE_FIELDS) {
        expect(shown(el, testid), testid).toBe('31/02/2026');
        expect(errorOf(el, testid), `${testid}: leaving the next field must not silence this one`).toBe(dateError);
      }
    });

    it('leaving a date field empty is not an error (the Add button already says it is missing)', async () => {
      const el = await mount('/m/schedules/special_days');
      for (const testid of DATE_FIELDS) {
        await type(el, testid, '31/02/2026');
        await type(el, testid, '');
        await leave(el, testid);
        expect(shown(el, testid), testid).toBe('');
        expect(errorOf(el, testid), testid).toBeNull();
      }
    });

    it('after the fixed date is saved, the field is empty and without error', async () => {
      const el = await mount('/m/schedules/special_days');
      await type(el, 'schedules-special-name', 'Cierre');
      await type(el, 'schedules-special-date', '31/02/2026');
      await leave(el, 'schedules-special-date');
      await type(el, 'schedules-special-date', want.loose);
      await el.createSpecialDay(new Event('submit'));
      expect(commands.some((c) => c.name === 'schedules.special_days.create')).toBe(true);
      expect(shown(el, 'schedules-special-date')).toBe('');
      expect(errorOf(el, 'schedules-special-date')).toBeNull();
    });
  });

  describe(`schedules#57 — a mistyped hour stays with its error (${locale})`, () => {
    beforeEach(() => install(locale));

    it('the weekly panel keeps «25:00» after leaving and says it is not a time', async () => {
      const el = await mount('/m/schedules/hours');
      await editDay(el, 0);
      const testid = 'schedules-interval-close-hours-0';
      await type(el, testid, '25:00');
      expect(errorOf(el, testid), 'while typing, no error yet').toBeNull();
      await leave(el, testid);
      expect(shown(el, testid)).toBe('25:00');
      expect(errorOf(el, testid)).toBe(timeError);
      expect(el.bhIntervals[0].close_time).toBe('');
    });

    it('two wrong hours of the same line each keep their own error', async () => {
      const el = await mount('/m/schedules/hours');
      await editDay(el, 0);
      const both = ['schedules-interval-open-hours-0', 'schedules-interval-close-hours-0'];
      for (const testid of both) {
        await type(el, testid, '25:00');
        await leave(el, testid);
      }
      for (const testid of both) {
        expect(shown(el, testid), testid).toBe('25:00');
        expect(errorOf(el, testid), `${testid}: leaving the other hour must not silence this one`).toBe(timeError);
      }
    });

    it('fixing the hour clears the error', async () => {
      const el = await mount('/m/schedules/hours');
      await editDay(el, 0);
      const testid = 'schedules-interval-open-hours-0';
      await type(el, testid, '9:7');
      await leave(el, testid);
      expect(errorOf(el, testid)).toBe(timeError);
      await type(el, testid, '0930');
      expect(errorOf(el, testid)).toBeNull();
      await leave(el, testid);
      expect(errorOf(el, testid)).toBeNull();
      expect(el.bhIntervals[0].open_time).toBe('09:30');
    });

    it('retyping a still-wrong hour keeps the error; once fixed and left, the field starts fresh', async () => {
      const el = await mount('/m/schedules/hours');
      await editDay(el, 0);
      const testid = 'schedules-interval-close-hours-0';
      await type(el, testid, '25:00');
      await leave(el, testid);
      await type(el, testid, '25:0');
      expect(errorOf(el, testid), 'still not a time, still said').toBe(timeError);
      await type(el, testid, '1430');
      await leave(el, testid);
      await type(el, testid, '14:');
      expect(errorOf(el, testid), 'a new hour being typed is not an error yet').toBeNull();
    });

    it('pasting a real hour over a wrong one clears the error for good', async () => {
      const el = await mount('/m/schedules/hours');
      await editDay(el, 0);
      const testid = 'schedules-interval-open-hours-0';
      await type(el, testid, '25:00');
      await leave(el, testid);
      const paste = new Event('paste', { bubbles: true, composed: true, cancelable: true }) as Event & {
        clipboardData: { getData: () => string };
      };
      paste.clipboardData = { getData: () => '14:30' };
      field(el, testid)!.dispatchEvent(paste);
      await el.updateComplete;
      expect(el.bhIntervals[0].open_time).toBe('14:30');
      expect(errorOf(el, testid)).toBeNull();
      await type(el, testid, '9:');
      expect(errorOf(el, testid), 'a new hour being typed is not an error yet').toBeNull();
    });

    it('opening another day does not carry the error over', async () => {
      const el = await mount('/m/schedules/hours');
      await editDay(el, 0);
      await type(el, 'schedules-interval-close-hours-0', '25:00');
      await leave(el, 'schedules-interval-close-hours-0');
      await editDay(el, 1);
      expect(errorOf(el, 'schedules-interval-close-hours-0')).toBeNull();
      // Typing into the same field of the other day is a new hour being typed, not the old error.
      await type(el, 'schedules-interval-close-hours-0', '25:');
      expect(errorOf(el, 'schedules-interval-close-hours-0')).toBeNull();
    });

    it('a special day and a temporary change keep a mistyped hour with its error too', async () => {
      const el = await mount('/m/schedules/special_days');
      el.sdClosed = false;
      el.ovClosed = false;
      await el.updateComplete;
      for (const testid of ['schedules-interval-open-special-0', 'schedules-interval-close-override-0']) {
        await type(el, testid, '25:00');
        await leave(el, testid);
        expect(shown(el, testid), testid).toBe('25:00');
        expect(errorOf(el, testid), testid).toBe(timeError);
      }
    });
  });
}

describe('schedules#57 — an hour error does not knock the interval row out of line', () => {
  beforeEach(() => install('es'));

  it('the two hour boxes of a line align at the top, so the error under one does not lift it above the other', async () => {
    const el = await mount('/m/schedules/hours');
    const css = (el.constructor as unknown as { elementStyles: { cssText: string }[] }).elementStyles
      .map((s) => s.cssText).join('\n').replace(/\s+/g, ' ');
    expect(css).toMatch(/\.interval \{[^}]*align-items: ?flex-start/);
    // The «✕» keeps to the top too (centred on the box, not on box + error).
    expect(css).toMatch(/\.interval ion-button \{[^}]*align-self: ?flex-start/);
    // Every rule counts, not just the first block: a later one (a media query) must not re-centre them.
    const rows = [...css.matchAll(/\.interval \{([^}]*)\}/g)].map((m) => m[1]).filter((b) => /align-items/.test(b));
    expect(rows.every((b) => /align-items: ?flex-start/.test(b)), rows.join(' | ')).toBe(true);
    const crosses = [...css.matchAll(/\.interval ion-button \{([^}]*)\}/g)].map((m) => m[1]).filter((b) => /align-self/.test(b));
    expect(crosses.every((b) => /align-self: ?flex-start/.test(b)), crosses.join(' | ')).toBe(true);
  });
});
