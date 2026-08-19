// Contrato de las BARRAS de la vista de horarios del negocio (3 pestañas).
//
// Toda alta de FILA vive DENTRO de su `ok-data-table`, detrás del «+» de su barra (panel
// `slot="create"`), como en /employees del core y en el CRUD de productos de `inventory`:
//   · pestaña «Horario»       → el upsert del día (`schedules.business_hours.set`) es el alta/edición
//                                de una fila de esa tabla → panel de esa tabla.
//   · pestaña «Días especiales» → dos tablas (días especiales y excepciones), cada una con SU panel.
//   · pestaña «Ajustes»        → NO es el alta de ninguna fila: es configuración del módulo. Su
//                                formulario se queda FUERA de cualquier tabla, a propósito.
// La vista tampoco pinta título propio ni pestañas propias (schedules#6): el shell pinta ambos.
import { beforeEach, describe, expect, it } from 'vitest';

const comandos: { name: string; payload: Record<string, unknown> }[] = [];

const FILAS: Record<string, Record<string, unknown>[]> = {
  'schedules.business_hours.list': [
    { id: 'b1', day_of_week: 0, open_time: '09:00', close_time: '18:00', is_closed: 0, break_start: null, break_end: null },
  ],
  'schedules.special_days.list': [
    { id: 's1', date: '2026-12-25', name: 'Navidad', is_closed: 1, open_time: null, close_time: null, recurring_yearly: 1, notes: '' },
  ],
  'schedules.overrides.list': [
    { id: 'o1', start_date: '2026-08-01', end_date: '2026-08-15', reason: 'Vacaciones', open_time: null, close_time: null, is_closed: 1 },
  ],
};

beforeEach(() => {
  comandos.length = 0;
  (globalThis as Record<string, unknown>).erplora = {
    query: async (name: string) =>
      name === 'schedules.settings.get'
        ? { timezone: 'Europe/Madrid', week_starts_on: 1, slot_duration: 30, auto_close_enabled: 0 }
        : [],
    queryPage: async (name: string) => ({ rows: FILAS[name] ?? [], total: (FILAS[name] ?? []).length }),
    command: async (name: string, payload: Record<string, unknown>) => {
      comandos.push({ name, payload });
      return {};
    },
    on: () => () => {},
    locale: 'es',
    t: (_catalog: unknown, key: string) => key,
  };
});

type Tabla = HTMLElement & { addable: boolean; fill: boolean };

async function montar(tab: 'hours' | 'special_days' | 'settings' = 'hours') {
  await import('./erp-schedules-hours');
  const el = document.createElement('erp-schedules-hours') as HTMLElement & {
    tab: string;
    updateComplete: Promise<unknown>;
    shadowRoot: ShadowRoot;
  };
  document.body.appendChild(el);
  await el.updateComplete;
  await new Promise((r) => setTimeout(r, 0));
  el.tab = tab;
  await el.updateComplete;
  return el;
}

const tablas = (el: HTMLElement & { shadowRoot: ShadowRoot }) =>
  [...el.shadowRoot.querySelectorAll('ok-data-table')] as Tabla[];

const formulariosSueltos = (el: HTMLElement & { shadowRoot: ShadowRoot }) =>
  [...el.shadowRoot.querySelectorAll('form')].filter((f) => !f.closest('ok-data-table'));

describe('pestaña «Horario»: el día se edita DENTRO de la tabla', () => {
  it('la tabla declara `addable` y `fill`', async () => {
    const el = await montar('hours');
    expect(tablas(el)[0]?.addable, 'sin `addable` no hay «+» en la barra de la tabla').toBe(true);
    expect(tablas(el)[0]?.fill).toBe(true);
  });

  it('el formulario del día se proyecta en el panel `create` de la tabla', async () => {
    const el = await montar('hours');
    const form = el.shadowRoot.querySelector('form[slot="create"]');
    expect(form, 'el formulario del día no está en el slot `create`').toBeTruthy();
    expect(form?.closest('ok-data-table')).toBeTruthy();
    expect(formulariosSueltos(el), 'queda un formulario suelto encima de la tabla').toEqual([]);
  });

  it('guardar el día sigue mandando schedules.business_hours.set', async () => {
    const el = await montar('hours');
    const wc = el as unknown as { bhDay: number; bhOpen: string; bhClose: string; saveBusinessHours: (e: Event) => Promise<void> };
    wc.bhDay = 2;
    wc.bhOpen = '10:00';
    wc.bhClose = '20:00';
    await wc.saveBusinessHours(new Event('submit'));

    const cmd = comandos.find((c) => c.name === 'schedules.business_hours.set');
    expect(cmd, 'no se mandó el upsert del día').toBeTruthy();
    expect(cmd!.payload.day_of_week).toBe(2);
    expect(cmd!.payload.open_time).toBe('10:00');
  });
});

