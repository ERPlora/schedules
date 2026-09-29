import { LitElement, html, css, nothing } from 'lit';
import type { PropertyValues } from 'lit';
import { state } from 'lit/decorators.js';
import { define } from '@erplora/outfitkit/define';
import '@erplora/outfitkit/ok-data-table';
import '@erplora/outfitkit/ok-inline-feedback';
import type { DataTableColumn } from '@erplora/outfitkit';
import { createListController, dataTableShowsLoadError } from '@erplora/module-sdk';
import type { ListController, ListClient, ListParams, ListPage } from '@erplora/module-sdk';
import { formatCalendarDate, parseCalendarDate } from '../../lib/calendar-date';
import { formatWallTime, parseWallTime } from '../../lib/wall-time';
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
  /** La zona IANA del NEGOCIO, ya resuelta por el core (hub#731/hub#1022). Opcional a propósito:
   *  un shell anterior a hub#1022 no la publica, y la pantalla lo dice en vez de inventarla. */
  timezone?: string;
  t(catalog: Record<string, unknown>, key: string, params?: Record<string, unknown>): string;
}

// One row of `schedules.business_hours.list` = ONE opening interval of a weekday (schedules#8);
// several rows per day are split shifts, `is_closed = 1` closes the day, `close_time < open_time`
// crosses midnight and 00:00–00:00 is «open 24 hours». Old rows may still carry a break.
// Claves i18n de los días (lunes→domingo). El índice coincide con `day_of_week` (0 = lunes).
const DAY_KEYS = ['ui.monday', 'ui.tuesday', 'ui.wednesday', 'ui.thursday', 'ui.friday', 'ui.saturday', 'ui.sunday'];

// The audit author `apply_module_seed` stamps on the week it plants at install time
// (`crates/runtime/src/seed.rs` — the only place in the runtime that uses this sentinel).
const SEED_AUTHOR = 'system';

