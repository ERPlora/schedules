import { LitElement, html, css, nothing } from 'lit';
import { state } from 'lit/decorators.js';
import { define } from '@erplora/outfitkit/define';
import '@erplora/outfitkit/ok-data-table';
import type { DataTableColumn } from '@erplora/outfitkit';
import { createListController } from '@erplora/module-sdk';
import type { ListController, ListClient, ListParams, ListPage } from '@erplora/module-sdk';

interface ErploraClientLike extends ListClient {
  query<T = unknown>(name: string, params?: Record<string, unknown>): Promise<T>;
  queryPage<R = unknown>(name: string, params: ListParams): Promise<ListPage<R>>;
  command<T = unknown>(name: string, payload?: Record<string, unknown>): Promise<T>;
  on(event: string, cb: (payload: unknown) => void): () => void;
}

interface BusinessHours {
  id: string;
  day_of_week: number;
  open_time: string;
  close_time: string;
  is_closed: number;
  break_start: string | null;
  break_end: string | null;
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

const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

const CLOSED_OPTIONS = [
  { value: '1', label: 'Cerrado' },
  { value: '0', label: 'Abierto' },
];

const YESNO_OPTIONS = [
  { value: '1', label: 'Sí' },
  { value: '0', label: 'No' },
];

type Tab = 'hours' | 'special_days' | 'settings';

function erplora(): ErploraClientLike {
  const c = (globalThis as { erplora?: ErploraClientLike }).erplora;
  if (!c) throw new Error('erplora SDK no inicializado por el shell');
  return c;
}

// TODO-LIT: componente multi-vista (varios métodos render) — revisar composición.

export class ErpSchedulesHours extends LitElement {
  static styles = css`
    :host { display:block; font-family: system-ui, sans-serif; color: var(--ink, #1c1b18); }
    header { display:flex; gap:.5rem; align-items:center; margin-bottom:.75rem; }
    h2 { margin:0; font-size:1.15rem; flex:1; }
    nav { display:flex; gap:.25rem; margin-bottom:1rem; }
    nav button { border:1px solid var(--line,#e7e2d6); background:var(--surface-2,#f7f4ec); border-radius:8px; padding:.4rem .8rem; cursor:pointer; }
    nav button.active { background:var(--accent,#1c1b18); color:#fff; }
    .form { display:flex; gap:.5rem; flex-wrap:wrap; align-items:end; margin:.5rem 0 1rem; }
    .form ion-input, .form ion-select { --background:var(--surface-2,#f7f4ec); border:1px solid var(--line,#e7e2d6); border-radius:8px; min-width:8rem; }
    .err { color:#d9480f; font-weight:600; }
    label.chk { display:flex; gap:.35rem; align-items:center; }
  `;

  @state() tab: Tab = 'hours';

  @state() settings: { timezone: string; week_starts_on: number; slot_duration: number; auto_close_enabled: number } = {
    timezone: 'Europe/Madrid',
    week_starts_on: 1,
    slot_duration: 30,
    auto_close_enabled: 0,
  };

  @state() formError = '';

  @state() saving = false;

  @state() tick = 0;

  @state() sdDate = '';

  @state() sdName = '';

  @state() sdClosed = true;

  @state() ovStart = '';

  @state() ovEnd = '';

  @state() ovReason = '';

  private hoursCtrl!: ListController<BusinessHours>;

  private specialCtrl!: ListController<SpecialDay>;

  private overrideCtrl!: ListController<ScheduleOverride>;

  private unsub?: () => void;

  private hoursColumns: DataTableColumn[] = [
    {
      key: 'day_of_week',
      header: 'Día',
      sortable: true,
      filterable: true,
      filterType: 'select',
      options: DAY_NAMES.map((label, value) => ({ value: String(value), label })),
      format: (r) => DAY_NAMES[r.day_of_week as number] ?? String(r.day_of_week),
    },
    { key: 'open_time', header: 'Abre', sortable: true, filterable: true, filterType: 'text', format: (r) => ((r.is_closed as number) ? 'Cerrado' : (r.open_time as string)) },
    { key: 'close_time', header: 'Cierra', sortable: true, filterable: true, filterType: 'text', format: (r) => ((r.is_closed as number) ? '—' : (r.close_time as string)) },
    { key: 'break_start', header: 'Descanso', sortable: true, filterable: true, filterType: 'text', format: (r) => (r.break_start ? `${r.break_start}–${r.break_end ?? ''}` : '—') },
  ];

