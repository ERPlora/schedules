import { LitElement, html, css, nothing } from 'lit';
import { state } from 'lit/decorators.js';
import { define } from '@erplora/outfitkit/define';
import '@erplora/outfitkit/ok-data-table';
import '@erplora/outfitkit/ok-inline-feedback';
import type { DataTableColumn } from '@erplora/outfitkit';
import { createListController } from '@erplora/module-sdk';
import type { ListController, ListClient, ListParams, ListPage } from '@erplora/module-sdk';
// Catálogo i18n del módulo (ADR-0055): esbuild inlinea estos JSON en el `dist` del WC. Los textos
// internos se resuelven con `erplora.t(CATALOG, 'ui.clave')` (idioma activo, fallback locale→en→clave).
import esLocale from '../../../locales/es.json';
import enLocale from '../../../locales/en.json';
const CATALOG: Record<string, unknown> = { es: esLocale, en: enLocale };

interface ErploraClientLike extends ListClient {
  query<T = unknown>(name: string, params?: Record<string, unknown>): Promise<T>;
  /** ALL rows of a list query (the weekly intervals are at most 7 × 12). */
  queryAll<T = unknown>(name: string, params?: Record<string, unknown>): Promise<T[]>;
  queryPage<R = unknown>(name: string, params: ListParams): Promise<ListPage<R>>;
  command<T = unknown>(name: string, payload?: Record<string, unknown>): Promise<T>;
  on(event: string, cb: (payload: unknown) => void): () => void;
  /** i18n del módulo (ADR-0055): idioma activo + traducción del catálogo `ui`. */
  locale: string;
  t(catalog: Record<string, unknown>, key: string, params?: Record<string, unknown>): string;
}

// One row of `schedules.business_hours.list` = ONE opening interval of a weekday (schedules#8);
// several rows per day are split shifts, `is_closed = 1` closes the day, `close_time < open_time`
// crosses midnight and 00:00–00:00 is «open 24 hours». Old rows may still carry a break.
// Claves i18n de los días (lunes→domingo). El índice coincide con `day_of_week` (0 = lunes).
const DAY_KEYS = ['ui.monday', 'ui.tuesday', 'ui.wednesday', 'ui.thursday', 'ui.friday', 'ui.saturday', 'ui.sunday'];

interface BusinessHours {
  id: string;
  day_of_week: number;
  position?: number;
  open_time: string;
  close_time: string;
  is_closed: number;
  break_start: string | null;
  break_end: string | null;
}

interface Interval {
  open_time: string;
  close_time: string;
}

// What the table shows: one row per weekday, always the seven (like Google Business Profile,
// Square and Fresha — there is no «add a day»), with its intervals folded in.
interface WeekRow extends Record<string, unknown> {
  day_of_week: number;
  is_closed: number;
  configured: number;
  intervals: Interval[];
}

const ALL_DAY: Interval = { open_time: '00:00', close_time: '00:00' };

/** Folds the interval rows into the seven weekday rows the table paints (schedules#8). */
export function foldWeek(rows: BusinessHours[]): WeekRow[] {
  return DAY_KEYS.map((_, day) => {
    const mine = rows
      .filter((r) => Number(r.day_of_week) === day)
      .sort((a, b) => Number(a.position ?? 0) - Number(b.position ?? 0) || String(a.open_time).localeCompare(String(b.open_time)));
    const closed = mine.some((r) => Number(r.is_closed) === 1);
    const intervals: Interval[] = closed
      ? []
      : mine.flatMap((r) =>
          r.break_start && r.break_end
            ? [{ open_time: r.open_time, close_time: r.break_start }, { open_time: r.break_end, close_time: r.close_time }]
            : [{ open_time: r.open_time, close_time: r.close_time }],
        );
    return { day_of_week: day, is_closed: closed ? 1 : 0, configured: mine.length ? 1 : 0, intervals };
  });
}

interface SpecialDay {
  id: string;
  date: string;
  name: string;
  is_closed: number;
  open_time: string | null;
  close_time: string | null;
  recurring_yearly: number;
  notes: string;
}

interface ScheduleOverride {
  id: string;
  start_date: string;
  end_date: string;
  reason: string;
  open_time: string | null;
  close_time: string | null;
  is_closed: number;
}

// One opening interval of an EXCEPTION (schedules#23). Several rows with the same `exception_id`
// = split shift; an exception with NO row here still carries its own open_time/close_time pair
// (rows written before migration 003 and the days created by the bulk).
interface ExceptionInterval {
  id: string;
  exception_kind: 'special_day' | 'override';
  exception_id: string;
  position?: number;
  open_time: string;
  close_time: string;
}

/** The intervals of one exception, in `position` order (schedules#23). */
export function intervalsOf(rows: ExceptionInterval[], kind: string, id: string): Interval[] {
  return rows
    .filter((r) => r.exception_kind === kind && String(r.exception_id) === String(id))
    .sort((a, b) => Number(a.position ?? 0) - Number(b.position ?? 0))
    .map((r) => ({ open_time: r.open_time, close_time: r.close_time }));
}

/** A fresh, empty interval editor: one blank line (the market never opens with zero). */
const blankIntervals = (): Interval[] => [{ open_time: '', close_time: '' }];

type Tab = 'hours' | 'special_days' | 'settings';

const TABS: readonly Tab[] = ['hours', 'special_days', 'settings'];

