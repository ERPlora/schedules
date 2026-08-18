//! Handler WASM (Tier 2) del módulo `schedules` — motor "¿está abierto?" y
//! validación de horas pre-INSERT (WASM-TODO.md §1/§3/§4).
//!
//! Lógica pura, sin BD: cada función recibe `{payload, context}`, valida/calcula y
//! devuelve **intenciones** (commands `_`-prefijados del propio módulo) que el host
//! valida y ejecuta en UNA transacción, más los eventos `schedules.*` a emitir.
//!
//! Restricciones del runtime actual (sin lecturas pre-cargadas):
//! * las filas que el motor `is_open` necesita (special_days / overrides /
//!   business_hours) viajan EN EL PAYLOAD — el caller las obtiene con las queries
//!   declarativas públicas del propio módulo (`schedules.*.list`) y las pasa;
//! * `already_exists` en special days se comprueba contra la read autoritativa
//!   `context.reads["schedules.special_days.by_date"]` (ADR-0069, la precarga el
//!   runtime vía `reads` del manifest — schedules#7); solo si la read falta degrada
//!   al hint del cliente `existing_dates`. El índice único
//!   `uq_schedules_special_day_hub_date` queda como backstop duro;
//! * el resultado solo-lectura (`is_open` / resumen del bulk) se serializa en el
//!   campo extra `result` del Output — el host actual lo ignora (devuelve
//!   `{ok, operations}`); cuando el runtime exponga el canal de resultado de
//!   handlers (decisión humana pendiente) ya estará emitido aquí.
//!
//! Horas como TEXT `'HH:MM'` y fechas `'YYYY-MM-DD'` (comparación lexicográfica,
//! válida por el zero-padding). Errores de negocio = `Err("codigo: detalle")` con
//! códigos `invalid_hours` / `invalid_break` / `missing_hours` / `invalid_range` /
//! `already_exists` / `invalid_day` / `invalid_date` / `missing_name`.

use erplora_guest_sdk::{Event, Operation, Output};
use serde_json::{json, Map, Value};

#[cfg(feature = "guest")]
use extism_pdk::*;

// ── Exports WASM ───────────────────────────────────────────────────────────

#[cfg(feature = "guest")]
#[plugin_fn]
pub fn is_open(input: Json<erplora_guest_sdk::Input>) -> FnResult<Json<Value>> {
    to_fn_result(is_open_pure(input.into_inner().into_value()))
}

#[cfg(feature = "guest")]
#[plugin_fn]
pub fn bulk_create_special_days(input: Json<erplora_guest_sdk::Input>) -> FnResult<Json<Value>> {
    to_fn_result(bulk_create_special_days_pure(input.into_inner().into_value()))
}

#[cfg(feature = "guest")]
#[plugin_fn]
pub fn set_business_hours(input: Json<erplora_guest_sdk::Input>) -> FnResult<Json<Value>> {
    to_fn_result(set_business_hours_pure(input.into_inner().into_value()))
}

#[cfg(feature = "guest")]
#[plugin_fn]
pub fn create_special_day(input: Json<erplora_guest_sdk::Input>) -> FnResult<Json<Value>> {
    to_fn_result(create_special_day_pure(input.into_inner().into_value()))
}

#[cfg(feature = "guest")]
#[plugin_fn]
pub fn create_override(input: Json<erplora_guest_sdk::Input>) -> FnResult<Json<Value>> {
    to_fn_result(create_override_pure(input.into_inner().into_value()))
}

#[cfg(feature = "guest")]
fn to_fn_result(r: Result<Value, String>) -> FnResult<Json<Value>> {
    match r {
        Ok(out) => Ok(Json(out)),
        Err(e) => Err(Error::msg(e).into()),
    }
}

// ── Helpers (mismo estilo que kitchen-handler) ─────────────────────────────

fn as_str(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Number(n) => n.to_string(),
        Value::Bool(b) => b.to_string(),
        _ => String::new(),
    }
}

fn as_bool(v: &Value) -> bool {
    match v {
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_i64().unwrap_or(0) != 0,
        Value::String(s) => matches!(s.as_str(), "1" | "true" | "True" | "yes"),
        _ => false,
    }
}

