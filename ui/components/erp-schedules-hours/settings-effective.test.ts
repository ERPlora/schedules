// schedules#9 — the Settings tab shows what GOVERNS the module, and only that.
//
// Two things were wrong on this screen, and they are the same mistake twice: a control that does
// not decide anything.
//
//   1. A free-text `timezone` field with `Europe/Madrid` typed into it. The business zone belongs
//      to the CORE (hub#731) — declared in the hub settings or deduced from the country — and
//      since hub#1022 it reaches both the handlers (`context.timezone`) and this screen
//      (`erplora.timezone`). Typing another one here created a SECOND authority that nothing
//      obeyed: the engine kept using the hub's, so the value on screen was a lie the moment they
//      differed.
//   2. `slot_duration` and `auto_close_enabled`: stored, saved, painted — and read by NOBODY.
//      `slot_duration` is not even this module's business (schedules#8: the duration belongs to
//      the service; `reservations` has its own `time_slot_duration`), and nothing has ever acted
//      on the auto-close flag.
//
// What is left is `week_starts_on`, which now HAS a consumer: the weekly table starts on the day
// it names. A setting with no visible effect is indistinguishable from a broken one.
import { beforeEach, describe, expect, it } from 'vitest';

import enLocale from '../../../locales/en.json';
import esLocale from '../../../locales/es.json';

type Wc = HTMLElement & { shadowRoot: ShadowRoot; updateComplete: Promise<unknown> };

type Table = HTMLElement & { rows: Record<string, unknown>[] };

const commands: { name: string; payload: Record<string, unknown> }[] = [];

/** The client the shell injects, with the hub's own resolved zone (hub#1022). */
function stubSdk(options: { timezone?: string; settings?: unknown } = {}) {
  const { timezone = 'Atlantic/Canary', settings = [{ id: 's1', week_starts_on: 1 }] } = options;
  const client: Record<string, unknown> = {
    query: async (name: string) => (name === 'schedules.settings.get' ? settings : []),
    queryAll: async () => [],
    queryPage: async () => ({ rows: [], total: 0 }),
    command: async (name: string, payload: Record<string, unknown>) => {
      commands.push({ name, payload });
      return {};
    },
    on: () => () => {},
    locale: 'en',
    t: (_catalog: unknown, key: string) => key,
  };
  if (timezone) client.timezone = timezone;
  (globalThis as Record<string, unknown>).erplora = client;
}

beforeEach(() => {
  commands.length = 0;
  stubSdk();
});

async function mount(tab: 'settings' | 'hours' = 'settings'): Promise<Wc> {
  window.history.replaceState({}, '', `/m/schedules/${tab}`);
  await import('./erp-schedules-hours');
  const el = document.createElement('erp-schedules-hours') as Wc;
  document.body.appendChild(el);
  await el.updateComplete;
  await new Promise((r) => setTimeout(r, 0));
  await el.updateComplete;
  return el;
}

const text = (el: Wc) => el.shadowRoot.textContent ?? '';

const settingsOf = (el: Wc) => (el as unknown as { settings: Record<string, unknown> }).settings;

describe('the business timezone is SHOWN here and CHANGED in the hub — schedules#9', () => {
  it('the zone the hub resolved is on screen', async () => {
    const el = await mount();
    expect(text(el), 'the effective zone comes from the SDK, not from a stored copy').toContain(
      'Atlantic/Canary',
    );
  });

  it('there is no editable timezone control any more', async () => {
    const el = await mount();
    const inputs = [...el.shadowRoot.querySelectorAll('ion-input')];
    const labels = inputs.map((i) => i.getAttribute('label') ?? '');
    expect(labels, 'a second authority cannot be typed in').not.toContain('ui.placeholderTimezone');
    expect(settingsOf(el).timezone, 'the screen does not even keep a copy of it').toBeUndefined();
  });

  it('saving sends only the settings this module owns', async () => {
    const el = await mount();
    const form = el.shadowRoot.querySelector('form.settings') as HTMLFormElement;
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await el.updateComplete;
    const saved = commands.find((c) => c.name === 'schedules.settings.save');
    expect(saved, 'the form still saves').toBeTruthy();
    expect(Object.keys(saved!.payload).sort()).toEqual(['week_starts_on']);
  });

  it('it points at the hub settings, where the zone is really decided', async () => {
    const el = await mount();
    const link = el.shadowRoot.querySelector('[data-testid="schedules-settings-timezone-link"]') as HTMLElement;
    expect(link, 'a read-only value with no way to change it is a dead end').toBeTruthy();
    link.click();
    await el.updateComplete;
    expect(window.location.pathname + window.location.hash).toBe('/settings#hub');
  });

  it('an old shell that does not publish the zone does not blank the screen', async () => {
    stubSdk({ timezone: '' });
    const el = await mount();
    expect(text(el), 'no empty gap where the zone should be').toContain('ui.timezoneUnknown');
  });
});

describe('every visible setting has a consumer — schedules#9', () => {
  it('the inert controls are gone from the form', async () => {
    const el = await mount();
    const form = el.shadowRoot.querySelector('form.settings') as HTMLElement;
    const labels = [...form.querySelectorAll('ion-input, ion-select')].map(
      (c) => c.getAttribute('label') ?? '',
    );
    expect(labels, 'slot duration belongs to the service, not to the opening hours').not.toContain(
      'ui.placeholderSlotDuration',
    );
    expect(form.querySelector('ion-checkbox'), 'nothing acts on auto-close').toBeNull();
    expect(labels).toContain('ui.fieldWeekStart');
  });

  it('the weekly table starts on the day the setting names', async () => {
    stubSdk({ settings: [{ id: 's1', week_starts_on: 7 }] });
    const el = await mount('hours');
    const rows = (el.shadowRoot.querySelector('#tbl-hours') as Table).rows;
    expect(rows.map((r) => r.day_of_week), 'Sunday first, then Monday…Saturday').toEqual([
      6, 0, 1, 2, 3, 4, 5,
    ]);
  });

  it('Monday-first is the default and the seven days are always there', async () => {
    const el = await mount('hours');
    const rows = (el.shadowRoot.querySelector('#tbl-hours') as Table).rows;
    expect(rows.map((r) => r.day_of_week)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });
});

describe('the new copy is translated, not English-only (ADR-0055/0199)', () => {
  const KEYS = ['timezoneEffective', 'timezoneFromHub', 'timezoneUnknown', 'timezoneGoSettings'];

  for (const key of KEYS) {
    it(`ui.${key} exists in both catalogues`, () => {
      for (const [lang, catalog] of Object.entries({ en: enLocale, es: esLocale })) {
        const ui = (catalog as { ui: Record<string, string> }).ui;
        expect(ui[key] ?? '', `${lang}.json is missing ui.${key}`).not.toBe('');
      }
    });
  }

  it('the retired keys are gone from both catalogues', () => {
    for (const catalog of [enLocale, esLocale]) {
      const ui = (catalog as { ui: Record<string, string> }).ui;
      expect(ui.placeholderTimezone).toBeUndefined();
      expect(ui.placeholderSlotDuration).toBeUndefined();
      expect(ui.autoClose).toBeUndefined();
    }
  });
});
