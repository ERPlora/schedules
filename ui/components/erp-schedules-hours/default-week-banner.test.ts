// schedules#36 — the Hours tab says out loud that the week it is showing is OURS, not the
// business's, until somebody confirms it.
//
// Installing the module now seeds a default week (Mon–Fri 09:00–18:00, weekend closed) so that
// `no_hours` stops being a reachable state. That fixes the hole appointments#102/#105 left open —
// its booking door can finally refuse — but it also means the door starts refusing against hours
// NOBODY CHOSE. A salon that opens on Saturday and never touched this screen would see bookings
// rejected with no idea why. So the screen has to name the guess while it is still a guess.
//
// How the screen tells them apart, with no extra column: `apply_module_seed` stamps the audit as
// the installer (`current_user_id` = 'system', crates/runtime/src/seed.rs — the only place in the
// runtime that uses that sentinel), while saving a day through `schedules.business_hours.set`
// stamps the real user. A week whose every live row is still the installer's is a week nobody has
// confirmed.
import { beforeEach, describe, expect, it } from 'vitest';

import esLocale from '../../../locales/es.json';
import enLocale from '../../../locales/en.json';

const CATALOG: Record<string, unknown> = { es: esLocale, en: enLocale };

// The seeded week, as `seed/install.postgres.sql` writes it.
const SEEDED = [0, 1, 2, 3, 4, 5, 6].map((day) => ({
  id: `hub|schedhours|${day}`,
  day_of_week: day,
  position: 0,
  open_time: day < 5 ? '09:00' : '00:00',
  close_time: day < 5 ? '18:00' : '00:00',
  is_closed: day < 5 ? 0 : 1,
  break_start: null,
  break_end: null,
  created_by: 'system',
}));

let hoursRows: Record<string, unknown>[] = [];
let commandCalls: { name: string; payload: unknown }[] = [];
let commandImpl: (name: string, payload: unknown) => Promise<unknown> = async () => ({});

/** The week as it comes back once a person has signed it: `set`/`confirm_week` clear the day and
 *  re-insert it stamped with the real user, so the rows are NEW rows with a NEW author. */
const SIGNED = SEEDED.map((r, i) => ({ ...r, id: `signed-${i}`, created_by: 'u-owner' }));

function install(locale: 'es' | 'en') {
  // A faithful `t`, like the SDK's: an identity mock would hide the very thing this file checks,
  // which is that the sentence reaches the shopkeeper IN THEIR LANGUAGE.
  const t = (catalog: Record<string, unknown>, key: string, params?: Record<string, unknown>): string => {
    const dict = (catalog[locale] ?? catalog.en ?? {}) as Record<string, unknown>;
    let cur: unknown = dict;
    for (const part of key.split('.')) cur = cur && typeof cur === 'object' ? (cur as Record<string, unknown>)[part] : undefined;
    let out = typeof cur === 'string' ? cur : key;
    if (params) for (const [k, v] of Object.entries(params)) out = out.split(`{${k}}`).join(String(v));
    return out;
  };
  (globalThis as Record<string, unknown>).erplora = {
    query: async (name: string) =>
      name === 'schedules.settings.get' ? { timezone: 'Europe/Madrid', week_starts_on: 1, slot_duration: 30, auto_close_enabled: 0 } : [],
    queryAll: async (name: string) => (name === 'schedules.business_hours.list' ? hoursRows : []),
    queryPage: async (name: string) => (name === 'schedules.business_hours.list' ? { rows: hoursRows, total: hoursRows.length } : { rows: [], total: 0 }),
    command: async (name: string, payload: unknown) => {
      commandCalls.push({ name, payload });
      return commandImpl(name, payload);
    },
    on: () => () => {},
    locale,
    t,
  };
}

type Wc = HTMLElement & { shadowRoot: ShadowRoot; updateComplete: Promise<unknown>; tab: string };

async function mount(tab: 'hours' | 'special_days' | 'settings' = 'hours'): Promise<Wc> {
  window.history.replaceState({}, '', `/m/schedules/${tab}`);
  await import('./erp-schedules-hours');
  const el = document.createElement('erp-schedules-hours') as Wc;
  document.body.appendChild(el);
  await el.updateComplete;
  await new Promise((r) => setTimeout(r, 0));
  el.tab = tab;
  await el.updateComplete;
  return el;
}