fn as_i64(v: &Value, d: i64) -> i64 {
    match v {
        Value::Number(n) => n.as_i64().unwrap_or_else(|| n.as_f64().map(|f| f as i64).unwrap_or(d)),
        Value::String(s) => s.trim().parse::<i64>().unwrap_or(d),
        _ => d,
    }
}

fn str_or(p: &Value, k: &str, d: &str) -> String {
    let s = as_str(p.get(k).unwrap_or(&Value::Null));
    if s.is_empty() { d.to_string() } else { s }
}

/// String opcional: '' o ausente → None.
fn opt_str(p: &Value, k: &str) -> Option<String> {
    let s = as_str(p.get(k).unwrap_or(&Value::Null));
    if s.is_empty() { None } else { Some(s) }
}

fn bool_or(p: &Value, k: &str, d: bool) -> bool {
    match p.get(k) {
        Some(Value::Null) | None => d,
        Some(v) => as_bool(v),
    }
}

/// Valida 'HH:MM' (00-23 / 00-59).
fn valid_time(s: &str) -> bool {
    let b = s.as_bytes();
    if b.len() != 5 || b[2] != b':' {
        return false;
    }
    let digits = b[0].is_ascii_digit() && b[1].is_ascii_digit() && b[3].is_ascii_digit() && b[4].is_ascii_digit();
    if !digits {
        return false;
    }
    let h = (b[0] - b'0') * 10 + (b[1] - b'0');
    let m = (b[3] - b'0') * 10 + (b[4] - b'0');
    h < 24 && m < 60
}

/// Valida 'YYYY-MM-DD' (mes 01-12, día 01-31; sin calendario fino — backstop suficiente).
fn valid_date(s: &str) -> bool {
    let b = s.as_bytes();
    if b.len() != 10 || b[4] != b'-' || b[7] != b'-' {
        return false;
    }
    if !b.iter().enumerate().all(|(i, c)| if i == 4 || i == 7 { true } else { c.is_ascii_digit() }) {
        return false;
    }
    let m: u32 = s[5..7].parse().unwrap_or(0);
    let d: u32 = s[8..10].parse().unwrap_or(0);
    (1..=12).contains(&m) && (1..=31).contains(&d)
}

/// Días desde 1970-01-01 (algoritmo civil de Howard Hinnant). Solo para weekday.
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

/// Día de la semana ISO del módulo (0=Monday .. 6=Sunday) para 'YYYY-MM-DD'.
fn weekday_iso0(date: &str) -> Option<i64> {
    if !valid_date(date) {
        return None;
    }
    let y: i64 = date[0..4].parse().ok()?;
    let m: i64 = date[5..7].parse().ok()?;
    let d: i64 = date[8..10].parse().ok()?;
    // 1970-01-01 fue jueves → índice ISO0 3.
    Some((days_from_civil(y, m, d) + 3).rem_euclid(7))
}

/// Serializa un Output estándar + campo extra `result` (el host actual lo ignora).
fn output_with_result(out: Output, result: Value) -> Value {
    let mut v = serde_json::to_value(&out).unwrap_or_else(|_| json!({}));
    if let Value::Object(map) = &mut v {
        map.insert("result".into(), result);
    }
    v
}

// ── Validación de horas (WASM-TODO §3) ─────────────────────────────────────

/// Valida el par open/close cuando el día está abierto. `close > open` estricto.
fn check_hours(open: &str, close: &str) -> Result<(), String> {
    if !valid_time(open) || !valid_time(close) {
        return Err(format!("invalid_hours: formato de hora inválido (open='{open}', close='{close}', se espera HH:MM)"));
    }
    if close <= open {
        return Err(format!("invalid_hours: close_time ({close}) debe ser posterior a open_time ({open})"));
    }
    Ok(())
}

/// Valida el descanso: `break_end > break_start` y dentro de `[open, close]`.
fn check_break(open: &str, close: &str, bs: &str, be: &str) -> Result<(), String> {
    if !valid_time(bs) || !valid_time(be) {
        return Err(format!("invalid_break: formato de hora inválido (break_start='{bs}', break_end='{be}')"));
    }
    if be <= bs {
        return Err(format!("invalid_break: break_end ({be}) debe ser posterior a break_start ({bs})"));
    }
    if bs < open || be > close {
        return Err(format!(
            "invalid_break: el descanso ({bs}–{be}) debe quedar dentro del horario ({open}–{close})"
        ));
    }
    Ok(())
}

