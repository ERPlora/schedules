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
//! * el resultado solo-lectura (`is_open` / resumen del bulk) viaja por el **canal
//!   `result` del Output** (hub#70): no es una operación ni un evento, no se
//!   persiste y el host lo devuelve al llamante tal cual (con tope de tamaño). Es
//!   la única vía por la que un veredicto es AUTORITATIVO — calcularlo en el
//!   cliente sobre filas que el propio cliente aporta lo haría falsificable.
//!
//! Horas como TEXT `'HH:MM'` y fechas `'YYYY-MM-DD'` (comparación lexicográfica,
//! válida por el zero-padding). Errores de negocio = `Err("codigo: detalle")` con
//! códigos `invalid_hours` / `invalid_break` / `missing_hours` / `invalid_range` /
//! `already_exists` / `invalid_day` / `invalid_date` / `missing_name` / `overlapping`.

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

/// Proleptic Gregorian leap year (4 / 100 / 400 rule).
fn is_leap_year(y: u32) -> bool {
    (y % 4 == 0 && y % 100 != 0) || y % 400 == 0
}

/// Days in `month` of `year` (1..=12).
fn days_in_month(y: u32, m: u32) -> u32 {
    match m {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 => if is_leap_year(y) { 29 } else { 28 },
        _ => 0,
    }
}

/// Validates 'YYYY-MM-DD' against the real calendar (month 01-12, day within the month,
/// leap years included — schedules#2: `2026-02-31` used to pass and get persisted).
fn valid_date(s: &str) -> bool {
    let b = s.as_bytes();
    if b.len() != 10 || b[4] != b'-' || b[7] != b'-' {
        return false;
    }
    if !b.iter().enumerate().all(|(i, c)| if i == 4 || i == 7 { true } else { c.is_ascii_digit() }) {
        return false;
    }
    let y: u32 = s[0..4].parse().unwrap_or(0);
    let m: u32 = s[5..7].parse().unwrap_or(0);
    let d: u32 = s[8..10].parse().unwrap_or(0);
    (1..=12).contains(&m) && d >= 1 && d <= days_in_month(y, m)
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

/// Serializa un Output con su veredicto en el canal `result` del contrato (hub#70).
fn output_with_result(out: Output, result: Value) -> Value {
    serde_json::to_value(out.with_result(result)).unwrap_or_else(|_| json!({}))
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
    /// Opening intervals of the exception (schedules#23). Empty when the day is closed.
    intervals: Vec<Interval>,
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
    let mut open_time = opt_str(item, "open_time");
    let mut close_time = opt_str(item, "close_time");
    let mut intervals: Vec<Interval> = Vec::new();
    if !is_closed {
        intervals = exception_intervals_from_payload(item)?;
        if intervals.is_empty() {
            return Err("missing_hours: un día especial abierto (is_closed=0) requiere open_time y close_time".to_string());
        }
        // The pair on the parent row mirrors the FIRST interval: a reader that predates migration
        // 003 sees a real opening slot of this day, never one wider than the truth.
        open_time = Some(intervals[0].open.clone());
        close_time = Some(intervals[0].close.clone());
    }
    Ok(SpecialDayItem {
        date,
        name: name.trim().to_string(),
        is_closed,
        open_time,
        close_time,
        recurring_yearly: bool_or(item, "recurring_yearly", false),
        notes: str_or(item, "notes", ""),
        intervals,
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
            "intervals": intervals_json(&it.intervals),
        }),
    )
}

/// The intervals as the listeners of a `schedules.*.created` event see them (schedules#23).
fn intervals_json(intervals: &[Interval]) -> Vec<Value> {
    intervals.iter().map(|i| json!({ "open_time": i.open, "close_time": i.close })).collect()
}

/// Params of `schedules._insert_exception_interval` — one opening interval of an exception
/// (`special_day` / `override`). The parent id comes from the SAME `context.new_ids` batch, so
/// parent and children are written in one transaction without the guest inventing an id.
fn exception_interval_params(
    id: Value,
    kind: &str,
    exception_id: &Value,
    position: usize,
    it: &Interval,
) -> Map<String, Value> {
    let mut p = Map::new();
    p.insert("id".into(), id);
    p.insert("exception_kind".into(), json!(kind));
    p.insert("exception_id".into(), exception_id.clone());
    p.insert("position".into(), json!(position as i64));
    p.insert("open_time".into(), json!(it.open));
    p.insert("close_time".into(), json!(it.close));
    p
}

/// The `_insert_exception_interval` operations of one exception, taking ids from the batch after
/// the parent's (`new_ids[0]` is the exception itself).
fn exception_interval_ops(
    mut out: Output,
    kind: &str,
    exception_id: &Value,
    intervals: &[Interval],
    new_ids: &[Value],
) -> Result<Output, String> {
    for (i, it) in intervals.iter().enumerate() {
        let id = new_ids
            .get(i + 1)
            .cloned()
            .ok_or_else(|| "missing_id: too many intervals for one exception".to_string())?;
        out = out.with_operation(Operation::sql(
            "schedules._insert_exception_interval",
            exception_interval_params(id, kind, exception_id, i, it),
        ));
    }
    Ok(out)
}

/// Ids the host pre-generated for this call (`context.new_ids`, §5.3).
fn new_ids_of(input: &Value) -> Vec<Value> {
    input
        .get("context")
        .and_then(|c| c.get("new_ids"))
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default()
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
/// day(s) on `payload.date` (single create). Server-authoritative: the browser cannot forge it.
const SPECIAL_DAY_BY_DATE_READ: &str = "schedules.special_days.by_date";
/// Same, with ALL live special-day dates of the hub (bulk create, schedules#2).
const SPECIAL_DAY_DATES_READ: &str = "schedules.special_days.dates";
/// Live overrides whose range intersects `[payload.start_date, payload.end_date]` (schedules#2).
const OVERRIDES_OVERLAPPING_READ: &str = "schedules.overrides.overlapping";

/// Rows of a pre-loaded read, if the runtime delivered it (present even when empty).
fn read_rows<'a>(input: &'a Value, name: &str) -> Option<&'a Vec<Value>> {
    input.get("context").and_then(|c| c.get("reads")).and_then(|r| r.get(name)).and_then(|v| v.as_array())
}

/// Dates already taken by a live special day. Prefers the authoritative reads (`by_date` for
/// the single create, `dates` for the bulk); only when neither is present (old manifest / query
/// failed) it degrades to the client hint `existing_dates`.
fn taken_special_day_dates(input: &Value, payload: &Value) -> Vec<String> {
    match read_rows(input, SPECIAL_DAY_BY_DATE_READ).or_else(|| read_rows(input, SPECIAL_DAY_DATES_READ)) {
        Some(rows) => rows.iter().map(|r| str_or(r, "date", "")).filter(|d| !d.is_empty()).collect(),
        None => existing_dates(payload),
    }
}

// ── schedules.business_hours.set (fn set_business_hours) ──────────────────

/// One opening interval of a weekday. `close < open` means the interval crosses midnight
/// (22:00–02:00); `00:00–00:00` means «open 24 hours» (schedules#8, as Google Business
/// Profile represents them). Any other zero-length interval is invalid.
#[derive(Clone, Debug, PartialEq)]
struct Interval {
    open: String,
    close: String,
}