describe('pestaña «Días especiales»: cada tabla lleva su propia alta dentro', () => {
  it('las dos tablas declaran `addable` y `fill`, y cada una tiene su panel `create`', async () => {
    const el = await montar('special_days');
    const t = tablas(el);
    expect(t.length, 'faltan tablas en la pestaña de días especiales').toBe(2);
    expect(t.every((x) => x.addable && x.fill), 'alguna tabla no es `addable`/`fill`').toBe(true);
    expect(t.every((x) => !!x.querySelector('form[slot="create"]')), 'alguna tabla no tiene su formulario de alta dentro').toBe(true);
    expect(formulariosSueltos(el), 'quedan formularios sueltos encima de las tablas').toEqual([]);
  });

  it('las altas siguen mandando sus comandos', async () => {
    const el = await montar('special_days');
    const wc = el as unknown as {
      sdDate: string;
      sdName: string;
      ovStart: string;
      ovEnd: string;
      ovReason: string;
      createSpecialDay: (e: Event) => Promise<void>;
      createOverride: (e: Event) => Promise<void>;
    };
    wc.sdDate = '2026-12-25';
    wc.sdName = 'Navidad';
    await wc.createSpecialDay(new Event('submit'));
    wc.ovStart = '2026-08-01';
    wc.ovEnd = '2026-08-15';
    wc.ovReason = 'Vacaciones';
    await wc.createOverride(new Event('submit'));

    expect(comandos.find((c) => c.name === 'schedules.special_days.create')?.payload.name).toBe('Navidad');
    expect(comandos.find((c) => c.name === 'schedules.overrides.create')?.payload.reason).toBe('Vacaciones');
  });
});