/// Valida un item de special day (singular o bulk). Devuelve los campos normalizados.
struct SpecialDayItem {
    date: String,
    name: String,
    is_closed: bool,
    open_time: Option<String>,
    close_time: Option<String>,
    recurring_yearly: bool,
    notes: String,
}

fn validate_special_day(item: &Value) -> Result<SpecialDayItem, String> {
    let date = str_or(item, "date", "");
    if !valid_date(&date) {
        return Err(format!("invalid_date: fecha inválida '{date}' (se espera YYYY-MM-DD)"));
    }
    let name = str_or(item, "name", "");
    if name.trim().is_empty() {
        return Err("missing_name: el día especial requiere un nombre".to_string());
    }
    let is_closed = bool_or(item, "is_closed", true);
    let open_time = opt_str(item, "open_time");
    let close_time = opt_str(item, "close_time");
    if !is_closed {
        match (&open_time, &close_time) {
            (Some(o), Some(c)) => check_hours(o, c)?,
            _ => {
                return Err("missing_hours: un día especial abierto (is_closed=0) requiere open_time y close_time".to_string());
            }
        }
    }
    Ok(SpecialDayItem {
        date,
        name: name.trim().to_string(),
        is_closed,
        open_time,
        close_time,
        recurring_yearly: bool_or(item, "recurring_yearly", false),
        notes: str_or(item, "notes", ""),
    })
}

fn special_day_params(it: &SpecialDayItem) -> Map<String, Value> {
    let mut p = Map::new();
    p.insert("date".into(), json!(it.date));
    p.insert("name".into(), json!(it.name));
    p.insert("is_closed".into(), json!(it.is_closed as i64));
    p.insert("open_time".into(), it.open_time.clone().map(Value::String).unwrap_or(Value::Null));
    p.insert("close_time".into(), it.close_time.clone().map(Value::String).unwrap_or(Value::Null));
    p.insert("recurring_yearly".into(), json!(it.recurring_yearly as i64));
    p.insert("notes".into(), json!(it.notes));
    p
}

fn special_day_event(it: &SpecialDayItem) -> Event {
    Event::new(
        "schedules.special_day.created",
        json!({
            "sender": "schedules",
            "date": it.date,
            "name": it.name,
            "is_closed": it.is_closed as i64,
            "recurring_yearly": it.recurring_yearly as i64,
        }),
    )
}

/// Dates already taken by a special day of this hub (client hint `existing_dates`, optional).
fn existing_dates(payload: &Value) -> Vec<String> {
    payload
        .get("existing_dates")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().map(as_str).filter(|s| !s.is_empty()).collect())
        .unwrap_or_default()
}

/// Query pre-loaded by the runtime (`reads` in the manifest, ADR-0069) with the live special
/// day(s) on `payload.date`. Server-authoritative: the browser cannot forge it.
const SPECIAL_DAY_BY_DATE_READ: &str = "schedules.special_days.by_date";

/// Whether a special day already exists on `date`. Prefers the authoritative read
/// (`context.reads["schedules.special_days.by_date"]`, present even when empty); only when the
/// read is absent (old manifest / query failed) it degrades to the client hint `existing_dates`.
fn special_day_exists(input: &Value, payload: &Value, date: &str) -> bool {
    let read_rows = input
        .get("context")
        .and_then(|c| c.get("reads"))
        .and_then(|r| r.get(SPECIAL_DAY_BY_DATE_READ))
        .and_then(|v| v.as_array());
    match read_rows {
        Some(rows) => rows.iter().any(|r| str_or(r, "date", "") == date),
        None => existing_dates(payload).contains(&date.to_string()),
    }
}

// ── schedules.business_hours.set (fn set_business_hours) ──────────────────

