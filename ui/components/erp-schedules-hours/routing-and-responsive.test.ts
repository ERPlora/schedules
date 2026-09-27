// schedules#6 — ONE architecture for the three sections, and no double navigation.
//
// module.json declares three navigation entries (`hours`, `special_days`, `settings`) that all
// mount `erp-schedules-hours`. Per ADR-0022 the SHELL owns the tabbar and the route
// (`/m/schedules/<navId>`, deep-linkable, back/forward via the router), so the component must:
//   · read the section from the route it was mounted on — never start at «hours» regardless;
//   · NOT paint its own `<nav><button>` row (that duplicated the shell's tabbar and the URL lied).
// Responsive: on ≤834 px every table opens in cards (status, effective hours and actions visible),
// destructive actions ask first, and the two exception collections are labelled apart.
import { beforeEach, describe, expect, it } from 'vitest';

const commands: { name: string; payload: Record<string, unknown> }[] = [];

const ROWS: Record<string, Record<string, unknown>[]> = {
  'schedules.business_hours.list': [
    { id: 'b1', day_of_week: 0, open_time: '09:00', close_time: '18:00', is_closed: 0, break_start: null, break_end: null },
  ],
  'schedules.special_days.list': [
    { id: 's1', date: '2026-12-25', name: 'Christmas', is_closed: 1, open_time: null, close_time: null, recurring_yearly: 1, notes: '' },
  ],
  'schedules.overrides.list': [
    { id: 'o1', start_date: '2026-08-01', end_date: '2026-08-15', reason: 'Holidays', open_time: null, close_time: null, is_closed: 1 },
  ],
};

beforeEach(() => {
  commands.length = 0;
  (globalThis as Record<string, unknown>).erplora = {
    query: async (name: string) => (name === 'schedules.settings.get' ? { timezone: 'Europe/Madrid', week_starts_on: 1, slot_duration: 30, auto_close_enabled: 0 } : []),
    queryAll: async (name: string) => ROWS[name] ?? [],
    queryPage: async (name: string) => ({ rows: ROWS[name] ?? [], total: (ROWS[name] ?? []).length }),
    command: async (name: string, payload: Record<string, unknown>) => {
      commands.push({ name, payload });
      return {};
    },
    on: () => () => {},
    locale: 'en',
    t: (_catalog: unknown, key: string) => key,
  };
});

type Wc = HTMLElement & { tab: string; updateComplete: Promise<unknown>; shadowRoot: ShadowRoot };

async function mountAt(path: string, width = 1440): Promise<Wc> {
  window.history.replaceState({}, '', path);
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
  await import('./erp-schedules-hours');
  const el = document.createElement('erp-schedules-hours') as Wc;
  document.body.appendChild(el);
  await el.updateComplete;
  await new Promise((r) => setTimeout(r, 0));
  await el.updateComplete;
  return el;
}

const tables = (el: Wc) => [...el.shadowRoot.querySelectorAll('ok-data-table')] as (HTMLElement & { defaultView?: string; id: string })[];

describe('the section comes from the route (ADR-0022), not from a hardcoded default', () => {
  it('/m/schedules/special_days mounts the special days section', async () => {
    const el = await mountAt('/m/schedules/special_days');
    expect(el.tab).toBe('special_days');
    expect(tables(el).map((t) => t.id)).toEqual(['tbl-special', 'tbl-override']);
  });

  it('/m/schedules/settings mounts the settings section', async () => {
    const el = await mountAt('/m/schedules/settings');
    expect(el.tab).toBe('settings');
    expect(tables(el)).toEqual([]);
    expect(el.shadowRoot.querySelector('form.settings')).toBeTruthy();
  });

  it('/m/schedules (no navId) and an unknown navId fall back to hours', async () => {
    expect((await mountAt('/m/schedules')).tab).toBe('hours');
    expect((await mountAt('/m/schedules/whatever')).tab).toBe('hours');
  });

  it('resolveNavId is a pure function of the path', async () => {
    const mod = await import('./erp-schedules-hours');
    expect(mod.resolveNavId('/m/schedules/special_days')).toBe('special_days');
    expect(mod.resolveNavId('/m/schedules/settings/')).toBe('settings');
    expect(mod.resolveNavId('/m/schedules/hours?x=1')).toBe('hours');
    expect(mod.resolveNavId('/other/thing')).toBe('hours');
  });

  it('paints NO internal nav: the shell tabbar is the only navigation', async () => {
    const el = await mountAt('/m/schedules/hours');
    expect(el.shadowRoot.querySelectorAll('nav, nav button, ion-segment').length, 'double navigation: the shell already paints the tabbar').toBe(0);
  });
});

describe('responsive operation (390/834 → cards; 1440 → table)', () => {
  it('every table opens in cards on a phone and in table on desktop', async () => {
    const phone = await mountAt('/m/schedules/special_days', 390);
    expect(tables(phone).map((t) => t.defaultView)).toEqual(['cards', 'cards']);
    const hoursPhone = await mountAt('/m/schedules/hours', 834);
    expect(tables(hoursPhone).map((t) => t.defaultView)).toEqual(['cards']);
    const desktop = await mountAt('/m/schedules/special_days', 1440);
    expect(tables(desktop).map((t) => t.defaultView)).toEqual(['table', 'table']);
  });

  it('the two exception collections are labelled apart', async () => {
    const el = await mountAt('/m/schedules/special_days');
    const headings = [...el.shadowRoot.querySelectorAll('h3')].map((h) => h.textContent?.trim());
    expect(headings).toEqual(['ui.specialDays', 'ui.overrides']);
  });
});

describe('destructive actions ask first and explain', () => {
  it('deleting a special day opens a confirmation and only deletes on confirm', async () => {
    const el = await mountAt('/m/schedules/special_days');
    const [special] = tables(el);
    special.dispatchEvent(new CustomEvent('rowAction', { detail: { actionId: 'delete', row: ROWS['schedules.special_days.list'][0] } }));
    await el.updateComplete;
    const alert = el.shadowRoot.querySelector('ion-alert') as HTMLElement & { isOpen: boolean };
    expect(alert?.isOpen).toBe(true);
    expect(alert.getAttribute('message')).toContain('ui.deleteConfirmMessage');
    expect(commands).toEqual([]);
    await (el as unknown as { onDeleteDismiss: (ev: CustomEvent<{ role?: string }>) => Promise<void> }).onDeleteDismiss(new CustomEvent('dismiss', { detail: { role: 'confirm' } }));
    expect(commands).toContainEqual({ name: 'schedules.special_days.delete', payload: { special_day_id: 's1' } });
  });

  it('cancelling deletes nothing', async () => {
    const el = await mountAt('/m/schedules/special_days');
    const [, overrides] = tables(el);
    overrides.dispatchEvent(new CustomEvent('rowAction', { detail: { actionId: 'delete', row: ROWS['schedules.overrides.list'][0] } }));
    await el.updateComplete;
    await (el as unknown as { onDeleteDismiss: (ev: CustomEvent<{ role?: string }>) => Promise<void> }).onDeleteDismiss(new CustomEvent('dismiss', { detail: { role: 'cancel' } }));
    expect(commands).toEqual([]);
  });

  it('errors are announced through ok-inline-feedback, not a bare paragraph', async () => {
    const el = await mountAt('/m/schedules/hours');
    (el as unknown as { pageError: string }).pageError = 'boom';
    await el.updateComplete;
    expect(el.shadowRoot.querySelector('ok-inline-feedback[tone="danger"]')?.textContent).toContain('boom');
    expect(el.shadowRoot.querySelector('p.err')).toBeNull();
  });
});