  private specialColumns: DataTableColumn[] = [
    { key: 'date', header: 'Fecha', sortable: true, filterable: true, filterType: 'daterange' },
    { key: 'name', header: 'Nombre', sortable: true, filterable: true, filterType: 'text' },
    {
      key: 'is_closed',
      header: 'Estado',
      sortable: true,
      filterable: true,
      filterType: 'select',
      options: CLOSED_OPTIONS,
      format: (r) => ((r.is_closed as number) ? 'Cerrado' : `${r.open_time ?? ''}–${r.close_time ?? ''}`),
    },
    {
      key: 'recurring_yearly',
      header: 'Anual',
      sortable: true,
      filterable: true,
      filterType: 'select',
      options: YESNO_OPTIONS,
      format: (r) => ((r.recurring_yearly as number) ? 'Sí' : 'No'),
    },
  ];

  private overrideColumns: DataTableColumn[] = [
    { key: 'start_date', header: 'Desde', sortable: true, filterable: true, filterType: 'daterange' },
    { key: 'end_date', header: 'Hasta', sortable: true, filterable: true, filterType: 'daterange' },
    { key: 'reason', header: 'Motivo', sortable: true, filterable: true, filterType: 'text' },
    {
      key: 'is_closed',
      header: 'Estado',
      sortable: true,
      filterable: true,
      filterType: 'select',
      options: CLOSED_OPTIONS,
      format: (r) => ((r.is_closed as number) ? 'Cerrado' : `${r.open_time ?? ''}–${r.close_time ?? ''}`),
    },
  ];

  private rowActions = [{ id: 'delete', label: 'Eliminar', icon: 'trash-outline', color: 'danger' }];