/// Upsert validado del horario de un día de la semana (WASM-TODO §3).
pub fn set_business_hours_pure(input: Value) -> Result<Value, String> {
    let payload = input.get("payload").cloned().unwrap_or(Value::Null);

    let dow = as_i64(payload.get("day_of_week").unwrap_or(&Value::Null), -1);
    if !(0..=6).contains(&dow) {
        return Err(format!("invalid_day: day_of_week debe estar entre 0 (lunes) y 6 (domingo), llegó {dow}"));
    }
    let is_closed = bool_or(&payload, "is_closed", false);
    // Defaults del JSON Schema (el runtime no aplica defaults de schema).
    let open_time = opt_str(&payload, "open_time").unwrap_or_else(|| "09:00".to_string());
    let close_time = opt_str(&payload, "close_time").unwrap_or_else(|| "18:00".to_string());
    let break_start = opt_str(&payload, "break_start");
    let break_end = opt_str(&payload, "break_end");

    if !is_closed {
        check_hours(&open_time, &close_time)?;
        match (&break_start, &break_end) {
            (None, None) => {}
            (Some(bs), Some(be)) => check_break(&open_time, &close_time, bs, be)?,
            _ => {
                return Err("invalid_break: el descanso requiere break_start y break_end (o ninguno)".to_string());
            }
        }
    }

    let mut p = Map::new();
    p.insert("day_of_week".into(), json!(dow));
    p.insert("open_time".into(), json!(open_time));
    p.insert("close_time".into(), json!(close_time));
    p.insert("is_closed".into(), json!(is_closed as i64));
    // Si el día queda cerrado, el descanso no aplica.
    let (bs, be) = if is_closed { (None, None) } else { (break_start, break_end) };
    p.insert("break_start".into(), bs.map(Value::String).unwrap_or(Value::Null));
    p.insert("break_end".into(), be.map(Value::String).unwrap_or(Value::Null));

    let out = Output::new()
        .with_operation(Operation::sql("schedules._set_business_hours", p))
        .with_event(Event::new(
            "schedules.business_hours.updated",
            json!({
                "sender": "schedules",
                "day_of_week": dow,
                "open_time": open_time,
                "close_time": close_time,
                "is_closed": is_closed as i64,
            }),
        ));
    serde_json::to_value(&out).map_err(|e| e.to_string())
}

// ── schedules.special_days.create (fn create_special_day) ─────────────────

/// Alta validada de un día especial (WASM-TODO §3). `already_exists` se comprueba
/// contra `existing_dates` (si el caller las pasa); el índice único es el backstop.
pub fn create_special_day_pure(input: Value) -> Result<Value, String> {
    let payload = input.get("payload").cloned().unwrap_or(Value::Null);
    let item = validate_special_day(&payload)?;
    if special_day_exists(&input, &payload, &item.date) {
        return Err(format!("already_exists: ya existe un día especial en la fecha {}", item.date));
    }
    let out = Output::new()
        .with_operation(Operation::sql("schedules._insert_special_day", special_day_params(&item)))
        .with_event(special_day_event(&item));
    serde_json::to_value(&out).map_err(|e| e.to_string())
}

// ── schedules.overrides.create (fn create_override) ───────────────────────