const banner = (el: Wc) => el.shadowRoot.querySelector('ok-inline-feedback[data-role="default-week"]');

beforeEach(() => {
  document.body.innerHTML = '';
  hoursRows = [];
  commandCalls = [];
  commandImpl = async () => ({});
  install('es');
});

describe('the screen flags the week nobody has confirmed yet', () => {
  it('paints the notice when every live day is still the one the installer seeded', async () => {
    hoursRows = SEEDED;
    const el = await mount('hours');

    const note = banner(el);
    expect(note, 'the Hours tab must warn that these hours are a default, not the business’s').not.toBeNull();
    expect(note?.getAttribute('tone')).toBe('warning');
  });

  it('drops the notice as soon as the owner saves one day', async () => {
    // `set_business_hours` clears the day and re-inserts it stamped with the real user.
    hoursRows = SEEDED.map((r) => (r.day_of_week === 5 ? { ...r, id: 'sat-real', open_time: '10:00', close_time: '14:00', is_closed: 0, created_by: 'u-owner' } : r));
    const el = await mount('hours');

    expect(banner(el), 'once a person has touched the week it is no longer our guess').toBeNull();
  });

  it('says nothing on a hub that has no weekly rows at all', async () => {
    // A hub older than the seed: there is no default to confirm, and the table's own empty state
    // ("No schedule configured") already speaks. Warning here would invent a week that is not there.
    hoursRows = [];
    const el = await mount('hours');

    expect(banner(el)).toBeNull();
  });

  it('belongs to the Hours tab only', async () => {
    hoursRows = SEEDED;
    for (const tab of ['special_days', 'settings'] as const) {
      document.body.innerHTML = '';
      const el = await mount(tab);
      expect(banner(el), `the ${tab} tab is not where opening hours are confirmed`).toBeNull();
    }
  });
});

describe('the notice is translated, not hardcoded (ADR-0055/0199)', () => {
  it('reaches a Spanish business in Spanish', async () => {
    hoursRows = SEEDED;
    const el = await mount('hours');

    const es = (esLocale.ui as Record<string, string>).defaultWeekNotice;
    const en = (enLocale.ui as Record<string, string>).defaultWeekNotice;
    expect(es, 'the key must exist in the es catalog').toBeTruthy();
    expect(es).not.toBe(en);
    expect(banner(el)?.textContent).toContain(es);
    expect(banner(el)?.textContent, 'the English source must not leak into a Spanish hub').not.toContain(en);
  });

  it('reaches an English business in English', async () => {
    hoursRows = SEEDED;
    install('en');
    const el = await mount('hours');

    expect(banner(el)?.textContent).toContain((enLocale.ui as Record<string, string>).defaultWeekNotice);
  });

  it('carries the same catalog the rest of the screen uses', () => {
    for (const [lang, locale] of Object.entries(CATALOG)) {
      const ui = (locale as { ui: Record<string, string> }).ui;
      expect(ui.defaultWeekNotice, `${lang} is missing the notice`).toBeTruthy();
      expect(ui.defaultWeekNotice.length, `${lang}'s notice is a placeholder`).toBeGreaterThan(20);
    }
  });
});

// schedules#43 — and it lets the business say YES to it in one gesture.
//
// The step «Confirm your opening hours» is ticked by the rows a PERSON signed, so a salon whose
// real week IS the default one had nothing to press: the only way out was to open a day and save
// it back unchanged, which nobody understands. The notice now carries the button that signs it.
const confirmButton = (el: Wc) => el.shadowRoot.querySelector('ok-inline-feedback[data-role="default-week"] [data-action="confirm-week"]') as HTMLElement | null;

const dangerBanners = (el: Wc) => [...el.shadowRoot.querySelectorAll('ok-inline-feedback[tone="danger"]')].map((n) => n.textContent ?? '');

