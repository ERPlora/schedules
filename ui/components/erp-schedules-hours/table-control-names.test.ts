// schedules#58 (from outfitkit#247) — each list on «Special days» names its OWN toolbar buttons.
//
// The tab shows two lists on the same page: special days and temporary changes. Both are an
// `<ok-data-table>` with the same toolbar, and the table names its buttons with its own defaults
// («View as list», «View as cards», «Filters», «Add», «Visible columns», «Rows per page»). A
// screen-reader user heard every one of those names twice and could not tell which list a button
// belonged to. The table takes per-instance names through `.labels` (outfitkit#247), so each list
// passes its own, in `en` and `es`.
//
// The test mounts the screen with the REAL OutfitKit table and reads what it paints: the
// `aria-label` of every toolbar control and the text of the «Add» button.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import esLocale from '../../../locales/es.json';
import enLocale from '../../../locales/en.json';

type Lang = 'es' | 'en';
const CATALOGS: Record<Lang, Record<string, unknown>> = { es: esLocale, en: enLocale };

const lookup = (catalog: Record<string, unknown>, key: string): string => {
  const hit = key.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], catalog);
  return typeof hit === 'string' ? hit : key;
};

const useLang = (lang: Lang) => {
  document.documentElement.lang = lang;
  (globalThis as Record<string, unknown>).erplora = {
    query: async () => null,
    queryAll: async () => [],
    queryPage: async () => ({ rows: [], total: 0 }),
    command: async () => ({}),
    on: () => () => {},
    locale: lang,
    t: (catalog: Record<string, Record<string, unknown>>, key: string) => lookup(catalog[lang], key),
  };
};

type Screen = HTMLElement & { tab: string; updateComplete: Promise<unknown>; shadowRoot: ShadowRoot };
type Table = HTMLElement & { updateComplete: Promise<unknown>; shadowRoot: ShadowRoot };

const settle = () => new Promise((r) => setTimeout(r, 0));

async function mountSpecialDays(): Promise<Screen> {
  await import('./erp-schedules-hours');
  const el = document.createElement('erp-schedules-hours') as Screen;
  document.body.appendChild(el);
  await el.updateComplete;
  await settle();
  el.tab = 'special_days';
  await el.updateComplete;
  for (const id of ['tbl-special', 'tbl-override']) await (el.shadowRoot.querySelector(`#${id}`) as Table).updateComplete;
  await settle();
  return el;
}

/** The names a screen reader announces for one table's toolbar. */
function toolbarNames(el: Screen, id: string): string[] {
  const root = (el.shadowRoot.querySelector(`#${id}`) as Table).shadowRoot;
  const labelled = [...root.querySelectorAll('ion-button.toolbtn, ion-select')].map((n) => n.getAttribute('aria-label') ?? '');
  const add = root.querySelector('ion-button.add-btn')?.textContent?.trim() ?? '';
  return [...labelled, add].filter(Boolean);
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('each list on Special days names its own toolbar buttons (schedules#58)', () => {
  describe.each(['es', 'en'] as const)('in %s', (lang) => {
    beforeEach(() => useLang(lang));

    it('no toolbar name is said by both lists', async () => {
      const el = await mountSpecialDays();
      const special = toolbarNames(el, 'tbl-special');
      const override = toolbarNames(el, 'tbl-override');
      // The toolbar did paint: view toggle (2), filters, columns, rows per page and «Add».
      expect(special.length).toBe(6);
      expect(override.length).toBe(6);
      expect(special.filter((n) => override.includes(n))).toEqual([]);
      expect(new Set([...special, ...override]).size).toBe(12);
    });

    it('each list says its own name in the language of the hub', async () => {
      const el = await mountSpecialDays();
      const ui = (CATALOGS[lang] as { ui: Record<string, string> }).ui;
      expect(toolbarNames(el, 'tbl-special')).toEqual(
        expect.arrayContaining([ui.viewSpecialDaysAsList, ui.viewSpecialDaysAsCards, ui.filterSpecialDays, ui.newSpecialDay, ui.specialDaysColumns, ui.specialDaysRowsPerPage]),
      );
      expect(toolbarNames(el, 'tbl-override')).toEqual(
        expect.arrayContaining([ui.viewOverridesAsList, ui.viewOverridesAsCards, ui.filterOverrides, ui.newOverride, ui.overridesColumns, ui.overridesRowsPerPage]),
      );
    });

    // Having the right names is not enough: «View as cards» on the list button is still wrong. Each
    // name is checked on the control that does what it says (the view buttons by pressing them).
    it.each([
      ['tbl-special', ['viewSpecialDaysAsList', 'viewSpecialDaysAsCards', 'filterSpecialDays', 'newSpecialDay', 'specialDaysColumns', 'specialDaysRowsPerPage']],
      ['tbl-override', ['viewOverridesAsList', 'viewOverridesAsCards', 'filterOverrides', 'newOverride', 'overridesColumns', 'overridesRowsPerPage']],
    ] as const)('%s puts each name on the control that does it', async (id, [list, cards, filters, add, columns, rows]) => {
      const el = await mountSpecialDays();
      const ui = (CATALOGS[lang] as { ui: Record<string, string> }).ui;
      const table = el.shadowRoot.querySelector(`#${id}`) as Table;
      const root = table.shadowRoot;
      const named = (name: string) => root.querySelector(`ion-button.toolbtn[aria-label="${name}"]`) as HTMLElement | null;

      expect(root.querySelector('ion-select.tk-cols')?.getAttribute('aria-label')).toBe(ui[columns]);
      expect(root.querySelector('ion-select.tk-psize')?.getAttribute('aria-label')).toBe(ui[rows]);
      expect(root.querySelector('ion-button.add-btn')?.textContent?.trim()).toBe(ui[add]);
      // The filters button is the one toolbar button that is not a view toggle.
      expect([...root.querySelectorAll('ion-button.toolbtn:not([aria-pressed])')].map((n) => n.getAttribute('aria-label'))).toEqual([ui[filters]]);

      // Pressing a view button marks that same button, whatever it is called: what tells them apart
      // is the view the table switches to.
      const views: string[] = [];
      table.addEventListener('viewChange', (e) => views.push(String((e as CustomEvent).detail)));
      for (const [pick, other] of [[cards, list], [list, cards]] as const) {
        named(ui[pick])!.click();
        await table.updateComplete;
        expect(named(ui[pick])?.getAttribute('aria-pressed'), `${ui[pick]} pressed`).toBe('true');
        expect(named(ui[other])?.getAttribute('aria-pressed'), `${ui[other]} not pressed`).toBe('false');
      }
      expect(views.slice(-2)).toEqual(['cards', 'table']);
    });
  });

  it('every new name exists in en and in es, translated', () => {
    const keys = [
      'viewSpecialDaysAsList', 'viewSpecialDaysAsCards', 'filterSpecialDays', 'newSpecialDay', 'specialDaysColumns', 'specialDaysRowsPerPage',
      'viewOverridesAsList', 'viewOverridesAsCards', 'filterOverrides', 'newOverride', 'overridesColumns', 'overridesRowsPerPage',
    ];
    const en = (enLocale as { ui: Record<string, string> }).ui;
    const es = (esLocale as { ui: Record<string, string> }).ui;
    for (const k of keys) {
      expect(typeof en[k], `en ui.${k}`).toBe('string');
      expect(typeof es[k], `es ui.${k}`).toBe('string');
      expect(es[k], `ui.${k} translated`).not.toBe(en[k]);
    }
  });
});