// schedules#6 — the SECTION comes from the route (ADR-0022): the shell owns the tabbar and mounts
// this component at `/m/schedules/<navId>` for each of the three navigation entries, remounting on
// every change (deep links, back/forward included). Unknown or missing navId → `hours` (the shell
// canonicalises the URL to the first tab too).
export function resolveNavId(pathname: string): Tab {
  const clean = pathname.split(/[?#]/)[0].replace(/\/+$/, '');
  const m = /^\/m\/schedules\/([a-z_]+)$/.exec(clean);
  const id = m?.[1] as Tab | undefined;
  return id && TABS.includes(id) ? id : 'hours';
}

function erplora(): ErploraClientLike {
  const c = (globalThis as { erplora?: ErploraClientLike }).erplora;
  if (!c) throw new Error('erplora SDK no inicializado por el shell');
  return c;
}

// TODO-LIT: componente multi-vista (varios métodos render) — revisar composición.

export class ErpSchedulesHours extends LitElement {
  static styles = css`
    /* Cadena de altura: sin ella, el modo fill de las tablas no tiene alto que llenar. */
    :host { display:flex; flex-direction:column; height:100%; min-height:0; font-family: system-ui, sans-serif; color: var(--ion-text-color, #1c1b18); }
    .page { display:flex; flex-direction:column; min-height:0; flex:1 1 auto; }
    .pane { display:flex; flex-direction:column; min-height:0; flex:1 1 auto; gap:.5rem; }
    .pane > ok-data-table { flex:1 1 auto; min-height:0; }
    /* El alta vive en el panel lateral de la tabla: columna estrecha, no fila que se desborda.
       Los ajustes (que NO son un alta de fila) siguen fuera y sí se reparten en fila. */
    .form { display:flex; flex-direction:column; gap:.7rem; }
    .form ion-button { align-self:flex-end; }
    /* One interval per line: open · close · ✕ (44 px touch targets, one hand). */
    .interval { display:flex; gap:.4rem; align-items:center; }
    .interval ion-input { flex:1 1 6rem; min-width:5rem; }
    .interval ion-button { align-self:center; min-width:44px; min-height:44px; }
    .hint { color:#6b675e; font-size:.85rem; margin:0; }
    .settings { flex-direction:row; flex-wrap:wrap; align-items:end; }
    .settings ion-input, .settings ion-select { flex:1 1 11rem; min-width:9rem; }
    h3 { margin:.5rem 0 0; font-size:1rem; }
    label.chk { display:flex; gap:.35rem; align-items:center; }
  `;

  // Section of the view. Set from the route on connect (schedules#6); the shell paints the tabbar.
  @state() tab: Tab = 'hours';

  // Pending destructive action (special day / override): confirmed through an ion-alert first.
  @state() private pendingDelete: { kind: 'special_day' | 'override'; id: string; label: string } | null = null;

  @state() settings: { timezone: string; week_starts_on: number; slot_duration: number; auto_close_enabled: number } = {
    timezone: 'Europe/Madrid',
    week_starts_on: 1,
    slot_duration: 30,
    auto_close_enabled: 0,
  };

  @state() formError = '';

  @state() saving = false;

  @state() sdDate = '';

  @state() sdName = '';

  @state() sdClosed = true;

  // The special day's intervals being edited (schedules#23): same control as the weekly editor.
  @state() sdIntervals: Interval[] = blankIntervals();

  @state() sdRecurring = false;

  @state() sdNotes = '';

  @state() bhDay = 0;

  @state() bhClosed = false;

  // The day's intervals being edited (schedules#8): «+ add interval» appends, ✕ removes.
  @state() bhIntervals: Interval[] = [{ open_time: '09:00', close_time: '18:00' }];

  // All interval rows of the week (≤ 7 × 12): the table folds them into seven day rows.
  @state() private hoursRows: BusinessHours[] = [];

  @state() ovStart = '';

  @state() ovEnd = '';

  @state() ovReason = '';

  @state() ovClosed = true;

  // The override's intervals being edited (schedules#23), independent of the special day's.
  @state() ovIntervals: Interval[] = blankIntervals();

  // Every live interval row of the hub's exceptions; the two tables fold them by exception.
  @state() private exceptionIntervals: ExceptionInterval[] = [];

  private specialCtrl!: ListController<SpecialDay>;

  private overrideCtrl!: ListController<ScheduleOverride>;

  private unsub?: () => void;

  // Getters (no campos): se reevalúan en cada render, así los textos cambian con el idioma activo
  // (ADR-0055). `connectedCallback` re-renderiza al recibir `erplora:locale-changed`.
  private dayLabel(value: number): string {
    return DAY_KEYS[value] ? erplora().t(CATALOG, DAY_KEYS[value]) : String(value);
  }

  private get closedOptions() {
    const t = (k: string): string => erplora().t(CATALOG, k);
    return [
      { value: '1', label: t('ui.closed') },
      { value: '0', label: t('ui.open') },
    ];
  }

  private get yesNoOptions() {
    const t = (k: string): string => erplora().t(CATALOG, k);
    return [
      { value: '1', label: t('ui.yes') },
      { value: '0', label: t('ui.no') },
    ];
  }

  get weekRows(): WeekRow[] {
    return foldWeek(this.hoursRows);
  }

  private formatIntervals(r: Record<string, unknown>): string {
    const t = (k: string): string => erplora().t(CATALOG, k);
    if (Number(r.is_closed)) return t('ui.closed');
    const intervals = (r.intervals as Interval[] | undefined) ?? [];
    if (!intervals.length) return t('ui.notSet');
    if (intervals.length === 1 && intervals[0].open_time === '00:00' && intervals[0].close_time === '00:00') return t('ui.open24h');
    return intervals.map((i) => `${i.open_time}–${i.close_time}`).join(' · ');
  }

  private get hoursColumns(): DataTableColumn[] {
    const t = (k: string): string => erplora().t(CATALOG, k);
    return [
      { key: 'day_of_week', header: t('ui.colDay'), format: (r) => this.dayLabel(r.day_of_week as number) },
      { key: 'hours', header: t('ui.colHours'), format: (r) => this.formatIntervals(r) },
      {
        key: 'is_closed',
        header: t('ui.colStatus'),
        format: (r) => (Number(r.is_closed) ? t('ui.closed') : Number(r.configured) ? t('ui.open') : '—'),
      },
    ];
  }

  /** What an exception's hours column shows (schedules#23): every interval, «Closed», «Open 24
   *  hours», or — for a row with no interval of its own — its legacy open/close pair. */
  private formatExceptionHours(kind: 'special_day' | 'override', r: Record<string, unknown>): string {
    const t = (k: string): string => erplora().t(CATALOG, k);
    if (Number(r.is_closed)) return t('ui.closed');
    const intervals = intervalsOf(this.exceptionIntervals, kind, String(r.id));
    if (!intervals.length) return `${r.open_time ?? ''}–${r.close_time ?? ''}`;
    if (intervals.length === 1 && intervals[0].open_time === '00:00' && intervals[0].close_time === '00:00') return t('ui.open24h');
    return intervals.map((i) => `${i.open_time}–${i.close_time}`).join(' · ');
  }

  private get specialColumns(): DataTableColumn[] {
    const t = (k: string): string => erplora().t(CATALOG, k);
    return [
      { key: 'date', header: t('ui.colDate'), sortable: true, filterable: true, filterType: 'daterange' },
      { key: 'name', header: t('ui.colName'), sortable: true, filterable: true, filterType: 'text' },
      {
        key: 'is_closed',
        header: t('ui.colStatus'),
        sortable: true,
        filterable: true,
        filterType: 'select',
        options: this.closedOptions,
        format: (r) => this.formatExceptionHours('special_day', r),
      },
      {
        key: 'recurring_yearly',
        header: t('ui.colYearly'),
        sortable: true,
        filterable: true,
        filterType: 'select',
        options: this.yesNoOptions,
        format: (r) => ((r.recurring_yearly as number) ? t('ui.yes') : t('ui.no')),
      },
    ];
  }

  private get overrideColumns(): DataTableColumn[] {
    const t = (k: string): string => erplora().t(CATALOG, k);
    return [
      { key: 'start_date', header: t('ui.colFrom'), sortable: true, filterable: true, filterType: 'daterange' },
      { key: 'end_date', header: t('ui.colTo'), sortable: true, filterable: true, filterType: 'daterange' },
      { key: 'reason', header: t('ui.colReason'), sortable: true, filterable: true, filterType: 'text' },
      {
        key: 'is_closed',
        header: t('ui.colStatus'),
        sortable: true,
        filterable: true,
        filterType: 'select',
        options: this.closedOptions,
        format: (r) => this.formatExceptionHours('override', r),
      },
    ];
  }

  private get rowActions() {
    return [{ id: 'delete', label: erplora().t(CATALOG, 'ui.actionDelete'), icon: 'trash-outline', color: 'danger' }];
  }

  private get hoursActions() {
    return [{ id: 'edit', label: erplora().t(CATALOG, 'ui.actionEdit'), icon: 'create-outline' }];
  }

  // ADR-0055: re-render al cambiar el idioma activo (los textos van por getters/`t()`).
  private readonly onLocaleChange = (): void => this.requestUpdate();

  // TODO-LIT: componentWillLoad → connectedCallback. Recuerda: connectedCallback se dispara
  // en CADA reconexión al DOM (no solo en el primer montaje). Si la init debe correr una
  // sola vez tras el primer render, considera firstUpdated() en su lugar.
  async connectedCallback() {
    super.connectedCallback();
    this.tab = resolveNavId(window.location.pathname);
    window.addEventListener('erplora:locale-changed', this.onLocaleChange);
    const rerender = () => this.requestUpdate();
    this.specialCtrl = createListController<SpecialDay>(erplora(), 'schedules.special_days.list', rerender, {
      pageSize: 50,
      sort: 'name',
      dir: 'asc',
    });
    this.overrideCtrl = createListController<ScheduleOverride>(erplora(), 'schedules.overrides.list', rerender, {
      pageSize: 50,
      sort: 'id',
      dir: 'asc',
    });
    await Promise.all([
      this.loadHours(),
      this.loadExceptionIntervals(),
      this.specialCtrl.load(),
      this.overrideCtrl.load(),
      this.loadSettings(),
    ]);
    try {
            // Una suscripción por evento, con su literal EN la llamada (ADR-0127: el extractor
      // de contratos no sigue arrays; el nombre vive donde se usa).
      const offs = [
        erplora().on('schedules.business_hours.updated', () => this.reloadAll()),
        erplora().on('schedules.special_day.created', () => this.reloadAll()),
        erplora().on('schedules.special_day.deleted', () => this.reloadAll()),
        erplora().on('schedules.override.created', () => this.reloadAll()),
        erplora().on('schedules.override.deleted', () => this.reloadAll()),
        erplora().on('schedules.settings.saved', () => this.reloadAll()),
      ];
      this.unsub = () => offs.forEach((o) => o());
    } catch {
      /* sin SDK (preview) → sin reactividad en vivo */
    }
  }

  disconnectedCallback() {
    window.removeEventListener('erplora:locale-changed', this.onLocaleChange);
    super.disconnectedCallback();
    this.unsub?.();
  }

  private async reloadAll() {
    await Promise.all([
      this.loadHours(),
      this.loadExceptionIntervals(),
      this.specialCtrl.load(),
      this.overrideCtrl.load(),
      this.loadSettings(),
    ]);
  }

  /** Every interval row of the hub's exceptions (schedules#23): the two tables fold them by
   *  exception, the same way the weekly table folds `business_hours.list` by day. */
  private async loadExceptionIntervals() {
    try {
      const rows = await erplora().queryAll<ExceptionInterval>('schedules.exception_intervals.list', { sort: 'position', dir: 'asc' });
      this.exceptionIntervals = Array.isArray(rows) ? rows : [];
    } catch {
      /* an old hub without migration 003: the pair on each exception still decides */
      this.exceptionIntervals = [];
    }
  }

  // Every interval row of the week (never a page: the table folds them by day).
  private async loadHours() {
    try {
      const rows = await erplora().queryAll<BusinessHours>('schedules.business_hours.list', { sort: 'day_of_week', dir: 'asc' });
      this.hoursRows = Array.isArray(rows) ? rows : [];
    } catch (e) {
      this.formError = e instanceof Error ? e.message : String(e);
    }
  }

  addInterval() {
    this.bhIntervals = [...this.bhIntervals, { open_time: '', close_time: '' }];
  }

  removeInterval(index: number) {
    this.bhIntervals = this.bhIntervals.filter((_, i) => i !== index);
  }

  setAllDay() {
    this.bhClosed = false;
    this.bhIntervals = [{ ...ALL_DAY }];
  }

  private updateInterval(index: number, patch: Partial<Interval>) {
    this.bhIntervals = this.bhIntervals.map((it, i) => (i === index ? { ...it, ...patch } : it));
  }

  // The exceptions get the SAME editor as the weekly hours (schedules#23) — one list of intervals
  // per form, each with its own state so the two panels never step on each other.
  addSpecialDayInterval() {
    this.sdIntervals = [...this.sdIntervals, { open_time: '', close_time: '' }];
  }

  removeSpecialDayInterval(index: number) {
    this.sdIntervals = this.sdIntervals.filter((_, i) => i !== index);
  }

  addOverrideInterval() {
    this.ovIntervals = [...this.ovIntervals, { open_time: '', close_time: '' }];
  }

  removeOverrideInterval(index: number) {
    this.ovIntervals = this.ovIntervals.filter((_, i) => i !== index);
  }

  /** The `intervals[]` an exception form sends, or `null` when a line is half filled — an
   *  incomplete interval is a mistake, never «open all day». A closed exception sends `[]`. */
  private exceptionPayloadIntervals(closed: boolean, intervals: Interval[]): Interval[] | null {
    if (closed) return [];
    const clean = intervals.map((i) => ({ open_time: i.open_time, close_time: i.close_time }));
    if (!clean.length || clean.some((i) => !i.open_time || !i.close_time)) return null;
    return clean;
  }

  /** Reads the module's singleton settings row (schedules#9).
   *
   *  `schedules.settings.get` is a plain SQL query, so the runtime answers a ROW ARRAY — `[row]` —
   *  and never the bare object. Assigning that array straight into `this.settings` left every
   *  control on the settings tab empty while the server held the values. So the answer is
   *  NORMALISED here rather than assumed: array or object, and anything that is not an object with
   *  fields keeps the defaults instead of blanking the form. */
  private async loadSettings() {
    try {
      const answer = await erplora().query<unknown>('schedules.settings.get');
      const row = Array.isArray(answer) ? answer[0] : answer;
      if (row && typeof row === 'object') {
        this.settings = { ...this.settings, ...(row as Partial<typeof this.settings>) };
      }
    } catch {
      /* optional settings: a missing row is not an error, the defaults stand */
    }
  }

  /** Panel lateral de una de las tablas de la vista (cada tabla tiene el suyo). */
  private dataTable(id: string): { open(p?: 'filters' | 'create'): void; close(): void } | null {
    return this.renderRoot.querySelector(`#${id}`) as
      | { open(p?: 'filters' | 'create'): void; close(): void }
      | null;
  }

  /** Replaces the day's intervals (`schedules.business_hours.set` with `intervals[]`, schedules#8).
   *  A closed day sends no intervals; an open day needs every interval complete — the handler
   *  validates order, overlaps, overnight and 24 h. */
  private async saveBusinessHours(ev: Event) {
    ev.preventDefault();
    const intervals = this.bhClosed ? [] : this.bhIntervals.map((i) => ({ open_time: i.open_time, close_time: i.close_time }));
    if (!this.bhClosed && (!intervals.length || intervals.some((i) => !i.open_time || !i.close_time))) {
      this.formError = erplora().t(CATALOG, 'ui.errorHoursRequired');
      return;
    }
    this.saving = true;
    this.formError = '';
    try {
      await erplora().command('schedules.business_hours.set', {
        day_of_week: Number(this.bhDay),
        is_closed: this.bhClosed,
        intervals,
      });
      this.dataTable('tbl-hours')?.close();
      await this.loadHours();
    } catch (e) {
      // Runtime validation errors (invalid_hours / overlapping / invalid_day / missing_hours).
      this.formError = e instanceof Error ? e.message : erplora().t(CATALOG, 'ui.errorSaveHours');
    } finally {
      this.saving = false;
    }
  }

  /** Row action «edit»: the seven days are fixed, so editing a day opens the panel already
   *  filled with its intervals. */
  private onHoursAction(ev: CustomEvent<{ actionId: string; row: Record<string, unknown> }>) {
    if (ev.detail.actionId !== 'edit') return;
    const row = ev.detail.row as WeekRow;
    this.bhDay = Number(row.day_of_week);
    this.bhClosed = !!row.is_closed;
    const intervals = (row.intervals ?? []).map((i) => ({ ...i }));
    this.bhIntervals = intervals.length ? intervals : [{ open_time: '09:00', close_time: '18:00' }];
    this.dataTable('tbl-hours')?.open('create');
  }

  /** Special day (schedules#7): the payload is exactly what `schemas/special_day_create.json`
   *  accepts. Open days carry both hours (the handler requires them); the duplicate check is an
   *  authoritative runtime read (`reads` in the manifest), NOT a client-supplied list. */
  private async createSpecialDay(ev: Event) {
    ev.preventDefault();
    if (!this.sdDate || !this.sdName.trim()) return;
    const intervals = this.exceptionPayloadIntervals(this.sdClosed, this.sdIntervals);
    if (!intervals) {
      this.formError = erplora().t(CATALOG, 'ui.errorHoursRequired');
      return;
    }
    this.saving = true;
    this.formError = '';
    try {
      await erplora().command('schedules.special_days.create', {
        date: this.sdDate,
        name: this.sdName.trim(),
        is_closed: this.sdClosed,
        // The pair keeps travelling as the FIRST interval: a hub that has not run migration 003
        // yet still writes a usable row, and nothing that reads the pair breaks.
        open_time: intervals.length ? intervals[0].open_time : null,
        close_time: intervals.length ? intervals[0].close_time : null,
        intervals,
        recurring_yearly: this.sdRecurring,
        notes: this.sdNotes.trim(),
      });
      this.sdDate = '';
      this.sdName = '';
      this.sdClosed = true;
      this.sdIntervals = blankIntervals();
      this.sdRecurring = false;
      this.sdNotes = '';
      this.dataTable('tbl-special')?.close();
      await Promise.all([this.specialCtrl.load(), this.loadExceptionIntervals()]);
    } catch (e) {
      this.formError = e instanceof Error ? e.message : erplora().t(CATALOG, 'ui.errorCreateSpecialDay');
    } finally {
      this.saving = false;
    }
  }

  /** Override (schedules#7): explicit Closed/Open control. An open override always carries both
   *  hours — there is no silent default that would read as "open 24h". */
  private async createOverride(ev: Event) {
    ev.preventDefault();
    if (!this.ovStart || !this.ovEnd || !this.ovReason.trim()) return;
    const intervals = this.exceptionPayloadIntervals(this.ovClosed, this.ovIntervals);
    if (!intervals) {
      this.formError = erplora().t(CATALOG, 'ui.errorHoursRequired');
      return;
    }
    this.saving = true;
    this.formError = '';
    try {
      await erplora().command('schedules.overrides.create', {
        start_date: this.ovStart,
        end_date: this.ovEnd,
        reason: this.ovReason.trim(),
        is_closed: this.ovClosed,
        open_time: intervals.length ? intervals[0].open_time : null,
        close_time: intervals.length ? intervals[0].close_time : null,
        intervals,
      });
      this.ovStart = '';
      this.ovEnd = '';
      this.ovReason = '';
      this.ovClosed = true;
      this.ovIntervals = blankIntervals();
      this.dataTable('tbl-override')?.close();
      await Promise.all([this.overrideCtrl.load(), this.loadExceptionIntervals()]);
    } catch (e) {
      this.formError = e instanceof Error ? e.message : erplora().t(CATALOG, 'ui.errorCreateOverride');
    } finally {
      this.saving = false;
    }
  }

  private async saveSettings(ev: Event) {
    ev.preventDefault();
    this.saving = true;
    this.formError = '';
    try {
      await erplora().command('schedules.settings.save', {
        timezone: this.settings.timezone,
        week_starts_on: Number(this.settings.week_starts_on),
        slot_duration: Number(this.settings.slot_duration),
        auto_close_enabled: !!this.settings.auto_close_enabled,
      });
      await this.loadSettings();
    } catch (e) {
      this.formError = e instanceof Error ? e.message : erplora().t(CATALOG, 'ui.errorSaveSettings');
    } finally {
      this.saving = false;
    }
  }

  // Destructive actions ask first (schedules#6): the row is parked and the ion-alert decides.
  private onSpecialAction(ev: CustomEvent<{ actionId: string; row: Record<string, unknown> }>) {
    if (ev.detail.actionId !== 'delete') return;
    const row = ev.detail.row;
    this.pendingDelete = { kind: 'special_day', id: String(row.id), label: String(row.name ?? row.date ?? '') };
  }

  private onOverrideAction(ev: CustomEvent<{ actionId: string; row: Record<string, unknown> }>) {
    if (ev.detail.actionId !== 'delete') return;
    const row = ev.detail.row;
    this.pendingDelete = { kind: 'override', id: String(row.id), label: String(row.reason ?? row.start_date ?? '') };
  }

  private async onDeleteDismiss(ev: CustomEvent<{ role?: string }>) {
    const pending = this.pendingDelete;
    this.pendingDelete = null;
    if (ev.detail?.role !== 'confirm' || !pending) return;
    this.formError = '';
    try {
      if (pending.kind === 'special_day') {
        await erplora().command('schedules.special_days.delete', { special_day_id: pending.id });
        await Promise.all([this.specialCtrl.load(), this.loadExceptionIntervals()]);
      } else {
        await erplora().command('schedules.overrides.delete', { override_id: pending.id });
        await Promise.all([this.overrideCtrl.load(), this.loadExceptionIntervals()]);
      }
    } catch (e) {
      this.formError = e instanceof Error ? e.message : erplora().t(CATALOG, 'ui.errorDelete');
    }
  }

  // ≤834 px opens in cards: status, effective hours and the row actions stay visible without
  // clipping (schedules#6); desktop keeps the table.
  private get defaultView(): 'cards' | 'table' {
    return window.innerWidth <= 834 ? 'cards' : 'table';
  }

  /** THE interval editor — one open · close · ✕ line per interval plus «+ add interval». The
   *  weekly day (schedules#8) and the two exception forms (schedules#23) share it, so the three
   *  screens behave identically: 44 px touch targets, one hand, no keyboard. */
  private renderIntervalEditor(
    intervals: Interval[],
    update: (index: number, patch: Partial<Interval>) => void,
    add: () => void,
    remove: (index: number) => void,
  ) {
    const t = (k: string): string => erplora().t(CATALOG, k);
    return html`
      ${intervals.map(
        (it, i) => html`<div class="interval">
          <ion-input fill="outline" label-placement="floating" label=${t('ui.fieldOpen')} type="time" .value=${it.open_time} @ionInput=${(e: any) => update(i, { open_time: e.target.value })}></ion-input>
          <ion-input fill="outline" label-placement="floating" label=${t('ui.fieldClose')} type="time" .value=${it.close_time} @ionInput=${(e: any) => update(i, { close_time: e.target.value })}></ion-input>
          <ion-button fill="clear" size="small" color="medium" data-action="remove-interval" aria-label=${t('ui.removeInterval')} ?disabled=${intervals.length <= 1} @click=${() => remove(i)}><ion-icon slot="icon-only" name="close-outline"></ion-icon></ion-button>
        </div>`,
      )}
      <ion-button fill="outline" size="small" data-action="add-interval" @click=${() => add()}>${t('ui.addInterval')}</ion-button>
      <p class="hint">${t('ui.intervalsHint')}</p>
    `;
  }

  private renderHours() {
    const t = (k: string): string => erplora().t(CATALOG, k);
    const isAllDay = this.bhIntervals.length === 1 && this.bhIntervals[0].open_time === '00:00' && this.bhIntervals[0].close_time === '00:00';
    return html`<div class="pane">
        <!-- Seven fixed rows (one per weekday), no «+»: a day is EDITED, never added (schedules#8). -->
        <ok-data-table id="tbl-hours" .fill=${true} .views=${true} .defaultView=${this.defaultView} .cardTitle=${(row: Record<string, unknown>) => this.dayLabel(Number(row.day_of_week))} .columns=${this.hoursColumns} .rows=${this.weekRows} .pageSize=${7} .actions=${this.hoursActions} .rowClickable=${true} @rowAction=${(e: CustomEvent) => this.onHoursAction(e)} @rowClick=${(e: CustomEvent<{ row: Record<string, unknown> }>) => this.onHoursAction({ detail: { actionId: 'edit', row: e.detail.row } } as CustomEvent<{ actionId: string; row: Record<string, unknown> }>)} .emptyMessage=${t('ui.emptyHours')}>
          <!-- The day editor lives in the table's panel. Projected ALWAYS: painted only when open,
               the «edit» action would find an empty panel. -->
          <form slot="create" class="form" @submit=${(e: Event) => this.saveBusinessHours(e)}>
            <ion-select fill="outline" label-placement="floating" label=${t('ui.fieldDay')} .value=${this.bhDay} @ionChange=${(e: any) => (this.bhDay = Number(e.target.value))}>
              ${DAY_KEYS.map((_, value) => html`<ion-select-option .value=${value}>${this.dayLabel(value)}</ion-select-option>`)}
            </ion-select>
            <label class="chk">
              <ion-checkbox ?checked=${this.bhClosed} @ionChange=${(e: any) => (this.bhClosed = !!e.target.checked)}></ion-checkbox>
              ${t('ui.closed')}
            </label>
            ${this.bhClosed
              ? nothing
              : html`
                  <label class="chk">
                    <ion-checkbox ?checked=${isAllDay} @ionChange=${(e: any) => (e.target.checked ? this.setAllDay() : (this.bhIntervals = [{ open_time: '09:00', close_time: '18:00' }]))}></ion-checkbox>
                    ${t('ui.open24h')}
                  </label>
                  ${isAllDay
                    ? nothing
                    : this.renderIntervalEditor(
                        this.bhIntervals,
                        (i, patch) => this.updateInterval(i, patch),
                        () => this.addInterval(),
                        (i) => this.removeInterval(i),
                      )}
                `}
            <ion-button type="submit" size="small" ?disabled=${this.saving}>${this.saving ? t('ui.saving') : t('ui.saveDay')}</ion-button>
          </form>
        </ok-data-table>
      </div>`;
  }

  private renderSpecialDays() {
    const t = (k: string): string => erplora().t(CATALOG, k);
    return html`<div class="pane">
        <!-- Two collections, two tables, each labelled (schedules#6): a dated exception vs a range. -->
        <h3>${t('ui.specialDays')}</h3>
        <ok-data-table id="tbl-special" .serverSide=${true} .fill=${true} .addable=${true} .views=${true} .defaultView=${this.defaultView} .cardTitle=${(row: Record<string, unknown>) => String(row.name ?? row.date ?? '—')} .columns=${this.specialColumns} .rows=${this.specialCtrl?.rows ?? []} .total=${this.specialCtrl?.total ?? 0} .page=${this.specialCtrl?.state.page ?? 0} .pageSize=${this.specialCtrl?.state.pageSize ?? 50} .sort=${this.specialCtrl?.state.sort} .sortDir=${this.specialCtrl?.state.dir ?? 'asc'} .searchable=${true} .searchPlaceholder=${t('ui.searchSpecialDay')} .actions=${this.rowActions} @rowAction=${(e: CustomEvent) => this.onSpecialAction(e)} .emptyMessage=${this.specialCtrl?.loading ? t('ui.loading') : t('ui.emptySpecialDays')} @pageChange=${(e: CustomEvent<number>) => this.specialCtrl.setPage(e.detail)} @sortChange=${(e: CustomEvent<{ sort: string; dir: 'asc' | 'desc' }>) => this.specialCtrl.setSort(e.detail.sort, e.detail.dir)} @searchChange=${(e: CustomEvent<string>) => this.specialCtrl.setSearch(e.detail)} @filterChange=${(e: CustomEvent<{ col: string; value: unknown }>) => this.specialCtrl.setFilter(e.detail.col, e.detail.value)}>
          <form slot="create" class="form" @submit=${(e: Event) => this.createSpecialDay(e)}>
            <ion-input fill="outline" label-placement="floating" label=${t('ui.colDate')} type="date" .value=${this.sdDate} @ionInput=${(e: any) => (this.sdDate = e.target.value)}></ion-input>
            <ion-input fill="outline" label-placement="floating" label=${t('ui.colName')} placeholder=${t('ui.placeholderName')} .value=${this.sdName} @ionInput=${(e: any) => (this.sdName = e.target.value)}></ion-input>
            <ion-select fill="outline" label-placement="floating" label=${t('ui.colStatus')} .value=${this.sdClosed ? 'closed' : 'open'} @ionChange=${(e: any) => (this.sdClosed = e.target.value === 'closed')}>
              <ion-select-option value="closed">${t('ui.closed')}</ion-select-option>
              <ion-select-option value="open">${t('ui.openWithHours')}</ion-select-option>
            </ion-select>
            ${this.sdClosed
              ? nothing
              : this.renderIntervalEditor(
                  this.sdIntervals,
                  (i, patch) => (this.sdIntervals = this.sdIntervals.map((it, n) => (n === i ? { ...it, ...patch } : it))),
                  () => this.addSpecialDayInterval(),
                  (i) => this.removeSpecialDayInterval(i),
                )}
            <label class="chk">
              <ion-checkbox ?checked=${this.sdRecurring} @ionChange=${(e: any) => (this.sdRecurring = !!e.target.checked)}></ion-checkbox>
              ${t('ui.fieldRecurring')}
            </label>
            <ion-input fill="outline" label-placement="floating" label=${t('ui.fieldNotes')} .value=${this.sdNotes} @ionInput=${(e: any) => (this.sdNotes = e.target.value)}></ion-input>
            <ion-button type="submit" size="small" ?disabled=${this.saving || !this.sdDate || !this.sdName}>${this.saving ? t('ui.saving') : t('ui.addDay')}</ion-button>
          </form>
        </ok-data-table>
        <!-- Las excepciones son OTRA entidad (otra tabla) → llevan su propio panel de alta. -->
        <h3>${t('ui.overrides')}</h3>
        <ok-data-table id="tbl-override" .serverSide=${true} .fill=${true} .addable=${true} .views=${true} .defaultView=${this.defaultView} .cardTitle=${(row: Record<string, unknown>) => String(row.reason ?? row.start_date ?? '—')} .columns=${this.overrideColumns} .rows=${this.overrideCtrl?.rows ?? []} .total=${this.overrideCtrl?.total ?? 0} .page=${this.overrideCtrl?.state.page ?? 0} .pageSize=${this.overrideCtrl?.state.pageSize ?? 50} .sort=${this.overrideCtrl?.state.sort} .sortDir=${this.overrideCtrl?.state.dir ?? 'asc'} .searchable=${true} .searchPlaceholder=${t('ui.searchOverride')} .actions=${this.rowActions} @rowAction=${(e: CustomEvent) => this.onOverrideAction(e)} .emptyMessage=${this.overrideCtrl?.loading ? t('ui.loading') : t('ui.emptyOverrides')} @pageChange=${(e: CustomEvent<number>) => this.overrideCtrl.setPage(e.detail)} @sortChange=${(e: CustomEvent<{ sort: string; dir: 'asc' | 'desc' }>) => this.overrideCtrl.setSort(e.detail.sort, e.detail.dir)} @searchChange=${(e: CustomEvent<string>) => this.overrideCtrl.setSearch(e.detail)} @filterChange=${(e: CustomEvent<{ col: string; value: unknown }>) => this.overrideCtrl.setFilter(e.detail.col, e.detail.value)}>
          <form slot="create" class="form" @submit=${(e: Event) => this.createOverride(e)}>
            <ion-input fill="outline" label-placement="floating" label=${t('ui.colFrom')} type="date" .value=${this.ovStart} @ionInput=${(e: any) => (this.ovStart = e.target.value)}></ion-input>
            <ion-input fill="outline" label-placement="floating" label=${t('ui.colTo')} type="date" .value=${this.ovEnd} @ionInput=${(e: any) => (this.ovEnd = e.target.value)}></ion-input>
            <ion-input fill="outline" label-placement="floating" label=${t('ui.colReason')} .value=${this.ovReason} @ionInput=${(e: any) => (this.ovReason = e.target.value)}></ion-input>
            <ion-select fill="outline" label-placement="floating" label=${t('ui.colStatus')} .value=${this.ovClosed ? 'closed' : 'open'} @ionChange=${(e: any) => (this.ovClosed = e.target.value === 'closed')}>
              <ion-select-option value="closed">${t('ui.closed')}</ion-select-option>
              <ion-select-option value="open">${t('ui.openWithHours')}</ion-select-option>
            </ion-select>
            ${this.ovClosed
              ? nothing
              : this.renderIntervalEditor(
                  this.ovIntervals,
                  (i, patch) => (this.ovIntervals = this.ovIntervals.map((it, n) => (n === i ? { ...it, ...patch } : it))),
                  () => this.addOverrideInterval(),
                  (i) => this.removeOverrideInterval(i),
                )}
            <ion-button type="submit" size="small" ?disabled=${this.saving || !this.ovStart || !this.ovEnd || !this.ovReason}>${this.saving ? t('ui.saving') : t('ui.addOverride')}</ion-button>
          </form>
        </ok-data-table>
      </div>`;
  }

  // Los ajustes NO son el alta de una fila (son configuración del módulo): su formulario se queda
  // FUERA de cualquier tabla, a propósito.
  private renderSettings() {
    const t = (k: string): string => erplora().t(CATALOG, k);
    return html`<form class="form settings" @submit=${(e: Event) => this.saveSettings(e)}>
        <ion-input fill="outline" label-placement="floating" label=${t('ui.placeholderTimezone')} .value=${this.settings.timezone} @ionInput=${(e: any) => (this.settings = { ...this.settings, timezone: e.target.value })}></ion-input>
        <ion-select fill="outline" label-placement="floating" label=${t('ui.fieldWeekStart')} .value=${this.settings.week_starts_on} @ionChange=${(e: any) => (this.settings = { ...this.settings, week_starts_on: Number(e.target.value) })}>
          <ion-select-option .value=${1}>${t('ui.monday')}</ion-select-option>
          <ion-select-option .value=${7}>${t('ui.sunday')}</ion-select-option>
        </ion-select>
        <ion-input fill="outline" label-placement="floating" type="number" min="5" max="120" label=${t('ui.placeholderSlotDuration')} .value=${this.settings.slot_duration} @ionInput=${(e: any) => (this.settings = { ...this.settings, slot_duration: Number(e.target.value) })}></ion-input>
        <label class="chk">
          <ion-checkbox ?checked=${!!this.settings.auto_close_enabled} @ionChange=${(e: any) => (this.settings = { ...this.settings, auto_close_enabled: e.target.checked ? 1 : 0 })}></ion-checkbox>
          ${t('ui.autoClose')}
        </label>
        <ion-button type="submit" size="small" ?disabled=${this.saving}>${this.saving ? t('ui.saving') : t('ui.save')}</ion-button>
      </form>`;
  }

  render() {
    const t = (k: string): string => erplora().t(CATALOG, k);
    // No internal nav (schedules#6): the shell's tabbar + route are the only navigation (ADR-0022).
    const errors = [this.formError, this.specialCtrl?.error, this.overrideCtrl?.error].filter(Boolean);
    return html`<div class="page">
        ${errors.map((e) => html`<ok-inline-feedback tone="danger" icon="alert-circle-outline">${e}</ok-inline-feedback>`)}
        ${this.tab === 'hours' ? this.renderHours() : nothing}
        ${this.tab === 'special_days' ? this.renderSpecialDays() : nothing}
        ${this.tab === 'settings' ? this.renderSettings() : nothing}
        <ion-alert
          .isOpen=${this.pendingDelete !== null}
          header=${t('ui.deleteConfirmTitle')}
          message=${erplora().t(CATALOG, 'ui.deleteConfirmMessage', { name: this.pendingDelete?.label ?? '' })}
          .buttons=${[
            { text: t('ui.cancel'), role: 'cancel' },
            { text: t('ui.actionDelete'), role: 'confirm', cssClass: 'alert-button-danger' },
          ]}
          @ionAlertDidDismiss=${(e: CustomEvent<{ role?: string }>) => this.onDeleteDismiss(e)}
        ></ion-alert>
      </div>`;
  }
}

define('erp-schedules-hours', ErpSchedulesHours);
