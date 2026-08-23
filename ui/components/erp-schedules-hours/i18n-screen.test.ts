// schedules#29 — three half-translated details of the Horarios screen for a Spanish business:
//
//   1. the second table was TITLED «Overrides» (and its searcher «Buscar override…») — the
//      code's word, not the shopkeeper's;
//   2. dates painted in raw ISO (2026-08-25) while the rest of the hub speaks «25/08/2026»;
//   3. next to «Columnas», the Hours tab showed an EMPTY dropdown: the rows-per-page selector
//      with no value, because that view always paints the seven weekdays and never pages.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';

import esLocale from '../../../locales/es.json';
import enLocale from '../../../locales/en.json';

const es = esLocale;
const CATALOG: Record<string, unknown> = { es: esLocale, en: enLocale };

beforeEach(() => {
  // A faithful `t` (like the SDK's): walk the catalog by the active language and interpolate
  // `{param}` — the headings and the delete dialog reach the user THROUGH it, so an identity
  // mock would hide exactly what this file checks.
  const t = (catalog: Record<string, unknown>, key: string, params?: Record<string, unknown>): string => {
    const client = (globalThis as { erplora: { locale: string } }).erplora;
    const dict = (catalog[client?.locale] ?? catalog.en ?? {}) as Record<string, unknown>;
    let cur: unknown = dict;
    for (const part of key.split('.')) cur = cur && typeof cur === 'object' ? (cur as Record<string, unknown>)[part] : undefined;
    let out = typeof cur === 'string' ? cur : key;
    if (params) for (const [k, v] of Object.entries(params)) out = out.split(`{${k}}`).join(String(v));
    return out;
  };
  (globalThis as Record<string, unknown>).erplora = {
    query: async () => [],
    queryAll: async () => [],
    queryPage: async () => ({ rows: [], total: 0 }),
    command: async () => ({}),
    on: () => () => {},
    locale: 'es',
    t,
  };
});

type Wc = HTMLElement & { shadowRoot: ShadowRoot; updateComplete: Promise<unknown> };

type Table = HTMLElement & {
  pageSizeOptions: number[];
  columns: { key: string; format?: (row: Record<string, unknown>) => unknown }[];
};

async function mount(tab: 'hours' | 'special_days'): Promise<Wc> {
  window.history.replaceState({}, '', `/m/schedules/${tab}`);
  await import('./erp-schedules-hours');
  const el = document.createElement('erp-schedules-hours') as Wc;
  document.body.appendChild(el);
  await el.updateComplete;
  await new Promise((r) => setTimeout(r, 0));
  await el.updateComplete;
  return el;
}

const table = (el: Wc, id: string) => el.shadowRoot.querySelector(`#${id}`) as unknown as Table;

describe('1 — the overrides section speaks Spanish (schedules#29)', () => {
  it('the es catalog no longer titles the section with the code word «override»', () => {
    const ui = es.ui as Record<string, string>;
    // The section header and every user-facing string that named the concept.
    for (const key of ['overrides', 'searchOverride', 'addOverride', 'emptyOverrides', 'errorCreateOverride']) {
      expect(ui[key], `${key} still carries the untranslated loanword`).not.toMatch(/override/i);
    }
    expect(ui.overrides.length, 'a real heading, not an empty patch').toBeGreaterThan(3);
  });

  it('the special days screen paints the translated heading and searcher', async () => {
    const el = await mount('special_days');
    const texts = el.shadowRoot.textContent ?? '';
    expect(texts).not.toContain('Overrides');
    expect(texts).not.toContain('Buscar override');
    expect(texts).toContain(es.ui.overrides as string);
  });
});

describe('2 — dates paint in the locale of the hub, not ISO (schedules#29)', () => {
  it('the special day table formats its date column as 25/08/2026 in es', async () => {
    const el = await mount('special_days');
    const col = table(el, 'tbl-special').columns.find((c) => c.key === 'date')!;
    expect(col.format, 'the date column needs a format').toBeTruthy();
    expect(col.format!({ date: '2026-08-25' })).toBe('25/08/2026');
  });

  it('the override table formats both range columns, and a bad value falls through untouched', async () => {
    const el = await mount('special_days');
    const cols = table(el, 'tbl-override').columns;
    expect(cols.find((c) => c.key === 'start_date')!.format!({ start_date: '2026-08-27' })).toBe('27/08/2026');
    expect(cols.find((c) => c.key === 'end_date')!.format!({ end_date: '2026-08-29' })).toBe('29/08/2026');
    expect(cols.find((c) => c.key === 'start_date')!.format!({ start_date: 'not-a-date' })).toBe('not-a-date');
  });

  it('the same columns speak English when the hub runs in en', async () => {
    (globalThis as Record<string, unknown>).erplora = {
      ...((globalThis as Record<string, { erplora: object }>).erplora as object),
      locale: 'en',
    };
    const el = await mount('special_days');
    const col = table(el, 'tbl-special').columns.find((c) => c.key === 'date')!;
    expect(col.format!({ date: '2026-08-25' })).toBe('08/25/2026');
  });

  it('the delete dialog of an override without reason shows the range in locale format', async () => {
    const el = await mount('special_days');
    el.shadowRoot.querySelector('#tbl-override')!.dispatchEvent(
      new CustomEvent('rowAction', { detail: { actionId: 'delete', row: { id: 'o1', reason: '', start_date: '2026-08-28' } } }),
    );
    await el.updateComplete;
    // `message=${…}` is an attribute binding (a plain string), not a reflected property.
    const alert = el.shadowRoot.querySelector('ion-alert') as HTMLElement;
    const message = alert.getAttribute('message') ?? '';
    expect(message).toContain('28/08/2026');
    expect(message).not.toContain('2026-08-28');
  });
});

describe('3 — no empty rows-per-page dropdown on the Hours tab (schedules#29)', () => {
  it('the weekly table offers no page-size selector: it never pages (seven fixed rows)', async () => {
    const el = await mount('hours');
    expect(table(el, 'tbl-hours').pageSizeOptions, 'an empty list = the selector is not painted').toEqual([]);
  });

  it('the server-side tables keep their page-size selector', async () => {
    const el = await mount('special_days');
    expect(table(el, 'tbl-special').pageSizeOptions.length).toBeGreaterThan(0);
    expect(table(el, 'tbl-override').pageSizeOptions.length).toBeGreaterThan(0);
  });
});