impl Interval {
    fn is_all_day(&self) -> bool {
        self.open == "00:00" && self.close == "00:00"
    }
    fn is_overnight(&self) -> bool {
        !self.is_all_day() && self.close < self.open
    }
    /// Minutes since 00:00 of the interval's own day: `[start, end)`; an overnight `end` runs
    /// past 1440 into the next day.
    fn span(&self) -> (i64, i64) {
        let start = minutes(&self.open);
        if self.is_all_day() {
            return (0, 1440);
        }
        let end = minutes(&self.close);
        (start, if end <= start { end + 1440 } else { end })
    }
}

fn minutes(t: &str) -> i64 {
    let h: i64 = t[0..2].parse().unwrap_or(0);
    let m: i64 = t[3..5].parse().unwrap_or(0);
    h * 60 + m
}

fn check_interval(it: &Interval) -> Result<(), String> {
    if !valid_time(&it.open) || !valid_time(&it.close) {
        return Err(format!("invalid_hours: invalid time format (open='{}', close='{}', expected HH:MM)", it.open, it.close));
    }
    if it.open == it.close && !it.is_all_day() {
        return Err(format!("invalid_hours: an interval cannot be empty ({}–{}); use 00:00–00:00 for open 24 hours", it.open, it.close));
    }
    Ok(())
}

/// Reads an `intervals[]` array as it travels in a payload.
fn intervals_of_array(arr: &[Value]) -> Vec<Interval> {
    arr.iter()
        .map(|it| Interval { open: str_or(it, "open_time", ""), close: str_or(it, "close_time", "") })
        .collect()
}

/// Validates, sorts and rejects overlaps in a set of intervals — the SAME rules for the weekly
/// hours (schedules#8) and for the exceptions (schedules#23): order does not matter to the caller,
/// two intervals may not cover the same minute, `close < open` crosses midnight and `00:00–00:00`
/// is 24 hours.
fn normalize_intervals(mut items: Vec<Interval>) -> Result<Vec<Interval>, String> {
    for it in &items {
        check_interval(it)?;
    }
    items.sort_by(|a, b| a.span().0.cmp(&b.span().0));
    // Overlaps: consecutive spans on the same day; and an overnight tail wraps into the first
    // interval of the morning — a 22:00–02:00 next to a 01:00 start is a clash.
    for w in items.windows(2) {
        let (a, b) = (&w[0], &w[1]);
        if b.span().0 < a.span().1 {
            return Err(format!("overlapping: intervals {}–{} and {}–{} overlap", a.open, a.close, b.open, b.close));
        }
    }
    if items.len() > 1 {
        let last = items.last().unwrap();
        let first = items.first().unwrap();
        if last.span().1 > 1440 && (last.span().1 - 1440) > first.span().0 {
            return Err(format!("overlapping: the overnight interval {}–{} runs into {}–{}", last.open, last.close, first.open, first.close));
        }
    }
    Ok(items)
}

/// The intervals of a weekday from the payload (schedules#8). Accepts the new `intervals[]`
/// and, for old callers, the legacy `open_time`/`close_time` + optional break, which becomes
/// one or two intervals ([open,break_start] + [break_end,close]). Validated, sorted, and
/// checked for overlaps (through midnight too).
fn intervals_from_payload(payload: &Value) -> Result<Vec<Interval>, String> {
    let items: Vec<Interval> = match payload.get("intervals").and_then(|v| v.as_array()) {
        Some(arr) => intervals_of_array(arr),
        None => {
            // Legacy shape. Defaults of the JSON Schema (the runtime does not apply them).
            let open = opt_str(payload, "open_time").unwrap_or_else(|| "09:00".to_string());
            let close = opt_str(payload, "close_time").unwrap_or_else(|| "18:00".to_string());
            let bs = opt_str(payload, "break_start");
            let be = opt_str(payload, "break_end");
            check_hours(&open, &close)?;
            match (bs, be) {
                (None, None) => vec![Interval { open, close }],
                (Some(bs), Some(be)) => {
                    check_break(&open, &close, &bs, &be)?;
                    vec![Interval { open, close: bs.clone() }, Interval { open: be, close }]
                }
                _ => return Err("invalid_break: a break needs both break_start and break_end (or neither)".to_string()),
            }
        }
    };
    normalize_intervals(items)
}

/// The opening intervals of an EXCEPTION — special day or override (schedules#23). With
/// `intervals[]` the same rules as the weekly hours apply (split shifts, overnight, 24 h,
/// no overlaps); without it, the legacy `open_time`/`close_time` pair becomes the single
/// interval 0 and keeps its stricter reading (`close > open`, no overnight, no 24 h), so a
/// payload written before this change means exactly what it meant. An exception with no hours
/// at all yields an empty list — the caller decides whether that is legal.
fn exception_intervals_from_payload(payload: &Value) -> Result<Vec<Interval>, String> {
    match payload.get("intervals").and_then(|v| v.as_array()) {
        Some(arr) => normalize_intervals(intervals_of_array(arr)),
        None => match (opt_str(payload, "open_time"), opt_str(payload, "close_time")) {
            (Some(open), Some(close)) => {
                check_hours(&open, &close)?;
                Ok(vec![Interval { open, close }])
            }
            _ => Ok(Vec::new()),
        },
    }
}

/// Replaces the weekday's intervals (schedules#8): one `_clear_business_hours_day` for the day
/// plus one `_insert_business_hours` per interval (or a single closed row). Ids come from
/// `context.new_ids` — the host is the only authority of ids.
pub fn set_business_hours_pure(input: Value) -> Result<Value, String> {
    let payload = input.get("payload").cloned().unwrap_or(Value::Null);
    let new_ids = new_ids_of(&input);

    let dow = as_i64(payload.get("day_of_week").unwrap_or(&Value::Null), -1);
    if !(0..=6).contains(&dow) {
        return Err(format!("invalid_day: day_of_week must be between 0 (Monday) and 6 (Sunday), got {dow}"));
    }
    let is_closed = bool_or(&payload, "is_closed", false);
    let intervals = if is_closed { Vec::new() } else { intervals_from_payload(&payload)? };
    if !is_closed && intervals.is_empty() {
        return Err("missing_hours: an open day needs at least one interval (open_time/close_time)".to_string());
    }

    let mut clear = Map::new();
    clear.insert("day_of_week".into(), json!(dow));
    let mut out = Output::new().with_operation(Operation::sql("schedules._clear_business_hours_day", clear));

    let row = |id: Value, position: usize, open: &str, close: &str, closed: bool| -> Map<String, Value> {
        let mut p = Map::new();
        p.insert("id".into(), id);
        p.insert("day_of_week".into(), json!(dow));
        p.insert("position".into(), json!(position as i64));
        p.insert("open_time".into(), json!(open));
        p.insert("close_time".into(), json!(close));
        p.insert("is_closed".into(), json!(closed as i64));
        // Legacy columns stay NULL: the break is now the gap between two intervals.
        p.insert("break_start".into(), Value::Null);
        p.insert("break_end".into(), Value::Null);
        p
    };
    if is_closed {
        let id = new_ids.first().cloned().ok_or_else(|| "missing_id: no id available".to_string())?;
        out = out.with_operation(Operation::sql("schedules._insert_business_hours", row(id, 0, "00:00", "00:00", true)));
    } else {
        for (i, it) in intervals.iter().enumerate() {
            let id = new_ids.get(i).cloned().ok_or_else(|| "missing_id: too many intervals for one day".to_string())?;
            out = out.with_operation(Operation::sql("schedules._insert_business_hours", row(id, i, &it.open, &it.close, false)));
        }
    }

    let event_intervals: Vec<Value> = intervals.iter().map(|i| json!({ "open_time": i.open, "close_time": i.close })).collect();
    let out = out.with_event(Event::new(
        "schedules.business_hours.updated",
        json!({
            "sender": "schedules",
            "day_of_week": dow,
            "is_closed": is_closed as i64,
            "intervals": event_intervals,
            // Legacy fields (first/last bound) for listeners that still read them.
            "open_time": intervals.first().map(|i| i.open.clone()).unwrap_or_default(),
            "close_time": intervals.last().map(|i| i.close.clone()).unwrap_or_default(),
        }),
    ));
    serde_json::to_value(&out).map_err(|e| e.to_string())
}