// schedules#7: the payloads the forms send must match the schema + handler contract.
describe('schedules#7: los formularios mandan EXACTAMENTE lo que el contrato acepta', () => {
  type SpecialDayForm = HTMLElement & {
    sdDate: string; sdName: string; sdClosed: boolean; sdOpen: string; sdClose: string;
    sdRecurring: boolean; sdNotes: string; formError: string;
    createSpecialDay: (e: Event) => Promise<void>;
  };
  type OverrideForm = HTMLElement & {
    ovStart: string; ovEnd: string; ovReason: string; ovClosed: boolean; ovOpen: string; ovClose: string; formError: string;
    createOverride: (e: Event) => Promise<void>;
  };

  it('día especial cerrado: sin `existing_dates` (la lectura autoritativa la hace el runtime) y sin horas', async () => {
    const wc = (await montar('special_days')) as unknown as SpecialDayForm;
    wc.sdDate = '2026-12-25';
    wc.sdName = 'Navidad';
    wc.sdClosed = true;
    wc.sdRecurring = true;
    wc.sdNotes = 'Cerrado todo el día';
    await wc.createSpecialDay(new Event('submit'));
    const p = comandos.find((c) => c.name === 'schedules.special_days.create')!.payload;
    expect(p).not.toHaveProperty('existing_dates');
    expect(p.is_closed).toBe(true);
    expect(p.recurring_yearly).toBe(true);
    expect(p.notes).toBe('Cerrado todo el día');
    expect(p.open_time ?? null).toBeNull();
    expect(p.close_time ?? null).toBeNull();
  });

  it('día especial abierto: manda open_time/close_time (el handler los exige)', async () => {
    const wc = (await montar('special_days')) as unknown as SpecialDayForm;
    wc.sdDate = '2026-12-24';
    wc.sdName = 'Nochebuena';
    wc.sdClosed = false;
    wc.sdOpen = '09:00';
    wc.sdClose = '14:00';
    await wc.createSpecialDay(new Event('submit'));
    const p = comandos.find((c) => c.name === 'schedules.special_days.create')!.payload;
    expect(p.is_closed).toBe(false);
    expect(p.open_time).toBe('09:00');
    expect(p.close_time).toBe('14:00');
  });

  it('día especial abierto SIN horas: no se manda nada y se explica el error', async () => {
    const wc = (await montar('special_days')) as unknown as SpecialDayForm;
    wc.sdDate = '2026-12-24';
    wc.sdName = 'Nochebuena';
    wc.sdClosed = false;
    wc.sdOpen = '';
    wc.sdClose = '';
    await wc.createSpecialDay(new Event('submit'));
    expect(comandos.find((c) => c.name === 'schedules.special_days.create')).toBeUndefined();
    expect(wc.formError).toBe('ui.errorHoursRequired');
  });

  it('el formulario de día especial pinta el selector Cerrado/Abierto y, si abierto, las horas', async () => {
    const el = await montar('special_days');
    const wc = el as unknown as SpecialDayForm & { updateComplete: Promise<unknown>; shadowRoot: ShadowRoot };
    const form = wc.shadowRoot.querySelector('#tbl-special form[slot="create"]')!;
    expect(form.querySelector('ion-input[type="time"]'), 'cerrado por defecto: sin horas').toBeNull();
    expect(form.querySelector('ion-checkbox'), 'falta el control de recurrencia anual').toBeTruthy();
    wc.sdClosed = false;
    await wc.updateComplete;
    expect(form.querySelectorAll('ion-input[type="time"]').length, 'abierto: apertura y cierre').toBe(2);
  });

  it('override cerrado: manda is_closed:true sin horas', async () => {
    const wc = (await montar('special_days')) as unknown as OverrideForm;
    wc.ovStart = '2026-08-01';
    wc.ovEnd = '2026-08-15';
    wc.ovReason = 'Vacaciones';
    wc.ovClosed = true;
    await wc.createOverride(new Event('submit'));
    const p = comandos.find((c) => c.name === 'schedules.overrides.create')!.payload;
    expect(p.is_closed).toBe(true);
    expect(p.open_time ?? null).toBeNull();
    expect(p.close_time ?? null).toBeNull();
  });

  it('override abierto: manda las horas; sin ellas no se manda nada (nunca «abierto 24 h» por defecto)', async () => {
    const wc = (await montar('special_days')) as unknown as OverrideForm;
    wc.ovStart = '2026-08-01';
    wc.ovEnd = '2026-08-15';
    wc.ovReason = 'Horario de verano';
    wc.ovClosed = false;
    wc.ovOpen = '';
    wc.ovClose = '';
    await wc.createOverride(new Event('submit'));
    expect(comandos.find((c) => c.name === 'schedules.overrides.create')).toBeUndefined();
    expect(wc.formError).toBe('ui.errorHoursRequired');

    wc.ovOpen = '10:00';
    wc.ovClose = '14:00';
    await wc.createOverride(new Event('submit'));
    const p = comandos.find((c) => c.name === 'schedules.overrides.create')!.payload;
    expect(p.is_closed).toBe(false);
    expect(p.open_time).toBe('10:00');
    expect(p.close_time).toBe('14:00');
  });

  it('el formulario de override pinta el selector Cerrado/Abierto y, si abierto, las horas', async () => {
    const el = await montar('special_days');
    const wc = el as unknown as OverrideForm & { updateComplete: Promise<unknown>; shadowRoot: ShadowRoot };
    const form = wc.shadowRoot.querySelector('#tbl-override form[slot="create"]')!;
    expect(form.querySelector('ion-select'), 'falta el control Cerrado/Abierto').toBeTruthy();
    wc.ovClosed = false;
    await wc.updateComplete;
    expect(form.querySelectorAll('ion-input[type="time"]').length, 'abierto: apertura y cierre').toBe(2);
  });
});

describe('pestaña «Ajustes»: NO es el alta de una fila → su formulario se queda fuera', () => {
  it('los ajustes no viven en el panel de ninguna tabla', async () => {
    const el = await montar('settings');
    expect(tablas(el).length, 'los ajustes no llevan tabla').toBe(0);
    expect(el.shadowRoot.querySelector('form[slot="create"]'), 'los ajustes no son un alta de fila').toBeNull();
    expect(formulariosSueltos(el).length, 'el formulario de ajustes debe seguir en la página').toBe(1);
  });
});

describe('cromo de la vista', () => {
  // schedules#6: the internal `<nav><button>` row is gone — the shell's tabbar (ADR-0022) and the
  // route are the only navigation. The old assertion («conserva las pestañas») described the
  // duplicated level the issue removes; see routing-and-responsive.test.ts.
  it('no pinta título propio ni pestañas propias (el shell pinta ambos)', async () => {
    const el = await montar('hours');
    expect(el.shadowRoot.querySelector('h2'), 'título duplicado: el shell ya lo pinta').toBeNull();
    expect(el.shadowRoot.querySelectorAll('nav button').length).toBe(0);
  });
});
