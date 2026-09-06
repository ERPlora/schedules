// schedules#42 — the onboarding step lands where the week can actually be confirmed.
//
// The step this one replaces (`appointments`, slot 101, «Your working hours») pointed at
// `/m/appointments/appointments`: an agenda with nothing to configure on it. Half of why it was
// useless is that a checklist item is a PROMISE — «click here and you can finish this» — and the
// route is the whole promise. A manifest check cannot catch this on its own: every tab of this
// module is a legitimate `/m/schedules/<navId>`, so `settings` or `special_days` would pass a
// «is it one of ours?» assertion and still drop the shopkeeper on a screen with no week on it.
//
// So this file reads `setup.route` FROM THE MANIFEST, mounts the component on it, and requires the
// screen that comes up to be the one carrying the «these are default hours» notice — the sentence
// the step is asking the business to act on. Change the route to another tab and this goes red.
//
// AND AT THE THREE VIEWPORTS. On ≤834 px the tables of this screen open as cards
// (`defaultView`), so the notice sits next to a different layout on a phone than on a desktop; a
// step aimed at a salon owner is used on the tablet at the counter as often as on a laptop.
// ⚠️ happy-dom computes no layout: what is proven here is that the notice is RENDERED at each
// width, not that it is legible — that is the standing job of visual QA (3 viewports), not of a
// unit test that would otherwise claim more than it checks.
import { beforeEach, describe, expect, it } from 'vitest';

import manifest from '../../../module.json';
import enLocale from '../../../locales/en.json';
import esLocale from '../../../locales/es.json';

const CATALOG: Record<string, unknown> = { en: enLocale, es: esLocale };

// The week the installer plants (`seed/install.postgres.sql`), stamped as its author: this is the
// exact state the step exists for — hours the business has never looked at.
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

// The three widths the rest of the module is checked at (`routing-and-responsive.test.ts`): phone,
// tablet — the boundary where the tables flip to cards — and desktop.
const VIEWPORTS: [string, number][] = [
  ['phone', 390],
  ['tablet', 834],
  ['desktop', 1440],
];

type Wc = HTMLElement & { shadowRoot: ShadowRoot; updateComplete: Promise<unknown>; tab: string };

beforeEach(() => {
  document.body.innerHTML = '';
  (globalThis as Record<string, unknown>).erplora = {
    query: async () => ({ timezone: 'Europe/Madrid', week_starts_on: 1, slot_duration: 30, auto_close_enabled: 0 }),
    queryAll: async (name: string) => (name === 'schedules.business_hours.list' ? SEEDED : []),
    queryPage: async (name: string) => (name === 'schedules.business_hours.list' ? { rows: SEEDED, total: SEEDED.length } : { rows: [], total: 0 }),
    command: async () => ({}),
    on: () => () => {},
    locale: 'es',
    t: (catalog: Record<string, unknown>, key: string): string => {
      let cur: unknown = catalog['es'];
      for (const part of key.split('.')) cur = cur && typeof cur === 'object' ? (cur as Record<string, unknown>)[part] : undefined;
      return typeof cur === 'string' ? cur : key;
    },
  };
});

async function mountAtStepRoute(width: number): Promise<Wc> {
  // The route is read from the manifest, never retyped: the point is to pin the DECLARED route.
  window.history.replaceState({}, '', (manifest as { setup: { route: string } }).setup.route);
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
  await import('./erp-schedules-hours');
  const el = document.createElement('erp-schedules-hours') as Wc;
  document.body.appendChild(el);
  await el.updateComplete;
  await new Promise((r) => setTimeout(r, 0));
  await el.updateComplete;
  return el;
}

// The MESSAGE, not the whole banner: since schedules#43 the notice also carries the confirm
// action, whose label is part of the banner's `textContent` but not part of the sentence.
const notice = (el: Wc) => el.shadowRoot.querySelector('ok-inline-feedback[data-role="default-week"] [data-role="default-week-message"]');

describe('the checklist step lands on the screen that can finish it', () => {
  it('the declared route opens the Hours tab, the only one that carries the week', async () => {
    const el = await mountAtStepRoute(1440);
    expect(el.tab).toBe('hours');
  });

  for (const [name, width] of VIEWPORTS) {
    it(`on a ${name} (${width}px) the step's screen shows the week awaiting confirmation`, async () => {
      const el = await mountAtStepRoute(width);
      const feedback = notice(el);
      expect(feedback, `no default-week notice at ${width}px`).toBeTruthy();
      // Translated, not a key: the shopkeeper this step is aimed at reads Spanish (ADR-0055/0199).
      expect(feedback?.textContent?.trim()).toBe((esLocale as { ui: { defaultWeekNotice: string } }).ui.defaultWeekNotice);
    });
  }
});