// ── schedules.special_days.create (fn create_special_day) ─────────────────

/// Alta validada de un día especial (WASM-TODO §3). `already_exists` se comprueba
/// contra `existing_dates` (si el caller las pasa); el índice único es el backstop.
///
/// schedules#23: an open special day now writes 0..N `schedules_exception_interval` rows — a
/// holiday with a split shift (10–13 and 17–19) is one day and two intervals, not two days.
pub fn create_special_day_pure(input: Value) -> Result<Value, String> {
    let payload = input.get("payload").cloned().unwrap_or(Value::Null);
    let item = validate_special_day(&payload)?;
    if taken_special_day_dates(&input, &payload).contains(&item.date) {
        return Err(format!("already_exists: ya existe un día especial en la fecha {}", item.date));
    }
    let new_ids = new_ids_of(&input);
    let day_id = new_ids.first().cloned().ok_or_else(|| "missing_id: no id available".to_string())?;
    let mut params = special_day_params(&item);
    params.insert("id".into(), day_id.clone());
    let out = Output::new().with_operation(Operation::sql("schedules._insert_special_day", params));
    let out = exception_interval_ops(out, "special_day", &day_id, &item.intervals, &new_ids)?;
    let out = out.with_event(special_day_event(&item));
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
    // schedules#23: an open override carries 0..N intervals (a summer split shift is one override
    // with two intervals). The legacy single pair still arrives as the one interval 0.
    let intervals = if is_closed { Vec::new() } else { exception_intervals_from_payload(&payload)? };
    if !is_closed && intervals.is_empty() {
        return Err("missing_hours: an open override (is_closed=0) requires open_time and close_time".to_string());
    }
    // A closed override never carries hours (no contradictory payloads reach the row); an open one
    // mirrors its FIRST interval on the row, so a reader that predates migration 003 never sees a
    // window wider than the truth.
    let (open_time, close_time) = match intervals.first() {
        Some(it) => (Some(it.open.clone()), Some(it.close.clone())),
        None => (None, None),
    };

    // schedules#2: two live overrides must not cover the same date — `is_open` would pick one by
    // list order, i.e. non-deterministically for the user. The read is authoritative (ADR-0069);
    // when absent (old manifest) nothing is checked, as before.
    if let Some(rows) = read_rows(&input, OVERRIDES_OVERLAPPING_READ) {
        if let Some(ov) = rows.iter().find(|r| {
            let s = str_or(r, "start_date", "");
            let e = str_or(r, "end_date", "");
            !s.is_empty() && !e.is_empty() && s <= end_date && start_date <= e
        }) {
            return Err(format!(
                "overlapping: the range {start_date}..{end_date} overlaps the override '{}' ({}..{})",
                str_or(ov, "reason", ""),
                str_or(ov, "start_date", ""),
                str_or(ov, "end_date", "")
            ));
        }
    }

    let new_ids = new_ids_of(&input);
    let override_id = new_ids.first().cloned().ok_or_else(|| "missing_id: no id available".to_string())?;

    let mut p = Map::new();
    p.insert("id".into(), override_id.clone());
    p.insert("start_date".into(), json!(start_date));
    p.insert("end_date".into(), json!(end_date));
    p.insert("reason".into(), json!(reason.trim()));
    p.insert("open_time".into(), open_time.clone().map(Value::String).unwrap_or(Value::Null));
    p.insert("close_time".into(), close_time.clone().map(Value::String).unwrap_or(Value::Null));
    p.insert("is_closed".into(), json!(is_closed as i64));

    let out = Output::new().with_operation(Operation::sql("schedules._insert_override", p));
    let out = exception_interval_ops(out, "override", &override_id, &intervals, &new_ids)?;
    let out = out.with_event(Event::new(
        "schedules.override.created",
        json!({
            "sender": "schedules",
            "start_date": start_date,
            "end_date": end_date,
            "reason": reason.trim(),
            "is_closed": is_closed as i64,
            "intervals": intervals_json(&intervals),
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

    let existing = taken_special_day_dates(&input, &payload);
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

/// Motor "¿está abierto ahora?" (WASM-TODO §1). Precedencia estricta:
/// SpecialDay (fecha exacta o `recurring_yearly` por MM-DD) → ScheduleOverride
/// (rango que cubre hoy) → BusinessHours (día de la semana, con descanso) →
/// sin configuración (`fail_open` decide). Solo-lectura: no emite intenciones;
/// el veredicto va por el canal `result` del Output (hub#70).
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
    // schedules#23: rows of `schedules.exception_intervals.list` — the 0..N intervals of the
    // special days and overrides above. Absent (old caller, exception written before migration
    // 003, day created by the bulk) → the pair on the exception row still decides.
    let exception_intervals = payload.get("exception_intervals").and_then(|v| v.as_array()).unwrap_or(&empty);

    let t = current_time.as_str();
    let now_min = minutes(t);
    // The verdict says WHICH rule won (schedules#8): `source` ∈ special_day | override |
    // business_hours | none, and `rule_id` = the row that decided (when there is one).
    let done = |is_open: bool, reason: String, source: &str, rule_id: Value| -> Result<Value, String> {
        Ok(output_with_result(
            Output::new(),
            json!({ "is_open": is_open, "reason": reason, "today": today, "current_time": current_time,
                    "source": source, "rule_id": rule_id }),
        ))
    };
    let id_of = |r: &Value| -> Value { r.get("id").cloned().unwrap_or(Value::Null) };
    // Intervals belonging to one exception, in `position` order (schedules#23).
    let intervals_of = |kind: &str, id: &Value| -> Vec<Interval> {
        let owner = as_str(id);
        let mut rows: Vec<&Value> = exception_intervals
            .iter()
            .filter(|r| str_or(r, "exception_kind", "") == kind && str_or(r, "exception_id", "") == owner)
            .collect();
        rows.sort_by_key(|r| as_i64(r.get("position").unwrap_or(&Value::Null), 0));
        rows.iter().map(|r| Interval { open: str_or(r, "open_time", "00:00"), close: str_or(r, "close_time", "00:00") }).collect()
    };
    // Is this moment inside the interval, on the interval's OWN day? `00:00–00:00` is 24 h; an
    // overnight interval (22:00–02:00) counts from `open` to midnight — the small hours that
    // follow belong to the NEXT date and are governed by that date's rules.
    let covers = |it: &Interval| -> bool {
        if it.is_all_day() {
            return true;
        }
        let (start, end) = it.span();
        now_min >= start && now_min < end
    };

    // 1) SpecialDay: fecha exacta tiene prioridad sobre recurrente (MM-DD).
    let exact = special_days.iter().find(|r| str_or(r, "date", "") == today);
    let recurring = special_days.iter().find(|r| {
        let d = str_or(r, "date", "");
        bool_or(r, "recurring_yearly", false) && d.len() == 10 && d[5..] == today[5..]
    });
    if let Some(sd) = exact.or(recurring) {
        let name = str_or(sd, "name", "Special day");
        let id = id_of(sd);
        if bool_or(sd, "is_closed", true) {
            return done(false, name, "special_day", id);
        }
        let intervals = intervals_of("special_day", &id);
        if !intervals.is_empty() {
            return done(intervals.iter().any(covers), name, "special_day", id);
        }
        return match (opt_str(sd, "open_time"), opt_str(sd, "close_time")) {
            (Some(o), Some(c)) => done(t >= o.as_str() && t < c.as_str(), name, "special_day", id),
            // SpecialDay abierto sin horas = abierto todo el día.
            _ => done(true, name, "special_day", id),
        };
    }

    // 2) ScheduleOverride que cubre hoy (start_date <= hoy <= end_date).
    if let Some(ov) = overrides.iter().find(|r| {
        let s = str_or(r, "start_date", "");
        let e = str_or(r, "end_date", "");
        !s.is_empty() && !e.is_empty() && s.as_str() <= today.as_str() && today.as_str() <= e.as_str()
    }) {
        let reason = str_or(ov, "reason", "Schedule override");
        let id = id_of(ov);
        if bool_or(ov, "is_closed", false) {
            return done(false, reason, "override", id);
        }
        let intervals = intervals_of("override", &id);
        if !intervals.is_empty() {
            return done(intervals.iter().any(covers), reason, "override", id);
        }
        return match (opt_str(ov, "open_time"), opt_str(ov, "close_time")) {
            (Some(o), Some(c)) => done(t >= o.as_str() && t < c.as_str(), reason, "override", id),
            _ => done(true, reason, "override", id),
        };
    }

    // 3) Weekly hours: EVERY row of the weekday is an interval (schedules#8) — split shifts are
    //    several rows; a row with `is_closed` closes the day; legacy rows may still carry a break.
    //    An overnight interval of YESTERDAY (22:00–02:00) reaches into this morning.
    let dow = weekday_iso0(&today).ok_or_else(|| format!("invalid_date: invalid date '{today}'"))?;
    let rows_for = |d: i64| -> Vec<&Value> {
        business_hours.iter().filter(|r| as_i64(r.get("day_of_week").unwrap_or(&Value::Null), -1) == d).collect()
    };
    let todays = rows_for(dow);
    let now_min = minutes(t);
    let interval_of = |r: &Value| Interval { open: str_or(r, "open_time", "00:00"), close: str_or(r, "close_time", "00:00") };
    // Yesterday's overnight interval (22:00–02:00) that still covers this moment, if any.
    let overnight_from_yesterday = || -> Option<&Value> {
        rows_for((dow + 6) % 7).into_iter().find(|r| {
            let it = interval_of(r);
            !bool_or(r, "is_closed", false) && it.is_overnight() && now_min < it.span().1 - 1440
        })
    };
    if !todays.is_empty() {
        if let Some(closed) = todays.iter().find(|r| bool_or(r, "is_closed", false)) {
            // Even on a closed day, yesterday's overnight tail may still be open.
            if let Some(y) = overnight_from_yesterday() {
                return done(true, format!("Open (overnight from {})", str_or(y, "open_time", "")), "business_hours", id_of(y));
            }
            return done(false, "Closed today".to_string(), "business_hours", id_of(closed));
        }
        let mut described: Vec<String> = Vec::new();
        for r in &todays {
            let it = interval_of(r);
            let (start, end) = it.span();
            let bs = opt_str(r, "break_start");
            let be = opt_str(r, "break_end");
            let in_span = it.is_all_day() || (now_min >= start && now_min < end);
            let on_break = matches!((&bs, &be), (Some(bs), Some(be)) if t >= bs.as_str() && t < be.as_str());
            if in_span && !on_break {
                return done(true, format!("Open ({}–{})", it.open, it.close), "business_hours", id_of(r));
            }
            if in_span && on_break {
                return done(false, "On break".to_string(), "business_hours", id_of(r));
            }
            described.push(format!("{}–{}", it.open, it.close));
        }
        if let Some(y) = overnight_from_yesterday() {
            return done(true, format!("Open (overnight from {})", str_or(y, "open_time", "")), "business_hours", id_of(y));
        }
        let first = todays[0];
        return done(false, format!("Outside business hours ({})", described.join(", ")), "business_hours", id_of(first));
    }
    // No rows today: yesterday's overnight interval may still cover this moment.
    if let Some(y) = overnight_from_yesterday() {
        return done(true, format!("Open (overnight from {})", str_or(y, "open_time", "")), "business_hours", id_of(y));
    }

    // 4) Sin configuración para hoy: fail-open (contrato cross-módulo) o fail-closed (dashboard).
    if fail_open {
        done(true, "No hours configured (fail-open)".to_string(), "none", Value::Null)
    } else {
        done(false, "No hours configured".to_string(), "none", Value::Null)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The host ALWAYS hands the guest a batch of pre-generated ids (`NEW_IDS_BATCH` = 256 in
    /// `crates/runtime/src/commands.rs`), so a test input without them models a call the runtime
    /// never makes.
    fn ids(n: usize) -> Vec<String> {
        (0..n).map(|i| format!("id-{i}")).collect()
    }

    fn input(payload: Value) -> Value {
        json!({ "payload": payload, "context": { "hub_id": "h1", "now": "2026-08-18T10:00:00Z",
            "new_ids": ids(16) } })
    }

    fn input_with_reads(payload: Value, reads: Value) -> Value {
        let mut v = input(payload);
        v["context"]["reads"] = reads;
        v
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

    // ── schedules#2: real calendar dates, inverted intervals, overlaps ──

    #[test]
    fn valid_date_uses_the_real_calendar_including_leap_years() {
        assert!(valid_date("2024-02-29"), "2024 is a leap year");
        assert!(!valid_date("2026-02-29"), "2026 is not a leap year");
        assert!(!valid_date("2026-02-31"));
        assert!(!valid_date("2026-04-31"));
        assert!(!valid_date("2026-13-01"));
        assert!(!valid_date("2026-00-10"));
        assert!(!valid_date("2026-01-00"));
        assert!(!valid_date("2100-02-29"), "century rule: 2100 is not leap");
        assert!(valid_date("2000-02-29"), "400 rule: 2000 is leap");
        assert!(valid_date("2026-12-31"));
    }

    #[test]
    fn special_day_create_rejects_impossible_calendar_date() {
        let payload = json!({ "date": "2026-02-31", "name": "Nope", "is_closed": true });
        assert_eq!(err_code(create_special_day_pure(input(payload))), "invalid_date");
    }

    #[test]
    fn bulk_rejects_impossible_dates_per_item_and_keeps_the_valid_ones() {
        let payload = json!({ "special_days": [
            { "date": "2026-02-31", "name": "Nope", "is_closed": true },
            { "date": "2024-02-29", "name": "Leap", "is_closed": true },
            { "date": "2026-02-29", "name": "Not leap", "is_closed": true },
        ]});
        let out = bulk_create_special_days_pure(input(payload)).expect("bulk is fault-tolerant");
        assert_eq!(out["result"]["created"], 1);
        assert_eq!(out["result"]["errors"].as_array().unwrap().len(), 2);
        assert!(out["result"]["errors"][0]["error"].as_str().unwrap().starts_with("invalid_date"));
    }

    #[test]
    fn bulk_dedupes_against_authoritative_read_of_existing_dates() {
        let payload = json!({ "special_days": [
            { "date": "2026-12-25", "name": "Christmas", "is_closed": true },
            { "date": "2026-12-26", "name": "Boxing day", "is_closed": true },
            { "date": "2026-12-26", "name": "Duplicate in batch", "is_closed": true },
        ]});
        let reads = json!({ "schedules.special_days.dates": [ { "date": "2026-12-25" } ] });
        let out = bulk_create_special_days_pure(input_with_reads(payload, reads)).expect("ok");
        assert_eq!(out["result"]["created"], 1);
        assert_eq!(out["operations"].as_array().unwrap().len(), 1);
        assert_eq!(out["result"]["errors"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn override_create_rejects_inverted_range_and_inverted_hours() {
        let inverted_range = json!({ "start_date": "2026-08-15", "end_date": "2026-08-01", "reason": "x", "is_closed": true });
        assert_eq!(err_code(create_override_pure(input(inverted_range))), "invalid_range");
        let inverted_hours = json!({ "start_date": "2026-08-01", "end_date": "2026-08-15", "reason": "x", "is_closed": false, "open_time": "14:00", "close_time": "10:00" });
        assert_eq!(err_code(create_override_pure(input(inverted_hours))), "invalid_hours");
        let same_hours = json!({ "start_date": "2026-08-01", "end_date": "2026-08-15", "reason": "x", "is_closed": false, "open_time": "10:00", "close_time": "10:00" });
        assert_eq!(err_code(create_override_pure(input(same_hours))), "invalid_hours");
    }

    #[test]
    fn override_create_rejects_overlap_with_live_override_from_authoritative_read() {
        let payload = json!({ "start_date": "2026-08-10", "end_date": "2026-08-20", "reason": "Summer", "is_closed": true });
        let reads = json!({ "schedules.overrides.overlapping": [
            { "id": "o1", "start_date": "2026-08-01", "end_date": "2026-08-15", "reason": "Holidays" }
        ]});
        let r = create_override_pure(input_with_reads(payload, reads));
        assert_eq!(err_code(r), "overlapping");
    }

    #[test]
    fn override_create_accepts_when_overlap_read_is_empty() {
        let payload = json!({ "start_date": "2026-08-10", "end_date": "2026-08-20", "reason": "Summer", "is_closed": true });
        let reads = json!({ "schedules.overrides.overlapping": [] });
        assert!(create_override_pure(input_with_reads(payload, reads)).is_ok());
    }

    #[test]
    fn override_create_open_with_hours_is_ok() {
        let payload = json!({ "start_date": "2026-08-01", "end_date": "2026-08-15", "reason": "Summer", "is_closed": false, "open_time": "10:00", "close_time": "14:00" });
        let out = create_override_pure(input(payload)).expect("ok");
        assert_eq!(out["operations"][0]["params"]["open_time"], "10:00");
    }

    // ── schedules#8: several intervals per weekday, overnight, 24 h, and an explained verdict ──

    fn ctx_with_ids(payload: Value) -> Value {
        json!({ "payload": payload, "context": { "hub_id": "h1", "now": "2026-08-18T10:00:00Z",
            "new_ids": ["n1", "n2", "n3", "n4"] } })
    }

    #[test]
    fn set_hours_with_two_intervals_clears_the_day_and_inserts_one_row_per_interval() {
        let payload = json!({ "day_of_week": 0, "intervals": [
            { "open_time": "10:00", "close_time": "14:00" },
            { "open_time": "17:00", "close_time": "20:00" } ] });
        let out = set_business_hours_pure(ctx_with_ids(payload)).expect("ok");
        let ops = out["operations"].as_array().unwrap();
        assert_eq!(ops[0]["command"], "schedules._clear_business_hours_day");
        assert_eq!(ops[0]["params"]["day_of_week"], 0);
        assert_eq!(ops.len(), 3);
        assert_eq!(ops[1]["command"], "schedules._insert_business_hours");
        assert_eq!(ops[1]["params"]["id"], "n1");
        assert_eq!(ops[1]["params"]["position"], 0);
        assert_eq!(ops[1]["params"]["open_time"], "10:00");
        assert_eq!(ops[1]["params"]["close_time"], "14:00");
        assert_eq!(ops[1]["params"]["is_closed"], 0);
        assert_eq!(ops[2]["params"]["id"], "n2");
        assert_eq!(ops[2]["params"]["position"], 1);
        assert_eq!(ops[2]["params"]["open_time"], "17:00");
        assert_eq!(out["events"][0]["name"], "schedules.business_hours.updated");
        assert_eq!(out["events"][0]["payload"]["intervals"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn set_hours_intervals_are_sorted_and_overlaps_are_rejected() {
        let unsorted = json!({ "day_of_week": 1, "intervals": [
            { "open_time": "17:00", "close_time": "20:00" },
            { "open_time": "10:00", "close_time": "14:00" } ] });
        let out = set_business_hours_pure(ctx_with_ids(unsorted)).expect("ok");
        assert_eq!(out["operations"][1]["params"]["open_time"], "10:00");
        assert_eq!(out["operations"][2]["params"]["open_time"], "17:00");

        let overlap = json!({ "day_of_week": 1, "intervals": [
            { "open_time": "10:00", "close_time": "14:00" },
            { "open_time": "13:00", "close_time": "20:00" } ] });
        assert_eq!(err_code(set_business_hours_pure(ctx_with_ids(overlap))), "overlapping");
    }

    #[test]
    fn set_hours_overnight_and_24h_intervals_are_representable() {
        // 22:00–02:00 crosses midnight: close < open is the overnight representation.
        let night = json!({ "day_of_week": 4, "intervals": [ { "open_time": "22:00", "close_time": "02:00" } ] });
        let out = set_business_hours_pure(ctx_with_ids(night)).expect("overnight must be accepted");
        assert_eq!(out["operations"][1]["params"]["close_time"], "02:00");
        // 00:00–00:00 is «open 24 hours».
        let all_day = json!({ "day_of_week": 5, "intervals": [ { "open_time": "00:00", "close_time": "00:00" } ] });
        set_business_hours_pure(ctx_with_ids(all_day)).expect("24h must be accepted");
        // Any other zero-length interval is still an error.
        let zero = json!({ "day_of_week": 5, "intervals": [ { "open_time": "10:00", "close_time": "10:00" } ] });
        assert_eq!(err_code(set_business_hours_pure(ctx_with_ids(zero))), "invalid_hours");
        // An overnight interval followed by a morning one overlaps through midnight → still overlapping.
        let wrap = json!({ "day_of_week": 4, "intervals": [
            { "open_time": "22:00", "close_time": "02:00" }, { "open_time": "23:00", "close_time": "23:30" } ] });
        assert_eq!(err_code(set_business_hours_pure(ctx_with_ids(wrap))), "overlapping");
    }

    #[test]
    fn set_hours_legacy_open_close_break_payload_becomes_intervals() {
        let legacy = json!({ "day_of_week": 2, "open_time": "09:00", "close_time": "18:00",
            "break_start": "13:00", "break_end": "15:00" });
        let out = set_business_hours_pure(ctx_with_ids(legacy)).expect("ok");
        let ops = out["operations"].as_array().unwrap();
        assert_eq!(ops.len(), 3);
        assert_eq!((ops[1]["params"]["open_time"].as_str().unwrap(), ops[1]["params"]["close_time"].as_str().unwrap()), ("09:00", "13:00"));
        assert_eq!((ops[2]["params"]["open_time"].as_str().unwrap(), ops[2]["params"]["close_time"].as_str().unwrap()), ("15:00", "18:00"));
    }

    #[test]
    fn set_hours_closed_day_writes_a_single_closed_row_and_no_intervals() {
        let payload = json!({ "day_of_week": 6, "is_closed": true, "intervals": [ { "open_time": "10:00", "close_time": "14:00" } ] });
        let out = set_business_hours_pure(ctx_with_ids(payload)).expect("ok");
        let ops = out["operations"].as_array().unwrap();
        assert_eq!(ops.len(), 2);
        assert_eq!(ops[1]["params"]["is_closed"], 1);
        // An open day with no interval is a mistake, not «open all day».
        let empty = json!({ "day_of_week": 6, "is_closed": false, "intervals": [] });
        assert_eq!(err_code(set_business_hours_pure(ctx_with_ids(empty))), "missing_hours");
    }

    fn open_at(when: &str, business_hours: Value) -> Value {
        let payload = json!({ "when": when, "business_hours": business_hours });
        is_open_pure(input(payload)).expect("ok")["result"].clone()
    }

    #[test]
    fn is_open_walks_every_interval_of_the_weekday() {
        // 2026-08-17 is a Monday (dow 0). Split shift 10–14 / 17–20 as two rows.
        let bh = json!([
            { "id": "a", "day_of_week": 0, "open_time": "10:00", "close_time": "14:00", "is_closed": 0 },
            { "id": "b", "day_of_week": 0, "open_time": "17:00", "close_time": "20:00", "is_closed": 0 } ]);
        assert_eq!(open_at("2026-08-17T11:00", bh.clone())["is_open"], true);
        assert_eq!(open_at("2026-08-17T15:00", bh.clone())["is_open"], false);
        let evening = open_at("2026-08-17T18:00", bh.clone());
        assert_eq!(evening["is_open"], true);
        assert_eq!(evening["source"], "business_hours");
        assert_eq!(evening["rule_id"], "b");
        assert_eq!(open_at("2026-08-17T15:00", bh)["source"], "business_hours");
    }

    #[test]
    fn is_open_overnight_interval_reaches_into_the_next_day_and_24h_is_always_open() {
        // Thursday (dow 3) 22:00–02:00: 2026-08-20 is a Thursday, 2026-08-21 a Friday.
        let bh = json!([ { "id": "n", "day_of_week": 3, "open_time": "22:00", "close_time": "02:00", "is_closed": 0 } ]);
        assert_eq!(open_at("2026-08-20T23:00", bh.clone())["is_open"], true);
        let after_midnight = open_at("2026-08-21T01:00", bh.clone());
        assert_eq!(after_midnight["is_open"], true);
        assert_eq!(after_midnight["rule_id"], "n");
        assert_eq!(open_at("2026-08-21T03:00", bh.clone())["is_open"], false);
        assert_eq!(open_at("2026-08-20T21:00", bh)["is_open"], false);

        let all_day = json!([ { "id": "d", "day_of_week": 3, "open_time": "00:00", "close_time": "00:00", "is_closed": 0 } ]);
        assert_eq!(open_at("2026-08-20T00:00", all_day.clone())["is_open"], true);
        assert_eq!(open_at("2026-08-20T23:59", all_day)["is_open"], true);
    }

    #[test]
    fn is_open_reports_which_rule_won_special_day_over_override_over_weekly() {
        let payload = json!({ "when": "2026-12-25T11:00",
            "special_days": [ { "id": "sd", "date": "2026-12-25", "name": "Christmas", "is_closed": 1 } ],
            "overrides": [ { "id": "ov", "start_date": "2026-12-20", "end_date": "2026-12-31", "reason": "Winter", "is_closed": 0, "open_time": "10:00", "close_time": "14:00" } ],
            "business_hours": [ { "id": "bh", "day_of_week": 4, "open_time": "09:00", "close_time": "18:00", "is_closed": 0 } ] });
        let r = is_open_pure(input(payload)).expect("ok")["result"].clone();
        assert_eq!(r["is_open"], false);
        assert_eq!(r["source"], "special_day");
        assert_eq!(r["rule_id"], "sd");

        let payload = json!({ "when": "2026-12-26T11:00",
            "overrides": [ { "id": "ov", "start_date": "2026-12-20", "end_date": "2026-12-31", "reason": "Winter", "is_closed": 0, "open_time": "10:00", "close_time": "14:00" } ],
            "business_hours": [ { "id": "bh", "day_of_week": 5, "open_time": "09:00", "close_time": "18:00", "is_closed": 0 } ] });
        let r = is_open_pure(input(payload)).expect("ok")["result"].clone();
        assert_eq!(r["source"], "override");
        assert_eq!(r["rule_id"], "ov");

        let r = is_open_pure(input(json!({ "when": "2026-12-26T11:00" }))).expect("ok")["result"].clone();
        assert_eq!(r["source"], "none");
    }

    // ── schedules#23: an exception (special day / override) also carries 0..N intervals ──

    /// The ops a create emitted, as `(command, params)`, so a test reads them by name instead of
    /// by index (the parent is always the first one).
    fn ops_of(out: &Value) -> Vec<(String, Value)> {
        out["operations"]
            .as_array()
            .expect("operations")
            .iter()
            .map(|o| (o["command"].as_str().unwrap_or_default().to_string(), o["params"].clone()))
            .collect()
    }

    fn empty_by_date() -> Value {
        json!({ "schedules.special_days.by_date": [] })
    }

    fn create_special_day_with(payload: Value) -> Result<Value, String> {
        let mut input = ctx_with_ids(payload);
        input["context"]["reads"] = empty_by_date();
        create_special_day_pure(input)
    }

    #[test]
    fn special_day_with_intervals_writes_the_day_plus_one_child_row_per_interval() {
        // A holiday with a split shift (10–13 and 17–19) — the case schedules#23 opened with.
        let out = create_special_day_with(json!({
            "date": "2026-12-24", "name": "Christmas Eve", "is_closed": false,
            "intervals": [ { "open_time": "10:00", "close_time": "13:00" },
                           { "open_time": "17:00", "close_time": "19:00" } ]
        }))
        .expect("a split-shift special day is legal");
        let ops = ops_of(&out);
        assert_eq!(ops.len(), 3, "the day + its two intervals");
        assert_eq!(ops[0].0, "schedules._insert_special_day");
        // The parent id comes from the host's batch, so the children can point at it.
        assert_eq!(ops[0].1["id"], "n1");
        assert_eq!(ops[1].0, "schedules._insert_exception_interval");
        assert_eq!(ops[1].1["exception_kind"], "special_day");
        assert_eq!(ops[1].1["exception_id"], "n1");
        assert_eq!(ops[1].1["id"], "n2");
        assert_eq!(ops[1].1["position"], 0);
        assert_eq!(ops[1].1["open_time"], "10:00");
        assert_eq!(ops[1].1["close_time"], "13:00");
        assert_eq!(ops[2].1["id"], "n3");
        assert_eq!(ops[2].1["position"], 1);
        assert_eq!(ops[2].1["open_time"], "17:00");
        // The parent pair mirrors the FIRST interval: a pre-003 reader sees a real opening slot,
        // never a wider one.
        assert_eq!(ops[0].1["open_time"], "10:00");
        assert_eq!(ops[0].1["close_time"], "13:00");
        assert_eq!(out["events"][0]["payload"]["intervals"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn special_day_intervals_are_sorted_and_validated_like_the_weekly_ones() {
        let unsorted = create_special_day_with(json!({
            "date": "2026-12-24", "name": "Eve", "is_closed": false,
            "intervals": [ { "open_time": "17:00", "close_time": "19:00" },
                           { "open_time": "10:00", "close_time": "13:00" } ]
        }))
        .expect("ok");
        assert_eq!(ops_of(&unsorted)[1].1["open_time"], "10:00");

        let overlap = json!({ "date": "2026-12-24", "name": "Eve", "is_closed": false,
            "intervals": [ { "open_time": "10:00", "close_time": "14:00" },
                           { "open_time": "13:00", "close_time": "19:00" } ] });
        assert_eq!(err_code(create_special_day_with(overlap)), "overlapping");

        // Through midnight too: a 22:00–02:00 tail clashes with a 01:00 start.
        let wrap = json!({ "date": "2026-12-31", "name": "New Year's Eve", "is_closed": false,
            "intervals": [ { "open_time": "22:00", "close_time": "02:00" },
                           { "open_time": "01:00", "close_time": "01:30" } ] });
        assert_eq!(err_code(create_special_day_with(wrap)), "overlapping");

        // 00:00–00:00 = open 24 h; any other zero-length interval is a mistake.
        create_special_day_with(json!({ "date": "2026-12-24", "name": "Eve", "is_closed": false,
            "intervals": [ { "open_time": "00:00", "close_time": "00:00" } ] }))
            .expect("24 h must be accepted");
        let zero = json!({ "date": "2026-12-24", "name": "Eve", "is_closed": false,
            "intervals": [ { "open_time": "10:00", "close_time": "10:00" } ] });
        assert_eq!(err_code(create_special_day_with(zero)), "invalid_hours");

        // An open exception with an empty interval list is a mistake, not «open all day».
        let none = json!({ "date": "2026-12-24", "name": "Eve", "is_closed": false, "intervals": [] });
        assert_eq!(err_code(create_special_day_with(none)), "missing_hours");
    }

    #[test]
    fn special_day_legacy_open_close_payload_still_writes_exactly_one_interval() {
        let out = create_special_day_with(json!({
            "date": "2026-12-24", "name": "Eve", "is_closed": false,
            "open_time": "09:00", "close_time": "14:00"
        }))
        .expect("ok");
        let ops = ops_of(&out);
        assert_eq!(ops.len(), 2);
        assert_eq!(ops[0].1["open_time"], "09:00");
        assert_eq!(ops[1].0, "schedules._insert_exception_interval");
        assert_eq!(ops[1].1["open_time"], "09:00");
        assert_eq!(ops[1].1["close_time"], "14:00");
    }

    #[test]
    fn a_closed_special_day_writes_no_interval_at_all() {
        let out = create_special_day_with(json!({ "date": "2026-12-25", "name": "Christmas", "is_closed": true }))
            .expect("ok");
        let ops = ops_of(&out);
        assert_eq!(ops.len(), 1);
        assert_eq!(ops[0].0, "schedules._insert_special_day");
        assert_eq!(ops[0].1["is_closed"], 1);
    }

    #[test]
    fn override_with_intervals_writes_the_override_plus_one_child_row_per_interval() {
        let payload = json!({ "start_date": "2026-08-01", "end_date": "2026-08-31", "reason": "Summer",
            "is_closed": false,
            "intervals": [ { "open_time": "10:00", "close_time": "13:30" },
                           { "open_time": "18:00", "close_time": "21:00" } ] });
        let out = create_override_pure(ctx_with_ids(payload)).expect("a split-shift override is legal");
        let ops = ops_of(&out);
        assert_eq!(ops.len(), 3);
        assert_eq!(ops[0].0, "schedules._insert_override");
        assert_eq!(ops[0].1["id"], "n1");
        assert_eq!(ops[1].0, "schedules._insert_exception_interval");
        assert_eq!(ops[1].1["exception_kind"], "override");
        assert_eq!(ops[1].1["exception_id"], "n1");
        assert_eq!(ops[1].1["position"], 0);
        assert_eq!(ops[2].1["position"], 1);
        assert_eq!(ops[2].1["open_time"], "18:00");
        assert_eq!(out["events"][0]["payload"]["intervals"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn override_intervals_reject_overlaps_and_a_closed_override_writes_none() {
        let overlap = json!({ "start_date": "2026-08-01", "end_date": "2026-08-31", "reason": "Summer",
            "is_closed": false,
            "intervals": [ { "open_time": "10:00", "close_time": "14:00" },
                           { "open_time": "12:00", "close_time": "20:00" } ] });
        assert_eq!(err_code(create_override_pure(ctx_with_ids(overlap))), "overlapping");

        let closed = json!({ "start_date": "2026-08-01", "end_date": "2026-08-31", "reason": "Holidays", "is_closed": true });
        let out = create_override_pure(ctx_with_ids(closed)).expect("ok");
        assert_eq!(ops_of(&out).len(), 1);
    }

    fn open_with_exceptions(when: &str, extra: Value) -> Value {
        let mut payload = json!({ "when": when });
        for (k, v) in extra.as_object().expect("object") {
            payload[k] = v.clone();
        }
        is_open_pure(input(payload)).expect("ok")["result"].clone()
    }

    #[test]
    fn is_open_walks_every_interval_of_the_winning_special_day() {
        let extra = json!({
            "special_days": [ { "id": "sd", "date": "2026-12-24", "name": "Eve", "is_closed": 0,
                                "open_time": "10:00", "close_time": "13:00" } ],
            "exception_intervals": [
                { "id": "i1", "exception_kind": "special_day", "exception_id": "sd", "position": 0, "open_time": "10:00", "close_time": "13:00" },
                { "id": "i2", "exception_kind": "special_day", "exception_id": "sd", "position": 1, "open_time": "17:00", "close_time": "19:00" } ] });
        assert_eq!(open_with_exceptions("2026-12-24T11:00", extra.clone())["is_open"], true);
        // The gap between the two intervals is CLOSED — before schedules#23 it read as open.
        let midday = open_with_exceptions("2026-12-24T15:00", extra.clone());
        assert_eq!(midday["is_open"], false);
        assert_eq!(midday["source"], "special_day");
        assert_eq!(midday["rule_id"], "sd");
        // …and the second interval is open again.
        assert_eq!(open_with_exceptions("2026-12-24T18:00", extra.clone())["is_open"], true);
        assert_eq!(open_with_exceptions("2026-12-24T20:00", extra)["is_open"], false);
    }

    #[test]
    fn is_open_walks_every_interval_of_the_winning_override() {
        let extra = json!({
            "overrides": [ { "id": "ov", "start_date": "2026-08-01", "end_date": "2026-08-31",
                             "reason": "Summer", "is_closed": 0, "open_time": "10:00", "close_time": "13:30" } ],
            "exception_intervals": [
                { "id": "i1", "exception_kind": "override", "exception_id": "ov", "position": 0, "open_time": "10:00", "close_time": "13:30" },
                { "id": "i2", "exception_kind": "override", "exception_id": "ov", "position": 1, "open_time": "18:00", "close_time": "21:00" } ] });
        assert_eq!(open_with_exceptions("2026-08-05T12:00", extra.clone())["is_open"], true);
        assert_eq!(open_with_exceptions("2026-08-05T16:00", extra.clone())["is_open"], false);
        let evening = open_with_exceptions("2026-08-05T19:00", extra);
        assert_eq!(evening["is_open"], true);
        assert_eq!(evening["source"], "override");
        assert_eq!(evening["rule_id"], "ov");
    }

    #[test]
    fn is_open_falls_back_to_the_parent_pair_when_the_exception_has_no_intervals() {
        // Rows written before migration 003, and the ones the bulk creates: no child rows, the
        // pair on the parent still decides. Intervals of ANOTHER exception must not leak in.
        let extra = json!({
            "special_days": [ { "id": "sd", "date": "2026-12-24", "name": "Eve", "is_closed": 0,
                                "open_time": "10:00", "close_time": "13:00" } ],
            "exception_intervals": [
                { "id": "i1", "exception_kind": "special_day", "exception_id": "other", "position": 0, "open_time": "17:00", "close_time": "19:00" },
                { "id": "i2", "exception_kind": "override", "exception_id": "sd", "position": 0, "open_time": "17:00", "close_time": "19:00" } ] });
        assert_eq!(open_with_exceptions("2026-12-24T11:00", extra.clone())["is_open"], true);
        assert_eq!(open_with_exceptions("2026-12-24T18:00", extra)["is_open"], false);
    }

    // ── schedules#10: the answer travels in the host's result channel, and DST is a non-event ──

    #[test]
    fn the_is_open_verdict_travels_in_the_official_result_channel() {
        // hub#70 gave handlers a `result` field; the host reads `Output.result` and caps its size.
        // Serialising a hand-made `{"result": …}` next to the Output would look identical HERE and
        // still be wrong on the wire, so the check is: what the handler returns must deserialise
        // back into an `Output` carrying the verdict.
        let payload = json!({ "when": "2026-08-17T11:00",
            "business_hours": [ { "id": "a", "day_of_week": 0, "open_time": "10:00", "close_time": "14:00", "is_closed": 0 } ] });
        let raw = is_open_pure(input(payload)).expect("ok");
        let out: Output = serde_json::from_value(raw).expect("the host deserialises the Output");
        let result = out.result.expect("the verdict is a result, not an operation");
        assert_eq!(result["is_open"], true);
        assert_eq!(result["source"], "business_hours");
        assert_eq!(result["rule_id"], "a");
        assert!(out.operations.is_empty(), "a read-only handler writes nothing");
        assert!(out.events.is_empty(), "and emits nothing");
    }

    #[test]
    fn the_bulk_summary_travels_in_the_result_channel_too() {
        let payload = json!({ "special_days": [
            { "date": "2026-02-31", "name": "Impossible", "is_closed": true },
            { "date": "2026-03-01", "name": "Fine", "is_closed": true } ]});
        let raw = bulk_create_special_days_pure(input(payload)).expect("the bulk is fault-tolerant");
        let out: Output = serde_json::from_value(raw).expect("the host deserialises the Output");
        let result = out.result.expect("the partial summary is the point of the bulk");
        assert_eq!(result["created"], 1);
        assert_eq!(result["errors"].as_array().unwrap().len(), 1);
        assert_eq!(out.operations.len(), 1, "only the valid item is written");
    }

    #[test]
    fn daylight_saving_does_not_move_the_opening_hours() {
        // Hours are WALL-CLOCK text ('HH:MM'), never instants, so the last Sunday of March (Europe
        // skips 02:00→03:00) and of October (01:00 happens twice) change nothing: a shop that
        // opens at 10:00 opens at 10:00 on both. This is a property of the model — the test is
        // here so nobody "fixes" it into UTC arithmetic and silently shifts every schedule by an
        // hour twice a year.
        let bh = json!([ { "id": "a", "day_of_week": 6, "open_time": "10:00", "close_time": "20:00", "is_closed": 0 } ]);
        // 2026-03-29 and 2026-10-25 are both Sundays (dow 6) and both DST switch days in Europe.
        for day in ["2026-03-29", "2026-10-25"] {
            assert_eq!(open_at(&format!("{day}T09:59"), bh.clone())["is_open"], false, "{day}");
            assert_eq!(open_at(&format!("{day}T10:00"), bh.clone())["is_open"], true, "{day}");
            assert_eq!(open_at(&format!("{day}T19:59"), bh.clone())["is_open"], true, "{day}");
            assert_eq!(open_at(&format!("{day}T20:00"), bh.clone())["is_open"], false, "{day}");
        }
        // And the hour that is skipped (02:00–03:00 in March) is simply outside the schedule.
        let night = json!([ { "id": "n", "day_of_week": 6, "open_time": "01:00", "close_time": "04:00", "is_closed": 0 } ]);
        assert_eq!(open_at("2026-03-29T02:30", night.clone())["is_open"], true, "a skipped wall-clock hour still reads as open");
        assert_eq!(open_at("2026-10-25T02:30", night)["is_open"], true, "a repeated one too");
    }

    #[test]
    fn a_24h_interval_on_an_exception_is_open_all_day_and_an_overnight_one_runs_to_midnight() {
        let all_day = json!({
            "special_days": [ { "id": "sd", "date": "2026-12-24", "name": "Eve", "is_closed": 0 } ],
            "exception_intervals": [ { "id": "i1", "exception_kind": "special_day", "exception_id": "sd", "position": 0, "open_time": "00:00", "close_time": "00:00" } ] });
        assert_eq!(open_with_exceptions("2026-12-24T03:00", all_day.clone())["is_open"], true);
        assert_eq!(open_with_exceptions("2026-12-24T23:59", all_day)["is_open"], true);

        // Overnight (22:00–02:00) is honoured on the exception's OWN date, up to midnight; the
        // small hours of the next day are governed by the next day's rules (documented boundary).
        let night = json!({
            "special_days": [ { "id": "sd", "date": "2026-12-31", "name": "New Year's Eve", "is_closed": 0 } ],
            "exception_intervals": [ { "id": "i1", "exception_kind": "special_day", "exception_id": "sd", "position": 0, "open_time": "22:00", "close_time": "02:00" } ] });
        assert_eq!(open_with_exceptions("2026-12-31T23:30", night.clone())["is_open"], true);
        assert_eq!(open_with_exceptions("2026-12-31T21:00", night)["is_open"], false);
    }
}