/// Validated schedule override (WASM-TODO §3): `end_date >= start_date` and, when the
/// override is open (`is_closed=0`), BOTH hours are required with `close > open`
/// (schedules#7: an open override without hours used to be read as "open 24h").
pub fn create_override_pure(input: Value) -> Result<Value, String> {
    let payload = input.get("payload").cloned().unwrap_or(Value::Null);

    let start_date = str_or(&payload, "start_date", "");
    let end_date = str_or(&payload, "end_date", "");
    if !valid_date(&start_date) || !valid_date(&end_date) {
        return Err(format!(
            "invalid_date: fechas inválidas (start='{start_date}', end='{end_date}', se espera YYYY-MM-DD)"
        ));
    }
    if end_date < start_date {
        return Err(format!("invalid_range: end_date ({end_date}) debe ser igual o posterior a start_date ({start_date})"));
    }
    let reason = str_or(&payload, "reason", "");
    if reason.trim().is_empty() {
        return Err("missing_name: el override requiere un motivo (reason)".to_string());
    }
    let is_closed = bool_or(&payload, "is_closed", false);
    let open_time = opt_str(&payload, "open_time");
    let close_time = opt_str(&payload, "close_time");
    if !is_closed {
        match (&open_time, &close_time) {
            (Some(o), Some(c)) => check_hours(o, c)?,
            _ => {
                return Err("missing_hours: an open override (is_closed=0) requires open_time and close_time".to_string());
            }
        }
    }
    // A closed override never carries hours (no contradictory payloads reach the row).
    let (open_time, close_time) = if is_closed { (None, None) } else { (open_time, close_time) };

    let mut p = Map::new();
    p.insert("start_date".into(), json!(start_date));
    p.insert("end_date".into(), json!(end_date));
    p.insert("reason".into(), json!(reason.trim()));
    p.insert("open_time".into(), open_time.clone().map(Value::String).unwrap_or(Value::Null));
    p.insert("close_time".into(), close_time.clone().map(Value::String).unwrap_or(Value::Null));
    p.insert("is_closed".into(), json!(is_closed as i64));

    let out = Output::new()
        .with_operation(Operation::sql("schedules._insert_override", p))
        .with_event(Event::new(
            "schedules.override.created",
            json!({
                "sender": "schedules",
                "start_date": start_date,
                "end_date": end_date,
                "reason": reason.trim(),
                "is_closed": is_closed as i64,
            }),
        ));
    serde_json::to_value(&out).map_err(|e| e.to_string())
}

// ── schedules.bulk_create_special_days (fn bulk_create_special_days) ──────

/// Alta en lote tolerante a fallos (WASM-TODO §4): valida cada item, dedupe por
/// fecha (dentro del lote y contra `existing_dates`), acumula `errors[]` sin
/// abortar el resto y emite un `_insert` (ON CONFLICT DO NOTHING) por item válido.
pub fn bulk_create_special_days_pure(input: Value) -> Result<Value, String> {
    let payload = input.get("payload").cloned().unwrap_or(Value::Null);
    let empty: Vec<Value> = Vec::new();
    let items = payload.get("special_days").and_then(|v| v.as_array()).unwrap_or(&empty);
    if items.is_empty() {
        return Err("missing_items: special_days debe ser una lista no vacía".to_string());
    }

    let existing = existing_dates(&payload);
    let mut seen: Vec<String> = Vec::new();
    let mut out = Output::new();
    let mut errors: Vec<Value> = Vec::new();
    let mut created = 0usize;

    for item in items {
        let date = str_or(item, "date", "");
        let name = str_or(item, "name", "");
        match validate_special_day(item) {
            Err(e) => errors.push(json!({ "date": date, "name": name, "error": e })),
            Ok(it) => {
                if existing.contains(&it.date) {
                    errors.push(json!({
                        "date": it.date, "name": it.name,
                        "error": format!("already_exists: ya existe un día especial en la fecha {}", it.date),
                    }));
                } else if seen.contains(&it.date) {
                    errors.push(json!({
                        "date": it.date, "name": it.name,
                        "error": format!("already_exists: fecha {} duplicada dentro del lote", it.date),
                    }));
                } else {
                    seen.push(it.date.clone());
                    out = out
                        .with_operation(Operation::sql("schedules._insert_special_day_skip", special_day_params(&it)))
                        .with_event(special_day_event(&it));
                    created += 1;
                }
            }
        }
    }

    let result = json!({ "success": true, "created": created, "errors": errors });
    Ok(output_with_result(out, result))
}

// ── schedules.is_open (fn is_open, solo-lectura) ───────────────────────────

/// Decide si está abierto en `[open, close)` aplicando el descanso `[bs, be)`.
fn open_in_window(t: &str, open: &str, close: &str, bs: Option<&str>, be: Option<&str>) -> bool {
    if t < open || t >= close {
        return false;
    }
    if let (Some(bs), Some(be)) = (bs, be) {
        if t >= bs && t < be {
            return false;
        }
    }
    true
}

