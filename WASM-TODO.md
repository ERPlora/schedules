# schedules — lógica para handler Rust→WASM (Tier 2)

> **Estado 2026-06-11:** las piezas **1** (`is_open`, incl. evaluación `recurring_yearly` de la
> pieza 5), **3** (validación pre-INSERT: `set_business_hours` / `create_special_day` /
> `create_override`) y **4** (`bulk_create_special_days`) están **implementadas y compiladas**
> en `handler/src/lib.rs` → `dist/handler.wasm`. Matices vs. el plan original: las filas de
> `is_open` las pre-carga el runtime (`reads` de `schedules.*.list`, schedules#1) y se evalúan en la
> zona horaria del negocio (`context.timezone`); `already_exists` y el
> solape de overrides se validan contra **reads autoritativas** del runtime (ADR-0069:
> `special_days.by_date` / `special_days.dates` / `overrides.overlapping`, schedules#7/#2 — el
> índice único queda de backstop) y el resultado solo-lectura va en el campo extra `result` del
> Output, que el host ya devuelve al caller (hub#70). Quedan pendientes la pieza
> **2** (`is_open_at`/`get_slots`) y la **6** (sin trabajo WASM).

El CRUD plano
(horario semanal, días especiales, overrides, settings) ya está en SQL declarativo Tier 0
(`queries/*.sql`, `commands/*.sql`). Lo que sigue es lógica de cálculo, validación
multi-condición, batch y comparación de horas/fechas que **no** cabe en una sola sentencia
SQL y debe convertirse en handler WASM (`handler/src/lib.rs` → `dist/handler.wasm`).

> Regla hub: el WASM **nunca toca la BD**. Recibe el payload + los datos que el runtime
> le pasa (filas leídas vía queries declarativas) y devuelve *intenciones* (filas a
> insertar/actualizar/borrar, o un resultado de cálculo de solo-lectura) que el runtime
> valida y persiste en una transacción. Las horas se manejan como `'HH:MM'` y las fechas
> como `'YYYY-MM-DD'` (TEXT en SQLite), comparadas lexicográficamente — válido por el
> formato zero-padded.

## 1. `is_open` (command `schedules.is_open`, solo-lectura)
Origen: `ScheduleService.check_is_open`, `routes.api_is_open`, `services.is_business_hour`.
Motor de decisión "¿está abierto ahora?" con precedencia estricta de tres niveles. Dado
`when` (datetime; por defecto "ahora UTC") y el `hub_id`, el runtime lee las filas relevantes
(special_day de hoy, overrides que cubren hoy, business_hours del día de la semana) y el WASM
decide:
1. **SpecialDay** de la fecha (`date == hoy`) — máxima prioridad.
 - `is_closed=1` → cerrado, `reason = name`.
 - `is_closed=0` con `open_time`/`close_time` → abierto si `open <= ahora < close`, `reason = name`.
 - `is_closed=0` sin horas → abierto (SpecialDay presente sin horas = abierto).
2. **ScheduleOverride** que cubre hoy (`start_date <= hoy <= end_date`) — segunda prioridad.
 - misma lógica de `is_closed` / `open_time`/`close_time`, `reason = reason`.
3. **BusinessHours** del `day_of_week` (ISO 0=Monday) — horario regular.
 - aplica `is_open_at(ahora)`: cerrado si `is_closed`; abierto si `open <= ahora < close`
 **y** fuera del descanso (`break_start <= ahora < break_end` ⇒ cerrado).
4. **Sin configuración** para hoy → `is_open=false`, `reason="No hours configured"`.
 - ⚠️ **Superado por schedules#1**: el `fail_open: bool` que este plan pedía se RETIRÓ. Dejaba
 elegir la respuesta a quien preguntaba, así que el mismo hub estaba abierto para un módulo y
 cerrado para otro en el mismo instante. Hoy hay una sola respuesta —no abierto— con el código
 estable `no_hours`, que un consumidor distingue de `closed_today` y trata como quiera.
- Devolver `{is_open, code, reason, source, rule_id, intervals, timezone, today, current_time}`.

## 2. `is_open_at` / generación de slots
Origen: `BusinessHours.is_open_at` y `BusinessHours.get_slots`.
- `is_open_at(t)`: `open <= t < close` **y** no dentro de `[break_start, break_end)`.
- `get_slots(slot_duration)`: genera la lista de horas de inicio de slot desde `open` hasta
 `close` en pasos de `slot_duration` minutos, **saltando** el tramo de descanso (al entrar en
 el break, salta a `break_end`). Aritmética de minutos con corte a las 24:00. Usado por la UI
 de reservas / disponibilidad. Es bucle + aritmética → WASM (no SQL).

## 3. Validación de horas en `business_hours.set` y `special_days.create`
Origen: `ScheduleService.update_business_hours` / `create_special_day` (las guardas previas
al INSERT/UPDATE). El comando SQL Tier 0 asume payload ya validado; estas reglas deben
correr en el runtime/WASM **antes** de ejecutar el SQL:
- `business_hours.set` (cuando `is_closed=0`): `close_time > open_time`
 (error `invalid_hours`); si hay break: `break_end > break_start` (error `invalid_break`)
 **y** `break_start >= open_time` y `break_end <= close_time` (break dentro del horario).
- `special_days.create` (cuando `is_closed=0`): `open_time` y `close_time` requeridos
 (error `missing_hours`) y `close_time > open_time` (error `invalid_hours`).
- `overrides.create`: `end_date >= start_date`; si `is_closed=0`, horas coherentes.
- Unicidad: `special_days.create` falla con `already_exists` si ya hay un día especial en esa
 fecha (hoy lo cubre el índice único `uq_schedules_special_day_hub_date`, pero el mensaje de
 error de negocio lo compone el handler).

## 4. `bulk_create_special_days` (command `schedules.bulk_create_special_days`)
Origen: `ScheduleService.bulk_create_special_days`.
- Recibe `special_days: list[dict]`. Por cada item: aplicar la validación de la pieza 3,
 comprobar que no exista ya (por fecha), y emitir un `_insert` por cada uno válido.
- Es batch tolerante a fallos: acumula `errors[]` (por item, sin abortar el resto) y un
 contador `created`. Devuelve `{success:true, created:N, errors:[{date,name,error}, ...]}`.
- No cabe en SQL declarativo (N filas + recolección de errores parciales + dedupe por fecha).

## 5. `recurring_yearly` de días especiales (evaluación)
Origen: campo `SpecialDay.recurring_yearly` (declarado en el modelo, sin lógica de expansión
en el legacy todavía).
- Cuando se evalúa `is_open` (pieza 1) o se listan próximos festivos, un día especial con
 `recurring_yearly=1` debe matchear cualquier año en el mismo `MM-DD`, no solo el año exacto
 almacenado. La query `special_days.list` devuelve la fila cruda; la expansión "¿aplica este
 año?" (comparar solo mes-día cuando `recurring_yearly`) es lógica de calendario → WASM.

## 6. Settings singleton + defaults (Tier 1, menor)
Origen: `_get_settings` (get-or-create con defaults).
- `settings.get` puede devolver vacío si el hub nunca guardó settings; la UI aplica los
 defaults (`Europe/Madrid` / `week_starts_on=1` / `slot_duration=30` / `auto_close=false`).
 El `settings.save` ya hace UPSERT, así que el get-or-create explícito del legacy no es
 necesario como comando aparte. Sin trabajo WASM aquí salvo que se quiera materializar la
 fila por defecto en el primer arranque (capacidad de runtime, no WASM).
