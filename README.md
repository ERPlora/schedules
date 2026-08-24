# Módulo `schedules` — horario de apertura del NEGOCIO

Fuente de verdad de «**¿estamos abiertos?**»: horario semanal, **días especiales** (festivos, cierres,
días con horas distintas) y **overrides** por rango de fechas (horario de verano, obras). Incluye el
motor que resuelve las tres capas para un momento dado.

> ⚠️ **Es el horario del NEGOCIO, no turnos de empleados** (eso es `staff`) **ni huecos reservables**
> (eso es `appointments`). Tres calendarios para tres preguntas distintas.

> **Module id:** `schedules`. **Depende de:** nada — y nada depende de él.
> Módulo híbrido: SQL + handler WASM (5 funciones: `is_open`, `set_business_hours`,
> `create_special_day`, `create_override`, `bulk_create_special_days`).

## Documentación de usuario — [`docs/`](docs/)

Viaja **dentro** del módulo y se versiona con él: el asistente del hub (ADR-0282) la indexa por
versión instalada y cita la de TU versión, no la de la última publicada. En inglés (idioma fuente).

| Fichero | Para qué |
| ------- | -------- |
| [`docs/overview.md`](docs/overview.md) | Qué hace y qué NO hace; la precedencia de las tres capas |
| [`docs/screens.md`](docs/screens.md) | Hours / Special Days / Settings y cómo se pregunta si está abierto |
| [`docs/concepts.md`](docs/concepts.md) | Día especial (fecha) vs override (rango), `recurring_yearly` casa MM-DD, «sin configurar» = `no_hours` (lo decide el MÓDULO), el reloj es el del negocio, 0 = lunes |
| [`docs/limits.md`](docs/limits.md) | Los 8 códigos de validación, lo que sigue sin existir y permisos por acción |

## Precedencia del motor

```
SpecialDay (fecha exacta > recurring MM-DD)  →  Override (rango)  →  BusinessHours (con descanso)  →  no_hours
```

Todo se evalúa en la **zona horaria del negocio** (`context.timezone`, del core) y sobre las filas
que el runtime **pre-carga** (`reads`): el caller solo dice **cuándo**.

## Qué expone hoy

| Tipo | Nombre | Permiso |
| ---- | ------ | ------- |
| query | `schedules.business_hours.list` · `schedules.special_days.list` · `schedules.overrides.list` · `schedules.settings.get` | `view_schedule` |
| command | `schedules.business_hours.set` (WASM, upsert por día) | `change_schedule` |
| command | `schedules.special_days.create` (WASM) · `.bulk_create_special_days` (WASM, tolerante) · `schedules.overrides.create` (WASM) | `add_schedule` |
| command | `schedules.special_days.delete` · `schedules.overrides.delete` | `delete_schedule` |
| command | `schedules.settings.save` | `manage_settings` |
| command | `schedules.is_open` (WASM, solo lectura) | `view_schedule` |
| emite | `schedules.business_hours.updated`, `schedules.special_day.*`, `schedules.override.*`, `schedules.settings.saved` | — |
| escucha | — | — |

Navegación: las tres entradas (`hours`, `special_days`, `settings`) montan el **mismo**
`erp-schedules-hours`, que resuelve las pestañas internamente — este módulo **no** usa el bloque
`settings` declarativo de ADR-0082.

## Layout

```text
module.json                   # manifest (contrato técnico)
migrations/postgres/          # esquema §2.5; horas TEXT 'HH:MM', fechas TEXT ISO (ADR-0007)
queries/*.sql                 # lecturas declarativas (:hub_id inyectado)
commands/*.sql                # escrituras declarativas (las `_` son intenciones del WASM)
schemas/*.json                # JSON Schemas de input (draft 2020-12)
handler/                      # WASM Tier 2 → dist/handler.wasm
ui/                           # Web Components (Lit/Ionic/OutfitKit)
docs/                         # documentación de usuario + corpus del asistente
```

## Estado y trabajo abierto

El estado vive en las **Issues de este repo**, no aquí. `schedules.is_open` es autoritativo de
punta a punta (schedules#1): el runtime **pre-carga** las cuatro listas (`reads`, ADR-0069), evalúa
en la **zona horaria del negocio** (`context.timezone`, hub#731/hub#1022) y devuelve el veredicto
por el canal `result` (hub#70). El caller solo dice **cuándo**. Limitaciones vigentes en
`docs/limits.md`. Pendientes sin command propio: `is_open_at` puntual y generación de slots.

Doc de arquitectura: `architecture/modules/schedules.md` (cargarlo antes de tocar el módulo).
