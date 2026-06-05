import { Component, State, h } from '@stencil/core';
// Importa el DataTable compartido (Stencil) para que se auto-registre y esbuild
// lo empaquete dentro del bundle del módulo. El shell provee los `ion-*`.
import '../../../../_shared/ui/components/data-table/data-table';
import type { DataTableColumn } from '../../../../_shared/ui/components/data-table/data-table';

// Web Component del módulo `schedules` (Stencil). Mini-app: horario semanal de negocio,
// días especiales (festivos/cierres) y overrides temporales, más settings por hub.
// Es la pieza `ui.entry` que el shell carga en runtime (modules/schedules/dist/schedules.esm.js).
//
// El motor de cálculo "is_open" y el alta en lote viven en WASM (ver WASM-TODO.md): este
// componente NO toca la BD; solo llama al SDK (erplora.query/command/on).

interface ErploraClientLike {
  query<T = unknown>(name: string, params?: Record<string, unknown>): Promise<T>;
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

type Tab = 'hours' | 'special_days' | 'settings';

function erplora(): ErploraClientLike {
  const c = (globalThis as { erplora?: ErploraClientLike }).erplora;
  if (!c) throw new Error('erplora SDK no inicializado por el shell');
  return c;
}

@Component({
  tag: 'erp-schedules-hours',
  shadow: true,
  styles: `
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
  `,
})
export class ErpSchedulesHours {
  @State() tab: Tab = 'hours';
  @State() hours: BusinessHours[] = [];
  @State() specialDays: SpecialDay[] = [];
  @State() overrides: ScheduleOverride[] = [];
  @State() settings: { timezone: string; week_starts_on: number; slot_duration: number; auto_close_enabled: number } = {
    timezone: 'Europe/Madrid',
    week_starts_on: 1,
    slot_duration: 30,
    auto_close_enabled: 0,
  };
  @State() loading = true;
  @State() error = '';
  @State() saving = false;

  // alta de día especial
  @State() sdDate = '';
  @State() sdName = '';
  @State() sdClosed = true;

  // alta de override
  @State() ovStart = '';
  @State() ovEnd = '';
  @State() ovReason = '';

  private unsub?: () => void;

  private hoursColumns: DataTableColumn[] = [
    { key: 'day_of_week', header: 'Día', format: (r) => DAY_NAMES[r.day_of_week as number] ?? String(r.day_of_week) },
    { key: 'open_time', header: 'Abre', format: (r) => ((r.is_closed as number) ? 'Cerrado' : (r.open_time as string)) },
    { key: 'close_time', header: 'Cierra', format: (r) => ((r.is_closed as number) ? '—' : (r.close_time as string)) },
    { key: 'break_start', header: 'Descanso', format: (r) => (r.break_start ? `${r.break_start}–${r.break_end ?? ''}` : '—') },
  ];

  private specialColumns: DataTableColumn[] = [
    { key: 'date', header: 'Fecha' },
    { key: 'name', header: 'Nombre' },
    { key: 'is_closed', header: 'Estado', format: (r) => ((r.is_closed as number) ? 'Cerrado' : `${r.open_time ?? ''}–${r.close_time ?? ''}`) },
    { key: 'recurring_yearly', header: 'Anual', format: (r) => ((r.recurring_yearly as number) ? 'Sí' : 'No') },
  ];

  private overrideColumns: DataTableColumn[] = [
    { key: 'start_date', header: 'Desde' },
    { key: 'end_date', header: 'Hasta' },
    { key: 'reason', header: 'Motivo' },
    { key: 'is_closed', header: 'Estado', format: (r) => ((r.is_closed as number) ? 'Cerrado' : `${r.open_time ?? ''}–${r.close_time ?? ''}`) },
  ];

  private rowActions = [{ id: 'delete', label: 'Eliminar', icon: 'trash-outline', color: 'danger' }];

  async componentWillLoad() {
    await this.refresh();
    try {
      const offs = [
        'schedules.business_hours.updated',
        'schedules.special_day.created',
        'schedules.special_day.deleted',
        'schedules.override.created',
        'schedules.override.deleted',
        'schedules.settings.saved',
      ].map((ev) => erplora().on(ev, () => this.refresh()));
      this.unsub = () => offs.forEach((o) => o());
    } catch {
      /* sin SDK (preview) → sin reactividad en vivo */
    }
  }