  // TODO-LIT: componentWillLoad → connectedCallback. Recuerda: connectedCallback se dispara
  // en CADA reconexión al DOM (no solo en el primer montaje). Si la init debe correr una
  // sola vez tras el primer render, considera firstUpdated() en su lugar.
  async connectedCallback() {
    super.connectedCallback();
    const rerender = () => this.requestUpdate();
    this.hoursCtrl = createListController<BusinessHours>(erplora(), 'schedules.business_hours.list', rerender, {
      pageSize: 50,
      sort: 'id',
      dir: 'asc',
    });
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
      this.hoursCtrl.load(),
      this.specialCtrl.load(),
      this.overrideCtrl.load(),
      this.loadSettings(),
    ]);
    try {
      const offs = [
        'schedules.business_hours.updated',
        'schedules.special_day.created',
        'schedules.special_day.deleted',
        'schedules.override.created',
        'schedules.override.deleted',
        'schedules.settings.saved',
      ].map((ev) => erplora().on(ev, () => this.reloadAll()));
      this.unsub = () => offs.forEach((o) => o());
    } catch {
      /* sin SDK (preview) → sin reactividad en vivo */
    }
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.unsub?.();
  }

  private async reloadAll() {
    await Promise.all([
      this.hoursCtrl.load(),
      this.specialCtrl.load(),
      this.overrideCtrl.load(),
      this.loadSettings(),
    ]);
  }

  private async loadSettings() {
    try {
      const settings = await erplora().query<typeof this.settings | null>('schedules.settings.get');
      if (settings) this.settings = settings;
    } catch {
      /* ajustes opcionales */
    }
  }

  private async createSpecialDay(ev: Event) {
    ev.preventDefault();
    if (!this.sdDate || !this.sdName.trim()) return;
    this.saving = true;
    this.formError = '';
    try {
      await erplora().command('schedules.special_days.create', {
        date: this.sdDate,
        name: this.sdName.trim(),
        is_closed: this.sdClosed,
        recurring_yearly: false,
        notes: '',
      });
      this.sdDate = '';
      this.sdName = '';
      this.sdClosed = true;
      await this.specialCtrl.load();
    } catch (e) {
      this.formError = e instanceof Error ? e.message : 'No se pudo crear el día especial';
    } finally {
      this.saving = false;
    }
  }

  private async createOverride(ev: Event) {
    ev.preventDefault();
    if (!this.ovStart || !this.ovEnd || !this.ovReason.trim()) return;
    this.saving = true;
    this.formError = '';
    try {
      await erplora().command('schedules.overrides.create', {
        start_date: this.ovStart,
        end_date: this.ovEnd,
        reason: this.ovReason.trim(),
        is_closed: false,
      });
      this.ovStart = '';
      this.ovEnd = '';
      this.ovReason = '';
      await this.overrideCtrl.load();
    } catch (e) {
      this.formError = e instanceof Error ? e.message : 'No se pudo crear el override';
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
      this.formError = e instanceof Error ? e.message : 'No se pudieron guardar los ajustes';
    } finally {
      this.saving = false;
    }
  }

  private async onSpecialAction(ev: CustomEvent<{ actionId: string; row: Record<string, unknown> }>) {
    if (ev.detail.actionId !== 'delete') return;
    try {
      await erplora().command('schedules.special_days.delete', { special_day_id: ev.detail.row.id });
      await this.specialCtrl.load();
    } catch (e) {
      this.formError = e instanceof Error ? e.message : 'No se pudo eliminar';
    }
  }

  private async onOverrideAction(ev: CustomEvent<{ actionId: string; row: Record<string, unknown> }>) {
    if (ev.detail.actionId !== 'delete') return;
    try {
      await erplora().command('schedules.overrides.delete', { override_id: ev.detail.row.id });
      await this.overrideCtrl.load();
    } catch (e) {
      this.formError = e instanceof Error ? e.message : 'No se pudo eliminar';
    }
  }

  private renderHours() {
    return html`<ok-data-table .serverSide=${true} .columns=${this.hoursColumns} .rows=${this.hoursCtrl?.rows ?? []} .total=${this.hoursCtrl?.total ?? 0} .page=${this.hoursCtrl?.state.page ?? 0} .pageSize=${this.hoursCtrl?.state.pageSize ?? 50} .sort=${this.hoursCtrl?.state.sort} .sortDir=${this.hoursCtrl?.state.dir ?? 'asc'} .searchable=${true} .emptyMessage=${this.hoursCtrl?.loading ? 'Cargando…' : 'Sin horario configurado.'} @pageChange=${(e: CustomEvent<number>) => this.hoursCtrl.setPage(e.detail)} @sortChange=${(e: CustomEvent<{ sort: string; dir: 'asc' | 'desc' }>) => this.hoursCtrl.setSort(e.detail.sort, e.detail.dir)} @searchChange=${(e: CustomEvent<string>) => this.hoursCtrl.setSearch(e.detail)} @filterChange=${(e: CustomEvent<{ col: string; value: unknown }>) => this.hoursCtrl.setFilter(e.detail.col, e.detail.value)}></ok-data-table>`;
  }

  private renderSpecialDays() {
    return html`<div>
        <form class="form" @submit=${(e) => this.createSpecialDay(e)}>
          <ion-input type="date" .value=${this.sdDate} @ionInput=${(e: any) => (this.sdDate = e.target.value)}></ion-input>
          <ion-input placeholder="Nombre (p.ej. Navidad)" .value=${this.sdName} @ionInput=${(e: any) => (this.sdName = e.target.value)}></ion-input>
          <ion-select placeholder="Estado…" .value=${this.sdClosed ? 'closed' : 'open'} @ionChange=${(e: any) => (this.sdClosed = e.target.value === 'closed')}>
            <ion-select-option value="closed">Cerrado</ion-select-option>
            <ion-select-option value="open">Abierto</ion-select-option>
          </ion-select>
          <ion-button type="submit" size="small" ?disabled=${this.saving || !this.sdDate || !this.sdName}>${this.saving ? 'Guardando…' : 'Añadir día'}</ion-button>
        </form>
        <ok-data-table .serverSide=${true} .columns=${this.specialColumns} .rows=${this.specialCtrl?.rows ?? []} .total=${this.specialCtrl?.total ?? 0} .page=${this.specialCtrl?.state.page ?? 0} .pageSize=${this.specialCtrl?.state.pageSize ?? 50} .sort=${this.specialCtrl?.state.sort} .sortDir=${this.specialCtrl?.state.dir ?? 'asc'} .searchable=${true} .searchPlaceholder=${"Buscar día especial…"} .actions=${this.rowActions} @rowAction=${(e: CustomEvent) => this.onSpecialAction(e)} .emptyMessage=${this.specialCtrl?.loading ? 'Cargando…' : 'Sin días especiales.'} @pageChange=${(e: CustomEvent<number>) => this.specialCtrl.setPage(e.detail)} @sortChange=${(e: CustomEvent<{ sort: string; dir: 'asc' | 'desc' }>) => this.specialCtrl.setSort(e.detail.sort, e.detail.dir)} @searchChange=${(e: CustomEvent<string>) => this.specialCtrl.setSearch(e.detail)} @filterChange=${(e: CustomEvent<{ col: string; value: unknown }>) => this.specialCtrl.setFilter(e.detail.col, e.detail.value)}></ok-data-table>
        <h3>Overrides</h3>
        <form class="form" @submit=${(e) => this.createOverride(e)}>
          <ion-input type="date" .value=${this.ovStart} @ionInput=${(e: any) => (this.ovStart = e.target.value)}></ion-input>
          <ion-input type="date" .value=${this.ovEnd} @ionInput=${(e: any) => (this.ovEnd = e.target.value)}></ion-input>
          <ion-input placeholder="Motivo" .value=${this.ovReason} @ionInput=${(e: any) => (this.ovReason = e.target.value)}></ion-input>
          <ion-button type="submit" size="small" ?disabled=${this.saving || !this.ovStart || !this.ovEnd || !this.ovReason}>${this.saving ? 'Guardando…' : 'Añadir override'}</ion-button>
        </form>
        <ok-data-table .serverSide=${true} .columns=${this.overrideColumns} .rows=${this.overrideCtrl?.rows ?? []} .total=${this.overrideCtrl?.total ?? 0} .page=${this.overrideCtrl?.state.page ?? 0} .pageSize=${this.overrideCtrl?.state.pageSize ?? 50} .sort=${this.overrideCtrl?.state.sort} .sortDir=${this.overrideCtrl?.state.dir ?? 'asc'} .searchable=${true} .searchPlaceholder=${"Buscar override…"} .actions=${this.rowActions} @rowAction=${(e: CustomEvent) => this.onOverrideAction(e)} .emptyMessage=${this.overrideCtrl?.loading ? 'Cargando…' : 'Sin overrides.'} @pageChange=${(e: CustomEvent<number>) => this.overrideCtrl.setPage(e.detail)} @sortChange=${(e: CustomEvent<{ sort: string; dir: 'asc' | 'desc' }>) => this.overrideCtrl.setSort(e.detail.sort, e.detail.dir)} @searchChange=${(e: CustomEvent<string>) => this.overrideCtrl.setSearch(e.detail)} @filterChange=${(e: CustomEvent<{ col: string; value: unknown }>) => this.overrideCtrl.setFilter(e.detail.col, e.detail.value)}></ok-data-table>
      </div>`;
  }

  private renderSettings() {
    return html`<form class="form" @submit=${(e) => this.saveSettings(e)}>
        <ion-input placeholder="Zona horaria" .value=${this.settings.timezone} @ionInput=${(e: any) => (this.settings = { ...this.settings, timezone: e.target.value })}></ion-input>
        <ion-select placeholder="Semana empieza…" .value=${this.settings.week_starts_on} @ionChange=${(e: any) => (this.settings = { ...this.settings, week_starts_on: Number(e.target.value) })}>
          <ion-select-option .value=${1}>Lunes</ion-select-option>
          <ion-select-option .value=${7}>Domingo</ion-select-option>
        </ion-select>
        <ion-input type="number" min="5" max="120" placeholder="Duración slot (min)" .value=${this.settings.slot_duration} @ionInput=${(e: any) => (this.settings = { ...this.settings, slot_duration: Number(e.target.value) })}></ion-input>
        <label class="chk">
          <ion-checkbox ?checked=${!!this.settings.auto_close_enabled} @ionChange=${(e: any) => (this.settings = { ...this.settings, auto_close_enabled: e.target.checked ? 1 : 0 })}></ion-checkbox>
          Cierre automático
        </label>
        <ion-button type="submit" size="small" ?disabled=${this.saving}>${this.saving ? 'Guardando…' : 'Guardar'}</ion-button>
      </form>`;
  }

  render() {
    return html`<div>
        <header>
          <h2>Horarios</h2>
        </header>
        <nav>
          <button class=${this.tab === 'hours' ? 'active' : ''} @click=${() => (this.tab = 'hours')}>Horas</button>
          <button class=${this.tab === 'special_days' ? 'active' : ''} @click=${() => (this.tab = 'special_days')}>Días especiales</button>
          <button class=${this.tab === 'settings' ? 'active' : ''} @click=${() => (this.tab = 'settings')}>Ajustes</button>
        </nav>
        ${this.formError ? html`<p class="err">${this.formError}</p>` : nothing}
        ${this.hoursCtrl?.error ? html`<p class="err">${this.hoursCtrl.error}</p>` : nothing}
        ${this.specialCtrl?.error ? html`<p class="err">${this.specialCtrl.error}</p>` : nothing}
        ${this.overrideCtrl?.error ? html`<p class="err">${this.overrideCtrl.error}</p>` : nothing}
        ${this.tab === 'hours' ? this.renderHours() : nothing}
        ${this.tab === 'special_days' ? this.renderSpecialDays() : nothing}
        ${this.tab === 'settings' ? this.renderSettings() : nothing}
      </div>`;
  }
}

define('erp-schedules-hours', ErpSchedulesHours);