interface BusinessHours {
  id: string;
  day_of_week: number;
  position?: number;
  open_time: string;
  close_time: string;
  is_closed: number;
  break_start: string | null;
  break_end: string | null;
  /** Who wrote the row. `SEED_AUTHOR` means the installer, i.e. nobody has confirmed it yet
   *  (schedules#36). Optional: a hub whose runtime predates the column simply never warns. */
  created_by?: string;
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

/** Folds the interval rows into the seven weekday rows the table paints (schedules#8).
 *
 *  `weekStartsOn` (schedules#9) rotates them so the table opens on the day the hub chose —
 *  1 = Monday (the ISO default), 7 = Sunday. The seven days are always all there; only the
 *  order changes, exactly as Google Business Profile and Square present them. */
export function foldWeek(rows: BusinessHours[], weekStartsOn = 1): WeekRow[] {
  const folded = DAY_KEYS.map((_, day) => {
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
  // 7 = Sunday is the only other start the settings offer; anything else keeps Monday first.
  return Number(weekStartsOn) === 7 ? [folded[6], ...folded.slice(0, 6)] : folded;
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

/**
 * Which of the three forms an interval editor is painted into (schedules#46). The editor is ONE
 * function reused three times, so its `data-testid` cannot be a literal: the special-day form and
 * the override form are on screen at the same time, and the same name twice is a name that
 * addresses nothing. The scope is the identity the QA needs — «the opening time of the second
 * interval of the override form» — and it goes at the END, so the field stays in the fixed head
 * and renaming it breaks the guard instead of breaking a spec in another repo.
 */
type IntervalScope = 'hours' | 'special' | 'override';

/** schedules#54 — the three date fields of the exceptions, named by the state each one fills. */
type DateField = 'sdDate' | 'ovStart' | 'ovEnd';

/** schedules#50 — the text being typed into the time fields of ONE interval list, kept apart from
 *  the stored intervals (which only ever hold a valid 'HH:MM' or ''). `owner` is the very array
 *  the texts were typed against: loading another day, adding or removing a line replaces the
 *  array, so a stale half-typed text can never be painted over somebody else's hour. */
interface TimeDrafts {
  scope: IntervalScope;
  owner: Interval[];
  texts: Record<string, string>;
}

type TimeField = 'open_time' | 'close_time';

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

/** The `errors` catalog of `locales/{en,es}.json`, resolved by the active language.
 *
 *  It is NOT reachable through `erplora().t()`: that helper splits the key on dots to walk the
 *  catalog, and the `errors` block is FLAT — the whole namespaced code is ONE key
 *  (`"schedules.overlapping"`), the same shape `appointments` and `reservations` ship. */
function catalogError(code: string): string {
  for (const lang of [erplora().locale, 'en']) {
    const dict = (CATALOG[lang] as { errors?: Record<string, string> } | undefined)?.errors;
    const text = dict?.[code];
    if (typeof text === 'string' && text) return text;
  }
  return '';
}

/** A business refusal (hub#139) travels as a stable `schedules.*` code plus the handler's
 *  English fallback sentence: paint the code's TRANSLATION, and keep the sentence for codes the
 *  catalog has not learned yet — same idea as `reservations` (`erp-reservations-list.ts`).
 *
 *  schedules#28: until the handlers refused with `DomainError`, EVERY rejection surfaced as
 *  `e.message` — the runtime's plumbing («error de handler WASM: wasm call to … failed:») around
 *  a half-English sentence. */
function domainErrorText(e: unknown, fallbackKey: string): string {
  const code = (e as { code?: unknown } | null)?.code;
  const message = e instanceof Error ? e.message : '';
  if (typeof code === 'string' && code.startsWith('schedules.')) {
    const text = catalogError(code);
    if (text) return text;
  }
  return message || erplora().t(CATALOG, fallbackKey);
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
    /* pm#392: color= is a document-level rule Ionic cannot apply inside this shadow root; the
       tone is read from the theme token here instead. */
    ion-button.tone-medium[fill] { --color: var(--ion-color-medium, #636469); }
    .hint { color:#6b675e; font-size:.85rem; margin:0; }
    /* schedules#9: the business zone, shown here and changed in the hub's own Settings. */
    .settings-core { display:flex; flex-direction:column; gap:.5rem; align-items:flex-start; margin-bottom:1rem; }
    .settings-core .kv { display:flex; gap:.5rem; align-items:baseline; flex-wrap:wrap; }
    .settings-core .k { font-weight:600; }
    .settings { flex-direction:row; flex-wrap:wrap; align-items:end; }
    .settings ion-input, .settings ion-select { flex:1 1 11rem; min-width:9rem; }
    h3 { margin:.5rem 0 0; font-size:1rem; }
    label.chk { display:flex; gap:.35rem; align-items:center; }
  `;

  // Section of the view. Set from the route on connect (schedules#6); the shell paints the tabbar.
  @state() tab: Tab = 'hours';

  // Pending destructive action (special day / override): confirmed through an ion-alert first.
  @state() private pendingDelete: { kind: 'special_day' | 'override'; id: string; label: string } | null = null;

  // schedules#9: the only setting this module owns AND something obeys. The business timezone is
  // the core's (shown read-only below), and `slot_duration` / `auto_close_enabled` were saved and
  // painted while NOTHING read them — a control with no effect is indistinguishable from a bug.
  @state() settings: { week_starts_on: number } = { week_starts_on: 1 };

  /** What went wrong OUTSIDE a panel's save — confirming the week, deleting an exception, saving
   *  the Settings tab, loading the week: no panel is open then, so it is painted on the page. */
  @state() pageError = '';

  /** pm#513 — what each panel's form was refused, painted INSIDE that form: on a phone (and a
   *  tablet) the panel is a full-screen sheet, and a banner on the page underneath it is never
   *  seen. One per form: the Special days tab holds two panels, and saving one must neither show
   *  nor wipe the refusal of the other. */
  @state() hoursFormError = '';

  @state() specialFormError = '';

  @state() overrideFormError = '';

  @state() saving = false;

  /** True while `schedules.business_hours.confirm_week` is in flight. It disables the button so a
   *  second tap cannot re-sign the week — every confirmation REPLACES the rows, so two in flight
   *  race to write the same seven days. */
  @state() private confirming = false;

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
  /** schedules#54 — the text being typed into a date field, kept apart from the stored ISO date
   *  (which only ever holds a real 'YYYY-MM-DD' or ''): a half-typed «24/12» stays on screen. */
  @state() private dateDrafts: Partial<Record<DateField, string>> = {};

  @state() ovReason = '';

  @state() ovClosed = true;

  // The override's intervals being edited (schedules#23), independent of the special day's.
  @state() ovIntervals: Interval[] = blankIntervals();

  // Every live interval row of the hub's exceptions; the two tables fold them by exception.
  @state() private exceptionIntervals: ExceptionInterval[] = [];
  /** schedules#50 — see `TimeDrafts`. */
  @state() private timeDrafts: TimeDrafts | null = null;

  private specialCtrl!: ListController<SpecialDay>;

  private overrideCtrl!: ListController<ScheduleOverride>;

  private unsub?: () => void;

  // Getters (no campos): se reevalúan en cada render, así los textos cambian con el idioma activo
  // (ADR-0055). `connectedCallback` re-renderiza al recibir `erplora:locale-changed`.
  private dayLabel(value: number): string {
    return DAY_KEYS[value] ? erplora().t(CATALOG, DAY_KEYS[value]) : String(value);
  }

  /** Title for the hours edit panel, e.g. «Edit hours — Monday» (pm#450). */
  private editDayTitle(day: number): string {
    return erplora().t(CATALOG, 'ui.editDayTitle').replace('{day}', this.dayLabel(day));
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
    return foldWeek(this.hoursRows, this.settings.week_starts_on);
  }

  /**
   * True while the week on screen is still the one WE guessed at install time (schedules#36).
   *
   * Seeding a default week is what lets `appointments` finally refuse a booking out of hours, but
   * it also means the door starts refusing against hours nobody chose. So the screen names the
   * guess while it is still a guess — and stops the moment a person saves any day, because
   * `schedules.business_hours.set` clears the day and re-inserts it stamped with the real user.
   *
   * «Every live row», not «some row»: once the owner has saved one day they have seen the week
   * day by day, and a notice that outlives that reading is noise. A hub with no rows at all is
   * older than the seed — there is no default to confirm and the table's own empty state speaks.
   */
  private get weekIsUnconfirmed(): boolean {
    return this.hoursRows.length > 0 && this.hoursRows.every((r) => r.created_by === SEED_AUTHOR);
  }

  private formatIntervals(r: Record<string, unknown>): string {
    const t = (k: string): string => erplora().t(CATALOG, k);
    if (Number(r.is_closed)) return t('ui.closed');
    const intervals = (r.intervals as Interval[] | undefined) ?? [];
    if (!intervals.length) return t('ui.notSet');
    if (intervals.length === 1 && intervals[0].open_time === '00:00' && intervals[0].close_time === '00:00') return t('ui.open24h');
    return intervals.map((i) => this.fmtSpan(i.open_time, i.close_time)).join(' · ');
  }

  /** «09:00–14:00» in the hub's clock (schedules#50): the list and the panel read the same hour. */
  private fmtSpan(open: string | null | undefined, close: string | null | undefined): string {
    const locale = erplora().locale;
    return `${formatWallTime(String(open ?? ''), locale)}–${formatWallTime(String(close ?? ''), locale)}`;
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
    if (!intervals.length) return this.fmtSpan(r.open_time as string | null, r.close_time as string | null);
    if (intervals.length === 1 && intervals[0].open_time === '00:00' && intervals[0].close_time === '00:00') return t('ui.open24h');
    return intervals.map((i) => this.fmtSpan(i.open_time, i.close_time)).join(' · ');
  }

  /** A `'YYYY-MM-DD'` date as the hub's locale reads it (schedules#29): `25/08/2026`, never the
   *  raw ISO. Built from UTC pieces and formatted in UTC so the wall date never shifts with the
   *  browser's timezone — the string IS the date, it names no instant. Anything that is not an
   *  ISO date falls through untouched. */
  private fmtDate(iso: unknown): string {
    const s = String(iso ?? '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    const [y, m, d] = s.split('-').map(Number);
    return new Intl.DateTimeFormat(erplora().locale || 'es', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      timeZone: 'UTC',
    }).format(new Date(Date.UTC(y, m - 1, d)));
  }

  private get specialColumns(): DataTableColumn[] {
    const t = (k: string): string => erplora().t(CATALOG, k);
    return [
      { key: 'date', header: t('ui.colDate'), sortable: true, filterable: true, filterType: 'daterange', format: (r) => this.fmtDate(r.date) },
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
      { key: 'start_date', header: t('ui.colFrom'), sortable: true, filterable: true, filterType: 'daterange', format: (r) => this.fmtDate(r.start_date) },
      { key: 'end_date', header: t('ui.colTo'), sortable: true, filterable: true, filterType: 'daterange', format: (r) => this.fmtDate(r.end_date) },
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
      this.pageError = e instanceof Error ? e.message : String(e);
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
      // `schedules.settings.get` is plain SQL, so the runtime answers a ROW ARRAY (`[row]`) —
      // assigning that straight in left every control empty (PR #26). And the row still carries
      // columns this screen no longer owns, so it is NORMALISED, not spread: only a week start
      // the form can actually show survives.
      const answer = await erplora().query<unknown>('schedules.settings.get');
      const row = Array.isArray(answer) ? answer[0] : answer;
      if (row && typeof row === 'object') {
        const stored = Number((row as { week_starts_on?: unknown }).week_starts_on);
        this.settings = { week_starts_on: stored === 7 ? 7 : 1 };
      }
    } catch {
      /* optional settings: a missing row is not an error, the defaults stand */
    }
  }

  /** pm#513: a refusal appears ABOVE the button that was pressed, at the foot of a form that can be
   *  taller than a phone — bring it into view ONCE, when it arrives (only a CHANGE of that error
   *  scrolls: every keystroke re-renders the form, and the sheet must stay where the person types). */
  updated(changed: PropertyValues<this>): void {
    super.updated(changed);
    if (changed.has('hoursFormError') && this.hoursFormError) void this.revealRefusal('[data-testid="schedules-hours-form-error"]');
    if (changed.has('specialFormError') && this.specialFormError) void this.revealRefusal('[data-testid="schedules-special-form-error"]');
    if (changed.has('overrideFormError') && this.overrideFormError) void this.revealRefusal('[data-testid="schedules-override-form-error"]');
  }

  /** Scrolls a form's banner into view once it has painted itself: scrolled before, the banner still
   *  measures 0 px and ends up under the tab bar. */
  private async revealRefusal(selector: string): Promise<void> {
    const banner = this.renderRoot.querySelector(selector) as (HTMLElement & { updateComplete?: Promise<unknown> }) | null;
    await banner?.updateComplete;
    banner?.scrollIntoView?.({ block: 'center' });
  }

  /** Side panel of one of the view's tables (each table has its own). */
  private dataTable(id: string): { open(p?: 'filters' | 'create' | 'edit', opts?: { title?: string }): void; close(): void } | null {
    return this.renderRoot.querySelector(`#${id}`) as
      | { open(p?: 'filters' | 'create' | 'edit', opts?: { title?: string }): void; close(): void }
      | null;
  }

  /** schedules#43 — «Yes, these are my hours»: signs the week ALREADY on screen, as it is.
   *
   *  The onboarding step «Confirm your opening hours» is ticked by the rows a PERSON saved, so a
   *  business whose real week is the one we seeded had no way to finish it but to open some day
   *  and save it back unchanged. One command re-signs the seven days in ONE transaction (seven
   *  chained dispatches from here would leave a half-signed week behind the first failure), and
   *  it carries NO hours: the week it signs is the one the runtime pre-loads.
   */
  private async confirmWeek() {
    if (this.confirming) return;
    this.confirming = true;
    this.pageError = '';
    try {
      await erplora().command('schedules.business_hours.confirm_week', {});
      // The notice reads `created_by`, so it only goes quiet once the signed rows are back.
      await this.loadHours();
    } catch (e) {
      this.pageError = domainErrorText(e, 'ui.errorConfirmWeek');
    } finally {
      this.confirming = false;
    }
  }

  /** Replaces the day's intervals (`schedules.business_hours.set` with `intervals[]`, schedules#8).
   *  A closed day sends no intervals; an open day needs every interval complete — the handler
   *  validates order, overlaps, overnight and 24 h. */
  private async saveBusinessHours(ev: Event) {
    ev.preventDefault();
    const intervals = this.bhClosed ? [] : this.bhIntervals.map((i) => ({ open_time: i.open_time, close_time: i.close_time }));
    if (!this.bhClosed && (!intervals.length || intervals.some((i) => !i.open_time || !i.close_time))) {
      this.hoursFormError = erplora().t(CATALOG, 'ui.errorHoursRequired');
      return;
    }
    this.saving = true;
    this.hoursFormError = '';
    this.pageError = ''; // a save is the next thing the person did: an older page refusal is stale
    try {
      await erplora().command('schedules.business_hours.set', {
        day_of_week: Number(this.bhDay),
        is_closed: this.bhClosed,
        intervals,
      });
      this.dataTable('tbl-hours')?.close();
      await this.loadHours();
    } catch (e) {
      // A business refusal paints as the translated `schedules.*` sentence (schedules#28).
      this.hoursFormError = domainErrorText(e, 'ui.errorSaveHours');
    } finally {
      this.saving = false;
    }
  }

  /** Row action «edit»: the seven days are fixed, so editing a day opens the panel already
   *  filled with its intervals. pm#450 — the panel opens in edit mode titled with the day
   *  (OutfitKit >= 0.1.94 paints the title in the header). */
  private onHoursAction(ev: CustomEvent<{ actionId: string; row: Record<string, unknown> }>) {
    if (ev.detail.actionId !== 'edit') return;
    const row = ev.detail.row as WeekRow;
    this.bhDay = Number(row.day_of_week);
    this.bhClosed = !!row.is_closed;
    const intervals = (row.intervals ?? []).map((i) => ({ ...i }));
    this.bhIntervals = intervals.length ? intervals : [{ open_time: '09:00', close_time: '18:00' }];
    // Every field now holds THIS day: a refusal about the day edited before no longer applies.
    this.hoursFormError = '';
    this.dataTable('tbl-hours')?.open('edit', { title: this.editDayTitle(this.bhDay) });
  }

  /** Changing the day inside the panel re-titles it, so the header always names the day being edited. */
  private onDayChange(value: unknown) {
    this.bhDay = Number(value);
    this.dataTable('tbl-hours')?.open('edit', { title: this.editDayTitle(this.bhDay) });
  }

  /** schedules#54 — what a date field shows: the raw text while it is being typed, the stored
   *  date in the hub's day/month order otherwise (never the browser's, as a native date field). */
  private dateFieldValue(field: DateField): string {
    return this.dateDrafts[field] ?? formatCalendarDate(this[field], erplora().locale);
  }

  /** schedules#54 — `ionInput`: the text is kept as the draft and the stored date follows it
   *  exactly, back to '' while it is not (yet) a date, so a half-typed date never saves the last
   *  valid one (the save stays off without a date). */
  private onDateInput(field: DateField, text: string): void {
    this.dateDrafts = { ...this.dateDrafts, [field]: text };
    this[field] = parseCalendarDate(text, erplora().locale) ?? '';
  }

  /** schedules#54 — blur/Enter (`ionChange`), or a save: forget the draft so the field repaints
   *  the stored date in the hub's order. */
  private forgetDateDraft(field: DateField): void {
    if (!(field in this.dateDrafts)) return;
    const { [field]: _typed, ...rest } = this.dateDrafts;
    this.dateDrafts = rest;
  }

  /** Special day (schedules#7): the payload is exactly what `schemas/special_day_create.json`
   *  accepts. Open days carry both hours (the handler requires them); the duplicate check is an
   *  authoritative runtime read (`reads` in the manifest), NOT a client-supplied list. */
  private async createSpecialDay(ev: Event) {
    ev.preventDefault();
    if (!this.sdDate || !this.sdName.trim()) return;
    const intervals = this.exceptionPayloadIntervals(this.sdClosed, this.sdIntervals);
    if (!intervals) {
      this.specialFormError = erplora().t(CATALOG, 'ui.errorHoursRequired');
      return;
    }
    this.saving = true;
    this.specialFormError = '';
    this.pageError = ''; // a save is the next thing the person did: an older page refusal is stale
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
      this.forgetDateDraft('sdDate');
      this.sdName = '';
      this.sdClosed = true;
      this.sdIntervals = blankIntervals();
      this.sdRecurring = false;
      this.sdNotes = '';
      this.dataTable('tbl-special')?.close();
      await Promise.all([this.specialCtrl.load(), this.loadExceptionIntervals()]);
    } catch (e) {
      this.specialFormError = domainErrorText(e, 'ui.errorCreateSpecialDay');
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
      this.overrideFormError = erplora().t(CATALOG, 'ui.errorHoursRequired');
      return;
    }
    this.saving = true;
    this.overrideFormError = '';
    this.pageError = ''; // a save is the next thing the person did: an older page refusal is stale
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
      this.forgetDateDraft('ovStart');
      this.forgetDateDraft('ovEnd');
      this.ovReason = '';
      this.ovClosed = true;
      this.ovIntervals = blankIntervals();
      this.dataTable('tbl-override')?.close();
      await Promise.all([this.overrideCtrl.load(), this.loadExceptionIntervals()]);
    } catch (e) {
      this.overrideFormError = domainErrorText(e, 'ui.errorCreateOverride');
    } finally {
      this.saving = false;
    }
  }

  private async saveSettings(ev: Event) {
    ev.preventDefault();
    this.saving = true;
    this.pageError = '';
    try {
      await erplora().command('schedules.settings.save', {
        week_starts_on: Number(this.settings.week_starts_on),
      });
      await this.loadSettings();
    } catch (e) {
      this.pageError = domainErrorText(e, 'ui.errorSaveSettings');
    } finally {
      this.saving = false;
    }
  }

  // Destructive actions ask first (schedules#6): the row is parked and the ion-alert decides.
  private onSpecialAction(ev: CustomEvent<{ actionId: string; row: Record<string, unknown> }>) {
    if (ev.detail.actionId !== 'delete') return;
    const row = ev.detail.row;
    this.pendingDelete = { kind: 'special_day', id: String(row.id), label: String(row.name || this.fmtDate(row.date) || '') };
  }

  private onOverrideAction(ev: CustomEvent<{ actionId: string; row: Record<string, unknown> }>) {
    if (ev.detail.actionId !== 'delete') return;
    const row = ev.detail.row;
    this.pendingDelete = { kind: 'override', id: String(row.id), label: String(row.reason || this.fmtDate(row.start_date) || '') };
  }

  private async onDeleteDismiss(ev: CustomEvent<{ role?: string }>) {
    const pending = this.pendingDelete;
    this.pendingDelete = null;
    if (ev.detail?.role !== 'confirm' || !pending) return;
    this.pageError = '';
    try {
      if (pending.kind === 'special_day') {
        await erplora().command('schedules.special_days.delete', { special_day_id: pending.id });
        await Promise.all([this.specialCtrl.load(), this.loadExceptionIntervals()]);
      } else {
        await erplora().command('schedules.overrides.delete', { override_id: pending.id });
        await Promise.all([this.overrideCtrl.load(), this.loadExceptionIntervals()]);
      }
    } catch (e) {
      this.pageError = domainErrorText(e, 'ui.errorDelete');
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
    scope: IntervalScope,
    intervals: Interval[],
    update: (index: number, patch: Partial<Interval>) => void,
    add: () => void,
    remove: (index: number) => void,
  ) {
    const t = (k: string): string => erplora().t(CATALOG, k);
    // schedules#50 — TEXT fields painted in the hub's clock, not `type="time"`: the browser paints
    // a native time field with its own (operating system) clock, whatever the hub language.
    return html`
      ${intervals.map(
        (it, i) => html`<div class="interval">
          <ion-input data-testid=${`schedules-interval-open-${scope}-${i}`} data-role="interval-time" fill="outline" mode="md" label-placement="floating" label=${t('ui.fieldOpen')} type="text" inputmode="numeric" autocomplete="off" placeholder=${t('ui.timePlaceholder')} .value=${this.timeFieldValue(scope, intervals, it, i, 'open_time')} @ionInput=${(e: any) => this.onTimeInput(scope, intervals, update, i, 'open_time', String(e.target.value ?? ''))} @ionChange=${() => this.commitTimeDraft(scope, intervals, i, 'open_time')} @paste=${(e: Event) => this.onTimePaste(scope, intervals, update, i, 'open_time', e)}></ion-input>
          <ion-input data-testid=${`schedules-interval-close-${scope}-${i}`} data-role="interval-time" fill="outline" mode="md" label-placement="floating" label=${t('ui.fieldClose')} type="text" inputmode="numeric" autocomplete="off" placeholder=${t('ui.timePlaceholder')} .value=${this.timeFieldValue(scope, intervals, it, i, 'close_time')} @ionInput=${(e: any) => this.onTimeInput(scope, intervals, update, i, 'close_time', String(e.target.value ?? ''))} @ionChange=${() => this.commitTimeDraft(scope, intervals, i, 'close_time')} @paste=${(e: Event) => this.onTimePaste(scope, intervals, update, i, 'close_time', e)}></ion-input>
          <ion-button data-testid=${`schedules-interval-remove-${scope}-${i}`} fill="clear" size="small" class="tone-medium" data-action="remove-interval" aria-label=${t('ui.removeInterval')} ?disabled=${intervals.length <= 1} @click=${() => remove(i)}><ion-icon slot="icon-only" name="close-outline"></ion-icon></ion-button>
        </div>`,
      )}
      <ion-button data-testid=${`schedules-interval-add-${scope}`} fill="outline" size="small" data-action="add-interval" @click=${() => add()}>${t('ui.addInterval')}</ion-button>
      <p class="hint">${t('ui.intervalsHint')}</p>
    `;
  }

  /** The stored interval list of a scope — what `update` has just replaced. */
  private intervalsOf(scope: IntervalScope): Interval[] {
    return scope === 'hours' ? this.bhIntervals : scope === 'special' ? this.sdIntervals : this.ovIntervals;
  }

  /** The drafts typed against THIS very list, or none (see `TimeDrafts`). */
  private draftsFor(scope: IntervalScope, intervals: Interval[]): Record<string, string> {
    const d = this.timeDrafts;
    return d && d.scope === scope && d.owner === intervals ? d.texts : {};
  }

  /** schedules#50 — what a time field shows: the raw text while it is being typed (a half-typed
   *  «14:» stays on screen), the stored hour in the hub's clock otherwise. */
  private timeFieldValue(scope: IntervalScope, intervals: Interval[], it: Interval, i: number, field: TimeField): string {
    const draft = this.draftsFor(scope, intervals)[`${i}:${field}`];
    return draft ?? formatWallTime(it[field], erplora().locale);
  }

  /** schedules#50 — `ionInput`: the text is kept as the draft and the stored hour follows it
   *  exactly, back to '' while it is not (yet) a time — so a half-typed hour never saves the last
   *  valid one (the save refuses an incomplete line). */
  private onTimeInput(
    scope: IntervalScope,
    intervals: Interval[],
    update: (index: number, patch: Partial<Interval>) => void,
    i: number,
    field: TimeField,
    text: string,
  ): void {
    const texts = { ...this.draftsFor(scope, intervals), [`${i}:${field}`]: text };
    update(i, { [field]: parseWallTime(text) ?? '' });
    this.timeDrafts = { scope, owner: this.intervalsOf(scope), texts };
  }

  /** schedules#50 — blur/Enter (`ionChange`): forget the draft so the field repaints the stored
   *  hour in the hub's clock. */
  private commitTimeDraft(scope: IntervalScope, intervals: Interval[], i: number, field: TimeField): void {
    const texts = { ...this.draftsFor(scope, intervals) };
    if (!(`${i}:${field}` in texts)) return;
    delete texts[`${i}:${field}`];
    this.timeDrafts = { scope, owner: intervals, texts };
  }

  /** schedules#50 — a time pasted in any spelling the parser reads is stored and repainted in the
   *  hub's clock at once. Anything else is left to the browser's own paste. */
  private onTimePaste(
    scope: IntervalScope,
    intervals: Interval[],
    update: (index: number, patch: Partial<Interval>) => void,
    i: number,
    field: TimeField,
    e: Event,
  ): void {
    const time = parseWallTime((e as ClipboardEvent).clipboardData?.getData('text') ?? '');
    if (!time) return;
    e.preventDefault();
    const texts = { ...this.draftsFor(scope, intervals) };
    delete texts[`${i}:${field}`];
    update(i, { [field]: time });
    this.timeDrafts = { scope, owner: this.intervalsOf(scope), texts };
  }

  private renderHours() {
    const t = (k: string): string => erplora().t(CATALOG, k);
    const isAllDay = this.bhIntervals.length === 1 && this.bhIntervals[0].open_time === '00:00' && this.bhIntervals[0].close_time === '00:00';
    return html`<div class="pane">
        <!-- The week we planted at install time says so out loud until somebody confirms it
             (schedules#36). It sits above the table because it is about the whole week, and only
             here: the Hours tab is where a week gets confirmed. -->
        ${this.weekIsUnconfirmed
          ? html`<ok-inline-feedback data-testid="schedules-hours-default-week" data-role="default-week" tone="warning" icon="alert-circle-outline">
              <!-- The sentence gets its OWN node: the notice now carries an action too, so the
                   whole banner's text is no longer just the message (schedules#43). -->
              <span data-role="default-week-message">${t('ui.defaultWeekNotice')}</span>
              <!-- The way OUT of the notice, inside the notice: a business the default week fits
                   confirms it here instead of re-saving a day it never changed (schedules#43). -->
              <ion-button data-testid="schedules-hours-confirm-week" slot="actions" size="small" data-action="confirm-week" ?disabled=${this.confirming} @click=${() => this.confirmWeek()}>${t('ui.confirmWeek')}</ion-button>
            </ok-inline-feedback>`
          : nothing}
        <!-- Seven fixed rows (one per weekday), no «+»: a day is EDITED, never added (schedules#8).
             No rows-per-page selector either (schedules#29): this view paints ALL seven weekdays and
             never pages, and an empty dropdown that does nothing is a control that lies.
             pm#450 — the panel opens with open('edit', { title }), painted by OutfitKit >= 0.1.94.
             Older shells (OutfitKit < 0.1.94, e.g. 0.1.73 in hub:stable) ignore that title and paint
             labels.newRecord for any non-filters panel, edit included (staff#68 fallback), so the
             same title also goes through .labels; the table merges .labels over its own defaults,
             so only newRecord changes. -->
        <ok-data-table id="tbl-hours" testid="schedules-hours-table" .fill=${true} .views=${true} .defaultView=${this.defaultView} .pageSizeOptions=${[]} .cardTitle=${(row: Record<string, unknown>) => this.dayLabel(Number(row.day_of_week))} .columns=${this.hoursColumns} .rows=${this.weekRows} .pageSize=${7} .actions=${this.hoursActions} .labels=${{ newRecord: this.editDayTitle(this.bhDay) }} .rowClickable=${true} @rowAction=${(e: CustomEvent) => this.onHoursAction(e)} @rowClick=${(e: CustomEvent<{ row: Record<string, unknown> }>) => this.onHoursAction({ detail: { actionId: 'edit', row: e.detail.row } } as CustomEvent<{ actionId: string; row: Record<string, unknown> }>)} .emptyMessage=${t('ui.emptyHours')}>
          <!-- The day editor lives in the table's panel. Projected ALWAYS: painted only when open,
               the «edit» action would find an empty panel. -->
          <form data-testid="schedules-hours-form" slot="create" class="form" @submit=${(e: Event) => this.saveBusinessHours(e)}>
            <ion-select data-testid="schedules-hours-day" fill="outline" label-placement="floating" label=${t('ui.fieldDay')} .value=${this.bhDay} @ionChange=${(e: any) => this.onDayChange(e.target.value)}>
              ${DAY_KEYS.map((_, value) => html`<ion-select-option .value=${value}>${this.dayLabel(value)}</ion-select-option>`)}
            </ion-select>
            <label class="chk">
              <ion-checkbox data-testid="schedules-hours-closed" ?checked=${this.bhClosed} @ionChange=${(e: any) => (this.bhClosed = !!e.target.checked)}></ion-checkbox>
              ${t('ui.closed')}
            </label>
            ${this.bhClosed
              ? nothing
              : html`
                  <label class="chk">
                    <ion-checkbox data-testid="schedules-hours-open-24h" ?checked=${isAllDay} @ionChange=${(e: any) => (e.target.checked ? this.setAllDay() : (this.bhIntervals = [{ open_time: '09:00', close_time: '18:00' }]))}></ion-checkbox>
                    ${t('ui.open24h')}
                  </label>
                  ${isAllDay
                    ? nothing
                    : this.renderIntervalEditor(
                        'hours',
                        this.bhIntervals,
                        (i, patch) => this.updateInterval(i, patch),
                        () => this.addInterval(),
                        (i) => this.removeInterval(i),
                      )}
                `}
            <!-- pm#513: the refusal travels WITH the form — on a phone the panel is a full-screen
                 sheet and a banner on the page underneath it is never seen. -->
            ${this.hoursFormError
              ? html`<ok-inline-feedback data-testid="schedules-hours-form-error" tone="danger" icon="alert-circle-outline">${this.hoursFormError}</ok-inline-feedback>`
              : nothing}
            <ion-button data-testid="schedules-hours-submit" type="submit" size="small" ?disabled=${this.saving}>${this.saving ? t('ui.saving') : t('ui.saveDay')}</ion-button>
          </form>
        </ok-data-table>
      </div>`;
  }

  private renderSpecialDays() {
    const t = (k: string): string => erplora().t(CATALOG, k);
    return html`<div class="pane">
        <!-- Two collections, two tables, each labelled (schedules#6): a dated exception vs a range. -->
        <h3>${t('ui.specialDays')}</h3>
        <ok-data-table id="tbl-special" testid="schedules-special-table" .error=${this.specialCtrl?.error ?? ''} @retry=${() => Promise.all([this.specialCtrl.load(), this.loadExceptionIntervals()])} .serverSide=${true} .fill=${true} .addable=${true} .views=${true} .defaultView=${this.defaultView} .cardTitle=${(row: Record<string, unknown>) => String(row.name || this.fmtDate(row.date) || '—')} .columns=${this.specialColumns} .rows=${this.specialCtrl?.rows ?? []} .total=${this.specialCtrl?.total ?? 0} .page=${this.specialCtrl?.state.page ?? 0} .pageSize=${this.specialCtrl?.state.pageSize ?? 50} .sort=${this.specialCtrl?.state.sort} .sortDir=${this.specialCtrl?.state.dir ?? 'asc'} .searchable=${true} .searchPlaceholder=${t('ui.searchSpecialDay')} .actions=${this.rowActions} @rowAction=${(e: CustomEvent) => this.onSpecialAction(e)} .emptyMessage=${this.specialCtrl?.loading ? t('ui.loading') : t('ui.emptySpecialDays')} @pageChange=${(e: CustomEvent<number>) => this.specialCtrl.setPage(e.detail)} @sortChange=${(e: CustomEvent<{ sort: string; dir: 'asc' | 'desc' }>) => this.specialCtrl.setSort(e.detail.sort, e.detail.dir)} @searchChange=${(e: CustomEvent<string>) => this.specialCtrl.setSearch(e.detail)} @filterChange=${(e: CustomEvent<{ col: string; value: unknown }>) => this.specialCtrl.setFilter(e.detail.col, e.detail.value)}>
          <form data-testid="schedules-special-form" slot="create" class="form" @submit=${(e: Event) => this.createSpecialDay(e)}>
            <!-- schedules#54: text in the hub's day/month order, not the native date input (browser order). -->
            <ion-input data-testid="schedules-special-date" fill="outline" mode="md" label-placement="floating" label=${t('ui.colDate')} type="text" inputmode="numeric" autocomplete="off" placeholder=${t('ui.datePlaceholder')} .value=${this.dateFieldValue('sdDate')} @ionInput=${(e: any) => this.onDateInput('sdDate', String(e.target.value ?? ''))} @ionChange=${() => this.forgetDateDraft('sdDate')}></ion-input>
            <ion-input data-testid="schedules-special-name" fill="outline" label-placement="floating" label=${t('ui.colName')} placeholder=${t('ui.placeholderName')} .value=${this.sdName} @ionInput=${(e: any) => (this.sdName = e.target.value)}></ion-input>
            <ion-select data-testid="schedules-special-status" fill="outline" label-placement="floating" label=${t('ui.colStatus')} .value=${this.sdClosed ? 'closed' : 'open'} @ionChange=${(e: any) => (this.sdClosed = e.target.value === 'closed')}>
              <ion-select-option value="closed">${t('ui.closed')}</ion-select-option>
              <ion-select-option value="open">${t('ui.openWithHours')}</ion-select-option>
            </ion-select>
            ${this.sdClosed
              ? nothing
              : this.renderIntervalEditor(
                  'special',
                  this.sdIntervals,
                  (i, patch) => (this.sdIntervals = this.sdIntervals.map((it, n) => (n === i ? { ...it, ...patch } : it))),
                  () => this.addSpecialDayInterval(),
                  (i) => this.removeSpecialDayInterval(i),
                )}
            <label class="chk">
              <ion-checkbox data-testid="schedules-special-recurring" ?checked=${this.sdRecurring} @ionChange=${(e: any) => (this.sdRecurring = !!e.target.checked)}></ion-checkbox>
              ${t('ui.fieldRecurring')}
            </label>
            <ion-input data-testid="schedules-special-notes" fill="outline" label-placement="floating" label=${t('ui.fieldNotes')} .value=${this.sdNotes} @ionInput=${(e: any) => (this.sdNotes = e.target.value)}></ion-input>
            <!-- pm#513: the refusal travels WITH the form — on a phone the panel is a full-screen
                 sheet and a banner on the page underneath it is never seen. -->
            ${this.specialFormError
              ? html`<ok-inline-feedback data-testid="schedules-special-form-error" tone="danger" icon="alert-circle-outline">${this.specialFormError}</ok-inline-feedback>`
              : nothing}
            <ion-button data-testid="schedules-special-submit" type="submit" size="small" ?disabled=${this.saving || !this.sdDate || !this.sdName}>${this.saving ? t('ui.saving') : t('ui.addDay')}</ion-button>
          </form>
        </ok-data-table>
        <!-- Las excepciones son OTRA entidad (otra tabla) → llevan su propio panel de alta. -->
        <h3>${t('ui.overrides')}</h3>
        <ok-data-table id="tbl-override" testid="schedules-override-table" .error=${this.overrideCtrl?.error ?? ''} @retry=${() => Promise.all([this.overrideCtrl.load(), this.loadExceptionIntervals()])} .serverSide=${true} .fill=${true} .addable=${true} .views=${true} .defaultView=${this.defaultView} .cardTitle=${(row: Record<string, unknown>) => String(row.reason || this.fmtDate(row.start_date) || '—')} .columns=${this.overrideColumns} .rows=${this.overrideCtrl?.rows ?? []} .total=${this.overrideCtrl?.total ?? 0} .page=${this.overrideCtrl?.state.page ?? 0} .pageSize=${this.overrideCtrl?.state.pageSize ?? 50} .sort=${this.overrideCtrl?.state.sort} .sortDir=${this.overrideCtrl?.state.dir ?? 'asc'} .searchable=${true} .searchPlaceholder=${t('ui.searchOverride')} .actions=${this.rowActions} @rowAction=${(e: CustomEvent) => this.onOverrideAction(e)} .emptyMessage=${this.overrideCtrl?.loading ? t('ui.loading') : t('ui.emptyOverrides')} @pageChange=${(e: CustomEvent<number>) => this.overrideCtrl.setPage(e.detail)} @sortChange=${(e: CustomEvent<{ sort: string; dir: 'asc' | 'desc' }>) => this.overrideCtrl.setSort(e.detail.sort, e.detail.dir)} @searchChange=${(e: CustomEvent<string>) => this.overrideCtrl.setSearch(e.detail)} @filterChange=${(e: CustomEvent<{ col: string; value: unknown }>) => this.overrideCtrl.setFilter(e.detail.col, e.detail.value)}>
          <form data-testid="schedules-override-form" slot="create" class="form" @submit=${(e: Event) => this.createOverride(e)}>
            <!-- schedules#54: text in the hub's day/month order, not the native date input (browser order). -->
            <ion-input data-testid="schedules-override-from" fill="outline" mode="md" label-placement="floating" label=${t('ui.colFrom')} type="text" inputmode="numeric" autocomplete="off" placeholder=${t('ui.datePlaceholder')} .value=${this.dateFieldValue('ovStart')} @ionInput=${(e: any) => this.onDateInput('ovStart', String(e.target.value ?? ''))} @ionChange=${() => this.forgetDateDraft('ovStart')}></ion-input>
            <ion-input data-testid="schedules-override-to" fill="outline" mode="md" label-placement="floating" label=${t('ui.colTo')} type="text" inputmode="numeric" autocomplete="off" placeholder=${t('ui.datePlaceholder')} .value=${this.dateFieldValue('ovEnd')} @ionInput=${(e: any) => this.onDateInput('ovEnd', String(e.target.value ?? ''))} @ionChange=${() => this.forgetDateDraft('ovEnd')}></ion-input>
            <ion-input data-testid="schedules-override-reason" fill="outline" label-placement="floating" label=${t('ui.colReason')} .value=${this.ovReason} @ionInput=${(e: any) => (this.ovReason = e.target.value)}></ion-input>
            <ion-select data-testid="schedules-override-status" fill="outline" label-placement="floating" label=${t('ui.colStatus')} .value=${this.ovClosed ? 'closed' : 'open'} @ionChange=${(e: any) => (this.ovClosed = e.target.value === 'closed')}>
              <ion-select-option value="closed">${t('ui.closed')}</ion-select-option>
              <ion-select-option value="open">${t('ui.openWithHours')}</ion-select-option>
            </ion-select>
            ${this.ovClosed
              ? nothing
              : this.renderIntervalEditor(
                  'override',
                  this.ovIntervals,
                  (i, patch) => (this.ovIntervals = this.ovIntervals.map((it, n) => (n === i ? { ...it, ...patch } : it))),
                  () => this.addOverrideInterval(),
                  (i) => this.removeOverrideInterval(i),
                )}
            <!-- pm#513: the refusal travels WITH the form — on a phone the panel is a full-screen
                 sheet and a banner on the page underneath it is never seen. -->
            ${this.overrideFormError
              ? html`<ok-inline-feedback data-testid="schedules-override-form-error" tone="danger" icon="alert-circle-outline">${this.overrideFormError}</ok-inline-feedback>`
              : nothing}
            <ion-button data-testid="schedules-override-submit" type="submit" size="small" ?disabled=${this.saving || !this.ovStart || !this.ovEnd || !this.ovReason}>${this.saving ? t('ui.saving') : t('ui.addOverride')}</ion-button>
          </form>
        </ok-data-table>
      </div>`;
  }

  /** The hub's Settings, on the tab where the business zone is really decided (its country). */
  private goToHubSettings(): void {
    window.history.pushState({}, '', '/settings#hub');
    window.dispatchEvent(new PopStateEvent('popstate'));
  }

  // Los ajustes NO son el alta de una fila (son configuración del módulo): su formulario se queda
  // FUERA de cualquier tabla, a propósito.
  private renderSettings() {
    const t = (k: string): string => erplora().t(CATALOG, k);
    // THE BUSINESS TIMEZONE IS THE CORE'S (schedules#9). It is declared in the hub settings or
    // deduced from the country, and the runtime hands the SAME resolved name to this screen
    // (`erplora.timezone`) and to the engine (`context.timezone`). Shown here, changed there:
    // a second field to type it in was an authority nothing obeyed.
    const zone = (erplora().timezone ?? '').trim();
    return html`<div class="settings-core">
        <div class="kv"><span class="k">${t('ui.timezoneEffective')}</span><code>${zone || t('ui.timezoneUnknown')}</code></div>
        <p class="hint">${t('ui.timezoneFromHub')}</p>
        <ion-button data-testid="schedules-settings-timezone-link" size="small" fill="outline" @click=${() => this.goToHubSettings()}>
          <ion-icon slot="start" name="open-outline"></ion-icon>
          ${t('ui.timezoneGoSettings')}
        </ion-button>
      </div>
      <form data-testid="schedules-settings-form" class="form settings" @submit=${(e: Event) => this.saveSettings(e)}>
        <ion-select data-testid="schedules-settings-week-start" fill="outline" label-placement="floating" label=${t('ui.fieldWeekStart')} .value=${this.settings.week_starts_on} @ionChange=${(e: any) => (this.settings = { ...this.settings, week_starts_on: Number(e.target.value) })}>
          <ion-select-option .value=${1}>${t('ui.monday')}</ion-select-option>
          <ion-select-option .value=${7}>${t('ui.sunday')}</ion-select-option>
        </ion-select>
        <ion-button data-testid="schedules-settings-submit" type="submit" size="small" ?disabled=${this.saving}>${this.saving ? t('ui.saving') : t('ui.save')}</ion-button>
      </form>`;
  }

  render() {
    const t = (k: string): string => erplora().t(CATALOG, k);
    // No internal nav (schedules#6): the shell's tabbar + route are the only navigation (ADR-0022).
    // Each banner keeps the name of WHERE its error came from (schedules#46): the three can be up
    // at once, and a spec that saved a bad weekday waits for THAT one, not for «the first banner».
    // A list that could not load says so in its own table, with Retry (pm#533); its banner stays
    // only on a shell whose table cannot paint the error, where it is the one place with the reason.
    const errors = [
      { source: 'page', text: this.pageError },
      { source: 'special', text: dataTableShowsLoadError() ? '' : this.specialCtrl?.error },
      { source: 'override', text: dataTableShowsLoadError() ? '' : this.overrideCtrl?.error },
    ].filter((e) => Boolean(e.text));
    return html`<div class="page">
        ${errors.map(
          (e) =>
            html`<ok-inline-feedback data-testid=${`schedules-error-${e.source}`} tone="danger" icon="alert-circle-outline">${e.text}</ok-inline-feedback>`,
        )}
        ${this.tab === 'hours' ? this.renderHours() : nothing}
        ${this.tab === 'special_days' ? this.renderSpecialDays() : nothing}
        ${this.tab === 'settings' ? this.renderSettings() : nothing}
        <ion-alert
          data-testid="schedules-delete-confirm"
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