  disconnectedCallback() {
    this.unsub?.();
  }

  private async refresh() {
    this.loading = true;
    this.error = '';
    try {
      const [hours, special, overrides, settings] = await Promise.all([
        erplora().query<BusinessHours[]>('schedules.business_hours.list'),
        erplora().query<SpecialDay[]>('schedules.special_days.list'),
        erplora().query<ScheduleOverride[]>('schedules.overrides.list'),
        erplora().query<typeof this.settings | null>('schedules.settings.get'),
      ]);
      this.hours = hours ?? [];
      this.specialDays = special ?? [];
      this.overrides = overrides ?? [];
      if (settings) this.settings = settings;
    } catch (e) {
      this.error = e instanceof Error ? e.message : 'Error cargando horarios';
    } finally {
      this.loading = false;
    }
  }

  private async createSpecialDay(ev: Event) {
    ev.preventDefault();
    if (!this.sdDate || !this.sdName.trim()) return;
    this.saving = true;
    this.error = '';
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
      await this.refresh();
    } catch (e) {
      this.error = e instanceof Error ? e.message : 'No se pudo crear el día especial';
    } finally {
      this.saving = false;
    }
  }

  private async createOverride(ev: Event) {
    ev.preventDefault();
    if (!this.ovStart || !this.ovEnd || !this.ovReason.trim()) return;
    this.saving = true;
    this.error = '';
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
      await this.refresh();
    } catch (e) {
      this.error = e instanceof Error ? e.message : 'No se pudo crear el override';
    } finally {
      this.saving = false;
    }
  }

  private async saveSettings(ev: Event) {
    ev.preventDefault();
    this.saving = true;
    this.error = '';
    try {
      await erplora().command('schedules.settings.save', {
        timezone: this.settings.timezone,
        week_starts_on: Number(this.settings.week_starts_on),
        slot_duration: Number(this.settings.slot_duration),
        auto_close_enabled: !!this.settings.auto_close_enabled,
      });
      await this.refresh();
    } catch (e) {
      this.error = e instanceof Error ? e.message : 'No se pudieron guardar los ajustes';
    } finally {
      this.saving = false;
    }
  }

  private async onSpecialAction(ev: CustomEvent<{ actionId: string; row: Record<string, unknown> }>) {
    if (ev.detail.actionId !== 'delete') return;
    try {
      await erplora().command('schedules.special_days.delete', { special_day_id: ev.detail.row.id });
      await this.refresh();
    } catch (e) {
      this.error = e instanceof Error ? e.message : 'No se pudo eliminar';
    }
  }

  private async onOverrideAction(ev: CustomEvent<{ actionId: string; row: Record<string, unknown> }>) {
    if (ev.detail.actionId !== 'delete') return;
    try {
      await erplora().command('schedules.overrides.delete', { override_id: ev.detail.row.id });
      await this.refresh();
    } catch (e) {
      this.error = e instanceof Error ? e.message : 'No se pudo eliminar';
    }
  }

  private renderHours() {
    return (
      <data-table
        columns={this.hoursColumns}
        rows={this.hours as unknown as Record<string, unknown>[]}
        searchKeys={[]}
        emptyMessage={this.loading ? 'Cargando…' : 'Sin horario configurado.'}
      />
    );
  }

  private renderSpecialDays() {
    return (
      <div>
        <form class="form" onSubmit={(e) => this.createSpecialDay(e)}>
          <ion-input
            type="date"
            value={this.sdDate}
            onIonInput={(e: any) => (this.sdDate = e.target.value)}
          />
          <ion-input
            placeholder="Nombre (p.ej. Navidad)"
            value={this.sdName}
            onIonInput={(e: any) => (this.sdName = e.target.value)}
          />
          <ion-select
            placeholder="Estado…"
            value={this.sdClosed ? 'closed' : 'open'}
            onIonChange={(e: any) => (this.sdClosed = e.target.value === 'closed')}
          >
            <ion-select-option value="closed">Cerrado</ion-select-option>
            <ion-select-option value="open">Abierto</ion-select-option>
          </ion-select>
          <ion-button type="submit" size="small" disabled={this.saving || !this.sdDate || !this.sdName}>
            {this.saving ? 'Guardando…' : 'Añadir día'}
          </ion-button>
        </form>

        <data-table
          columns={this.specialColumns}
          rows={this.specialDays as unknown as Record<string, unknown>[]}
          searchKeys={['name', 'date']}
          searchPlaceholder="Buscar día especial…"
          actions={this.rowActions}
          onRowAction={(e: CustomEvent) => this.onSpecialAction(e)}
          emptyMessage={this.loading ? 'Cargando…' : 'Sin días especiales.'}
        />

        <h3>Overrides</h3>
        <form class="form" onSubmit={(e) => this.createOverride(e)}>
          <ion-input type="date" value={this.ovStart} onIonInput={(e: any) => (this.ovStart = e.target.value)} />
          <ion-input type="date" value={this.ovEnd} onIonInput={(e: any) => (this.ovEnd = e.target.value)} />
          <ion-input
            placeholder="Motivo"
            value={this.ovReason}
            onIonInput={(e: any) => (this.ovReason = e.target.value)}
          />
          <ion-button type="submit" size="small" disabled={this.saving || !this.ovStart || !this.ovEnd || !this.ovReason}>
            {this.saving ? 'Guardando…' : 'Añadir override'}
          </ion-button>
        </form>

        <data-table
          columns={this.overrideColumns}
          rows={this.overrides as unknown as Record<string, unknown>[]}
          searchKeys={['reason']}
          searchPlaceholder="Buscar override…"
          actions={this.rowActions}
          onRowAction={(e: CustomEvent) => this.onOverrideAction(e)}
          emptyMessage={this.loading ? 'Cargando…' : 'Sin overrides.'}
        />
      </div>
    );
  }

  private renderSettings() {
    return (
      <form class="form" onSubmit={(e) => this.saveSettings(e)}>
        <ion-input
          placeholder="Zona horaria"
          value={this.settings.timezone}
          onIonInput={(e: any) => (this.settings = { ...this.settings, timezone: e.target.value })}
        />
        <ion-select
          placeholder="Semana empieza…"
          value={this.settings.week_starts_on}
          onIonChange={(e: any) => (this.settings = { ...this.settings, week_starts_on: Number(e.target.value) })}
        >
          <ion-select-option value={1}>Lunes</ion-select-option>
          <ion-select-option value={7}>Domingo</ion-select-option>
        </ion-select>
        <ion-input
          type="number"
          min="5"
          max="120"
          placeholder="Duración slot (min)"
          value={this.settings.slot_duration}
          onIonInput={(e: any) => (this.settings = { ...this.settings, slot_duration: Number(e.target.value) })}
        />
        <label class="chk">
          <ion-checkbox
            checked={!!this.settings.auto_close_enabled}
            onIonChange={(e: any) => (this.settings = { ...this.settings, auto_close_enabled: e.target.checked ? 1 : 0 })}
          />
          Cierre automático
        </label>
        <ion-button type="submit" size="small" disabled={this.saving}>
          {this.saving ? 'Guardando…' : 'Guardar'}
        </ion-button>
      </form>
    );
  }

  render() {
    return (
      <div>
        <header>
          <h2>Horarios</h2>
        </header>

        <nav>
          <button class={this.tab === 'hours' ? 'active' : ''} onClick={() => (this.tab = 'hours')}>
            Horas
          </button>
          <button class={this.tab === 'special_days' ? 'active' : ''} onClick={() => (this.tab = 'special_days')}>
            Días especiales
          </button>
          <button class={this.tab === 'settings' ? 'active' : ''} onClick={() => (this.tab = 'settings')}>
            Ajustes
          </button>
        </nav>

        {this.error && <p class="err">{this.error}</p>}

        {this.tab === 'hours' && this.renderHours()}
        {this.tab === 'special_days' && this.renderSpecialDays()}
        {this.tab === 'settings' && this.renderSettings()}
      </div>
    );
  }
}