/// Motor "¿está abierto ahora?" (WASM-TODO §1). Precedencia estricta:
/// SpecialDay (fecha exacta o `recurring_yearly` por MM-DD) → ScheduleOverride
/// (rango que cubre hoy) → BusinessHours (día de la semana, con descanso) →
/// sin configuración (`fail_open` decide). Solo-lectura: no emite intenciones;
/// el resultado va en el campo extra `result` del Output.
pub fn is_open_pure(input: Value) -> Result<Value, String> {
    let payload = input.get("payload").cloned().unwrap_or(Value::Null);
    let context = input.get("context").cloned().unwrap_or(Value::Null);
    let empty: Vec<Value> = Vec::new();

    // `when` opcional ('YYYY-MM-DDTHH:MM[…]'); por defecto context.now (RFC3339 UTC).
    let when = opt_str(&payload, "when").unwrap_or_else(|| context.get("now").map(as_str).unwrap_or_default());
    if when.len() < 16 {
        return Err(format!("invalid_date: 'when' inválido ('{when}', se espera YYYY-MM-DDTHH:MM)"));
    }
    let today = when[..10].to_string();
    let current_time = when[11..16].to_string();
    if !valid_date(&today) || !valid_time(&current_time) {
        return Err(format!("invalid_date: 'when' inválido ('{when}', se espera YYYY-MM-DDTHH:MM)"));
    }
    let fail_open = bool_or(&payload, "fail_open", false);

    let special_days = payload.get("special_days").and_then(|v| v.as_array()).unwrap_or(&empty);
    let overrides = payload.get("overrides").and_then(|v| v.as_array()).unwrap_or(&empty);
    let business_hours = payload.get("business_hours").and_then(|v| v.as_array()).unwrap_or(&empty);

    let t = current_time.as_str();
    let done = |is_open: bool, reason: String| -> Result<Value, String> {
        Ok(output_with_result(
            Output::new(),
            json!({ "is_open": is_open, "reason": reason, "today": today, "current_time": current_time }),
        ))
    };

    // 1) SpecialDay: fecha exacta tiene prioridad sobre recurrente (MM-DD).
    let exact = special_days.iter().find(|r| str_or(r, "date", "") == today);
    let recurring = special_days.iter().find(|r| {
        let d = str_or(r, "date", "");
        bool_or(r, "recurring_yearly", false) && d.len() == 10 && d[5..] == today[5..]
    });
    if let Some(sd) = exact.or(recurring) {
        let name = str_or(sd, "name", "Special day");
        if bool_or(sd, "is_closed", true) {
            return done(false, name);
        }
        return match (opt_str(sd, "open_time"), opt_str(sd, "close_time")) {
            (Some(o), Some(c)) => done(t >= o.as_str() && t < c.as_str(), name),
            // SpecialDay abierto sin horas = abierto todo el día.
            _ => done(true, name),
        };
    }

    // 2) ScheduleOverride que cubre hoy (start_date <= hoy <= end_date).
    if let Some(ov) = overrides.iter().find(|r| {
        let s = str_or(r, "start_date", "");
        let e = str_or(r, "end_date", "");
        !s.is_empty() && !e.is_empty() && s.as_str() <= today.as_str() && today.as_str() <= e.as_str()
    }) {
        let reason = str_or(ov, "reason", "Schedule override");
        if bool_or(ov, "is_closed", false) {
            return done(false, reason);
        }
        return match (opt_str(ov, "open_time"), opt_str(ov, "close_time")) {
            (Some(o), Some(c)) => done(t >= o.as_str() && t < c.as_str(), reason),
            _ => done(true, reason),
        };
    }

    // 3) BusinessHours del día de la semana (ISO 0=Monday), con descanso.
    let dow = weekday_iso0(&today).ok_or_else(|| format!("invalid_date: fecha inválida '{today}'"))?;
    if let Some(bh) = business_hours
        .iter()
        .find(|r| as_i64(r.get("day_of_week").unwrap_or(&Value::Null), -1) == dow)
    {
        if bool_or(bh, "is_closed", false) {
            return done(false, "Closed today".to_string());
        }
        let open = str_or(bh, "open_time", "00:00");
        let close = str_or(bh, "close_time", "00:00");
        let bs = opt_str(bh, "break_start");
        let be = opt_str(bh, "break_end");
        let is_open = open_in_window(t, &open, &close, bs.as_deref(), be.as_deref());
        let reason = if is_open {
            format!("Open ({open}–{close})")
        } else if bs.as_deref().is_some_and(|b| t >= b) && be.as_deref().is_some_and(|b| t < b) {
            "On break".to_string()
        } else {
            format!("Outside business hours ({open}–{close})")
        };
        return done(is_open, reason);
    }

    // 4) Sin configuración para hoy: fail-open (contrato cross-módulo) o fail-closed (dashboard).
    if fail_open {
        done(true, "No hours configured (fail-open)".to_string())
    } else {
        done(false, "No hours configured".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(payload: Value) -> Value {
        json!({ "payload": payload, "context": { "hub_id": "h1", "now": "2026-08-18T10:00:00Z" } })
    }

    fn input_with_reads(payload: Value, reads: Value) -> Value {
        json!({ "payload": payload, "context": { "hub_id": "h1", "now": "2026-08-18T10:00:00Z", "reads": reads } })
    }

    fn err_code(r: Result<Value, String>) -> String {
        let e = r.expect_err("expected a business error");
        e.split(':').next().unwrap_or("").to_string()
    }

    // ── schedules#7: special day duplicate check is server-authoritative (reads) ──

    #[test]
    fn special_day_create_rejects_duplicate_from_authoritative_read() {
        let payload = json!({ "date": "2026-12-25", "name": "Christmas", "is_closed": true });
        let reads = json!({ "schedules.special_days.by_date": [ { "id": "s1", "date": "2026-12-25" } ] });
        assert_eq!(err_code(create_special_day_pure(input_with_reads(payload, reads))), "already_exists");
    }

    #[test]
    fn special_day_create_accepts_when_read_is_empty_even_if_client_hints_otherwise() {
        // The client hint (`existing_dates`) is ignored once the authoritative read is present.
        let payload = json!({ "date": "2026-12-25", "name": "Christmas", "is_closed": true, "existing_dates": ["2026-12-25"] });
        let reads = json!({ "schedules.special_days.by_date": [] });
        let out = create_special_day_pure(input_with_reads(payload, reads)).expect("ok");
        assert_eq!(out["operations"][0]["command"], "schedules._insert_special_day");
    }

    #[test]
    fn special_day_create_exact_ui_payload_is_accepted() {
        // Payload the UI sends after schedules#7: no `existing_dates`, hours when open.
        let payload = json!({
            "date": "2026-12-24", "name": "Christmas Eve", "is_closed": false,
            "open_time": "09:00", "close_time": "14:00", "recurring_yearly": true, "notes": "half day"
        });
        let out = create_special_day_pure(input_with_reads(payload, json!({ "schedules.special_days.by_date": [] }))).expect("ok");
        let params = &out["operations"][0]["params"];
        assert_eq!(params["open_time"], "09:00");
        assert_eq!(params["recurring_yearly"], 1);
        assert_eq!(params["notes"], "half day");
    }

    // ── schedules#7: an open override needs hours (no silent "open 24h") ──

    #[test]
    fn override_create_open_without_hours_is_missing_hours() {
        let payload = json!({ "start_date": "2026-08-01", "end_date": "2026-08-15", "reason": "Summer", "is_closed": false });
        assert_eq!(err_code(create_override_pure(input(payload))), "missing_hours");
    }

    #[test]
    fn override_create_closed_without_hours_is_ok() {
        let payload = json!({ "start_date": "2026-08-01", "end_date": "2026-08-15", "reason": "Holidays", "is_closed": true });
        let out = create_override_pure(input(payload)).expect("ok");
        assert_eq!(out["operations"][0]["params"]["is_closed"], 1);
        assert!(out["operations"][0]["params"]["open_time"].is_null());
    }

    #[test]
    fn override_create_open_with_hours_is_ok() {
        let payload = json!({ "start_date": "2026-08-01", "end_date": "2026-08-15", "reason": "Summer", "is_closed": false, "open_time": "10:00", "close_time": "14:00" });
        let out = create_override_pure(input(payload)).expect("ok");
        assert_eq!(out["operations"][0]["params"]["open_time"], "10:00");
    }
}