describe('the business can accept the week it was given, in one gesture', () => {
  it('offers the button inside the notice, where the week is questioned', async () => {
    hoursRows = SEEDED;
    const el = await mount('hours');

    const button = confirmButton(el);
    expect(button, 'the notice must carry the way out of it, not just the complaint').not.toBeNull();
    expect(button?.getAttribute('slot'), 'it belongs to the banner’s actions slot').toBe('actions');
    // ADR-0143: `fill="outline"` is a no-op on form controls in ios mode, and this is the primary
    // action of the notice — it must not be painted as a ghost.
    expect(button?.getAttribute('fill')).not.toBe('clear');
  });

  it('signs the whole week with ONE command that carries no hours of its own', async () => {
    hoursRows = SEEDED;
    const el = await mount('hours');

    confirmButton(el)?.click();
    await el.updateComplete;
    await new Promise((r) => setTimeout(r, 0));

    expect(commandCalls.map((c) => c.name)).toEqual(['schedules.business_hours.confirm_week']);
    // The week to sign is the one the RUNTIME pre-loads (`reads`); a payload of hours here would
    // let the browser sign a week nobody was ever shown.
    expect(commandCalls[0].payload ?? {}).toEqual({});
  });

  it('drops the notice once the week comes back signed', async () => {
    hoursRows = SEEDED;
    commandImpl = async () => {
      hoursRows = SIGNED;
      return { confirmed_days: 7 };
    };
    const el = await mount('hours');

    confirmButton(el)?.click();
    await new Promise((r) => setTimeout(r, 0));
    await el.updateComplete;

    expect(banner(el), 'the week is the business’s now: the warning has nothing left to say').toBeNull();
    // And not one opening hour moved: confirming is a signature, never an edit.
    expect(hoursRows.map((r) => [r.day_of_week, r.open_time, r.close_time, r.is_closed])).toEqual(
      SEEDED.map((r) => [r.day_of_week, r.open_time, r.close_time, r.is_closed]),
    );
  });

  it('keeps the notice and says why when the hub refuses', async () => {
    hoursRows = SEEDED;
    commandImpl = async () => {
      const e = new Error('There are no weekly opening hours to confirm') as Error & { code: string };
      e.code = 'schedules.missing_hours';
      throw e;
    };
    const el = await mount('hours');

    confirmButton(el)?.click();
    await new Promise((r) => setTimeout(r, 0));
    await el.updateComplete;

    expect(banner(el), 'nothing was signed, so the week is still ours').not.toBeNull();
    expect(confirmButton(el)?.hasAttribute('disabled'), 'the button has to be pressable again').toBe(false);
    const refusal = (esLocale.errors as Record<string, string>)['schedules.missing_hours'];
    expect(refusal, 'the code must be in the es catalog').toBeTruthy();
    expect(dangerBanners(el).join(' '), 'a refusal nobody can read is a failure that did not happen').toContain(refusal);
  });

  it('reaches the shopkeeper in their own language', async () => {
    hoursRows = SEEDED;
    const es = (esLocale.ui as Record<string, string>).confirmWeek;
    const en = (enLocale.ui as Record<string, string>).confirmWeek;
    expect(es, 'the key must exist in the es catalog').toBeTruthy();
    expect(en, 'the key must exist in the en catalog').toBeTruthy();
    expect(es).not.toBe(en);

    const spanish = await mount('hours');
    expect(confirmButton(spanish)?.textContent?.trim()).toContain(es);
    expect(confirmButton(spanish)?.textContent, 'the English source must not leak into a Spanish hub').not.toContain(en);

    document.body.innerHTML = '';
    install('en');
    const english = await mount('hours');
    expect(confirmButton(english)?.textContent?.trim()).toContain(en);
  });

  it('is not offered when there is no week of ours to confirm', async () => {
    // Already signed, and a hub older than the seed: in both the notice is gone and so is its
    // button — a «confirm» that writes nothing would tick the checklist over an empty table.
    for (const rows of [SIGNED, []]) {
      document.body.innerHTML = '';
      hoursRows = rows;
      const el = await mount('hours');
      expect(confirmButton(el)).toBeNull();
    }
  });
});
