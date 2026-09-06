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
//! válida por el zero-padding). Rechazos de negocio = **`DomainError`** (hub#139): un
//! código ESTABLE y namespaced (`schedules.<snake_case>`) que la UI traduce contra el
//! bloque `errors` de `locales/{en,es}.json` — `invalid_hours` / `invalid_break` /
//! `missing_hours` / `invalid_range` / `already_exists` / `invalid_day` / `invalid_date` /
//! `missing_name` / `missing_items` / `overlapping` — con una frase EN de fallback que
//! conserva los valores conflictivos (para logs y clientes sin catálogo). Antes de
//! schedules#28 el handler fallaba con `Err("código: detalle")` y el runtime lo envolvía
//! en su plumbing («error de handler WASM: wasm call to … failed:»), mitad EN mitad ES.

use erplora_guest_sdk::{DomainError, Event, Operation, Output};
use serde_json::{json, Map, Value};

#[cfg(feature = "guest")]
use extism_pdk::*;

// ── Exports WASM ───────────────────────────────────────────────────────────

/// A refusal is a VALID answer (an `Output` with `error`), not a fault of the plugin: the
/// host surfaces the code (409) without the WASM plumbing. Only contract violations with the
/// host itself (a missing `context.new_ids` the runtime always delivers) stay on the `Err`
/// path — a bug to fix, not a sentence for the user.
#[cfg(feature = "guest")]
fn to_fn_result(r: Result<Output, String>) -> FnResult<Json<Output>> {
    match r {
        Ok(out) => Ok(Json(out)),
        Err(e) => Err(Error::msg(e).into()),
    }
}

#[cfg(feature = "guest")]
#[plugin_fn]
pub fn is_open(input: Json<erplora_guest_sdk::Input>) -> FnResult<Json<Output>> {
    to_fn_result(is_open_pure(input.into_inner().into_value()))
}

#[cfg(feature = "guest")]
#[plugin_fn]
pub fn bulk_create_special_days(input: Json<erplora_guest_sdk::Input>) -> FnResult<Json<Output>> {
    to_fn_result(bulk_create_special_days_pure(
        input.into_inner().into_value(),
    ))
}

#[cfg(feature = "guest")]
#[plugin_fn]
pub fn set_business_hours(input: Json<erplora_guest_sdk::Input>) -> FnResult<Json<Output>> {
    to_fn_result(set_business_hours_pure(input.into_inner().into_value()))
}

#[cfg(feature = "guest")]
#[plugin_fn]
pub fn confirm_business_hours(input: Json<erplora_guest_sdk::Input>) -> FnResult<Json<Output>> {
    to_fn_result(confirm_business_hours_pure(input.0.into_value()))
}

#[cfg(feature = "guest")]
#[plugin_fn]
pub fn create_special_day(input: Json<erplora_guest_sdk::Input>) -> FnResult<Json<Output>> {
    to_fn_result(create_special_day_pure(input.into_inner().into_value()))
}

#[cfg(feature = "guest")]
#[plugin_fn]
pub fn create_override(input: Json<erplora_guest_sdk::Input>) -> FnResult<Json<Output>> {
    to_fn_result(create_override_pure(input.into_inner().into_value()))
}

// ── Helpers (mismo estilo que kitchen-handler) ─────────────────────────────

/// schedules#28: a business refusal the caller can act on (hub#139). The code is stable and
/// namespaced (`schedules.<snake_case>`); the UI paints the TRANSLATION of that code (the
/// `errors` block of `locales/{en,es}.json`) and `message` is only the English fallback —
/// it keeps the offending values for logs and clients without the catalog. Replaces the old
/// `Err("code: detail")`, whose runtime wrapping («error de handler WASM: wasm call to …
/// failed:») and half-English text is exactly what schedules#28 came to fix.
fn domain(code: &str, message: impl std::fmt::Display) -> DomainError {
    DomainError::new(format!("schedules.{code}"), message.to_string())
}

/// The refusal IS the answer: an output with `error`, no operations, no events. The host
/// aborts the command and surfaces the code (409) — never the WASM plumbing.
fn refused(e: DomainError) -> Output {
    Output::new().with_error(e)
}

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
        Value::Number(n) => n
            .as_i64()
            .unwrap_or_else(|| n.as_f64().map(|f| f as i64).unwrap_or(d)),
        Value::String(s) => s.trim().parse::<i64>().unwrap_or(d),
        _ => d,
    }
}

fn str_or(p: &Value, k: &str, d: &str) -> String {
    let s = as_str(p.get(k).unwrap_or(&Value::Null));
    if s.is_empty() {
        d.to_string()
    } else {
        s
    }
}

/// String opcional: '' o ausente → None.
fn opt_str(p: &Value, k: &str) -> Option<String> {
    let s = as_str(p.get(k).unwrap_or(&Value::Null));
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
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
    let digits = b[0].is_ascii_digit()
        && b[1].is_ascii_digit()
        && b[3].is_ascii_digit()
        && b[4].is_ascii_digit();
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
        2 => {
            if is_leap_year(y) {
                29
            } else {
                28
            }
        }
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
    if !b.iter().enumerate().all(|(i, c)| {
        if i == 4 || i == 7 {
            true
        } else {
            c.is_ascii_digit()
        }
    }) {
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

/// Serializa el veredicto por el canal `result` del contrato (hub#70).
fn output_with_result(out: Output, result: Value) -> Output {
    out.with_result(result)
}

// ── Validación de horas (WASM-TODO §3) ─────────────────────────────────────

/// Valida el par open/close cuando el día está abierto. `close > open` estricto.
fn check_hours(open: &str, close: &str) -> Result<(), DomainError> {
    if !valid_time(open) || !valid_time(close) {
        return Err(domain(
            "invalid_hours",
            format!("Invalid time format (open='{open}', close='{close}', expected HH:MM)"),
        ));
    }
    if close <= open {
        return Err(domain(
            "invalid_hours",
            format!("close_time ({close}) must be after open_time ({open})"),
        ));
    }
    Ok(())
}

/// Valida el descanso: `break_end > break_start` y dentro de `[open, close]`.
fn check_break(open: &str, close: &str, bs: &str, be: &str) -> Result<(), DomainError> {
    if !valid_time(bs) || !valid_time(be) {
        return Err(domain(
            "invalid_break",
            format!("Invalid break format (break_start='{bs}', break_end='{be}', expected HH:MM)"),
        ));
    }
    if be <= bs {
        return Err(domain(
            "invalid_break",
            format!("break_end ({be}) must be after break_start ({bs})"),
        ));
    }
    if bs < open || be > close {
        return Err(domain(
            "invalid_break",
            format!("The break ({bs}–{be}) must fit inside the opening hours ({open}–{close})"),
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

fn validate_special_day(item: &Value) -> Result<SpecialDayItem, DomainError> {
    let date = str_or(item, "date", "");
    if !valid_date(&date) {
        return Err(domain(
            "invalid_date",
            format!("Invalid date '{date}' (expected YYYY-MM-DD, a real calendar date)"),
        ));
    }
    let name = str_or(item, "name", "");
    if name.trim().is_empty() {
        return Err(domain("missing_name", "A special day needs a name"));
    }
    let is_closed = bool_or(item, "is_closed", true);
    let mut open_time = opt_str(item, "open_time");
    let mut close_time = opt_str(item, "close_time");
    let mut intervals: Vec<Interval> = Vec::new();
    if !is_closed {
        intervals = match exception_intervals_from_payload(item) {
            Ok(v) => v,
            Err(e) => return Err(e),
        };
        if intervals.is_empty() {
            return Err(domain(
                "missing_hours",
                "An open special day needs at least one opening interval",
            ));
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
    p.insert(
        "open_time".into(),
        it.open_time
            .clone()
            .map(Value::String)
            .unwrap_or(Value::Null),
    );
    p.insert(
        "close_time".into(),
        it.close_time
            .clone()
            .map(Value::String)
            .unwrap_or(Value::Null),
    );
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
    intervals
        .iter()
        .map(|i| json!({ "open_time": i.open, "close_time": i.close }))
        .collect()
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

/// The hub's own weekly hours, special days, overrides and exception intervals, pre-loaded by the
/// runtime for `schedules.is_open` (schedules#1). Before this the caller passed them in the
/// payload, so two consumers could get different answers for the same hub and instant.
const BUSINESS_HOURS_READ: &str = "schedules.business_hours.list";
const SPECIAL_DAYS_READ: &str = "schedules.special_days.list";
const OVERRIDES_READ: &str = "schedules.overrides.list";
const EXCEPTION_INTERVALS_READ: &str = "schedules.exception_intervals.list";

/// Rows of a pre-loaded read, if the runtime delivered it (present even when empty).
fn read_rows<'a>(input: &'a Value, name: &str) -> Option<&'a Vec<Value>> {
    input
        .get("context")
        .and_then(|c| c.get("reads"))
        .and_then(|r| r.get(name))
        .and_then(|v| v.as_array())
}

/// Dates already taken by a live special day. Prefers the authoritative reads (`by_date` for
/// the single create, `dates` for the bulk); only when neither is present (old manifest / query
/// failed) it degrades to the client hint `existing_dates`.
fn taken_special_day_dates(input: &Value, payload: &Value) -> Vec<String> {
    match read_rows(input, SPECIAL_DAY_BY_DATE_READ)
        .or_else(|| read_rows(input, SPECIAL_DAY_DATES_READ))
    {
        Some(rows) => rows
            .iter()
            .map(|r| str_or(r, "date", ""))
            .filter(|d| !d.is_empty())
            .collect(),
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

fn check_interval(it: &Interval) -> Result<(), DomainError> {
    if !valid_time(&it.open) || !valid_time(&it.close) {
        return Err(domain(
            "invalid_hours",
            format!(
                "Invalid time format (open='{}', close='{}', expected HH:MM)",
                it.open, it.close
            ),
        ));
    }
    if it.open == it.close && !it.is_all_day() {
        return Err(domain(
            "invalid_hours",
            format!(
                "An interval cannot be empty ({}–{}); use 00:00–00:00 for open 24 hours",
                it.open, it.close
            ),
        ));
    }
    Ok(())
}

/// Reads an `intervals[]` array as it travels in a payload.
fn intervals_of_array(arr: &[Value]) -> Vec<Interval> {
    arr.iter()
        .map(|it| Interval {
            open: str_or(it, "open_time", ""),
            close: str_or(it, "close_time", ""),
        })
        .collect()
}

/// Validates, sorts and rejects overlaps in a set of intervals — the SAME rules for the weekly
/// hours (schedules#8) and for the exceptions (schedules#23): order does not matter to the caller,
/// two intervals may not cover the same minute, `close < open` crosses midnight and `00:00–00:00`
/// is 24 hours.
fn normalize_intervals(mut items: Vec<Interval>) -> Result<Vec<Interval>, DomainError> {
    for it in &items {
        check_interval(it)?;
    }
    items.sort_by(|a, b| a.span().0.cmp(&b.span().0));
    // Overlaps: consecutive spans on the same day; and an overnight tail wraps into the first
    // interval of the morning — a 22:00–02:00 next to a 01:00 start is a clash.
    for w in items.windows(2) {
        let (a, b) = (&w[0], &w[1]);
        if b.span().0 < a.span().1 {
            return Err(domain(
                "overlapping",
                format!(
                    "intervals {}–{} and {}–{} overlap",
                    a.open, a.close, b.open, b.close
                ),
            ));
        }
    }
    if items.len() > 1 {
        let last = items.last().unwrap();
        let first = items.first().unwrap();
        if last.span().1 > 1440 && (last.span().1 - 1440) > first.span().0 {
            return Err(domain(
                "overlapping",
                format!(
                    "the overnight interval {}–{} runs into {}–{}",
                    last.open, last.close, first.open, first.close
                ),
            ));
        }
    }
    Ok(items)
}

/// The intervals of a weekday from the payload (schedules#8). Accepts the new `intervals[]`
/// and, for old callers, the legacy `open_time`/`close_time` + optional break, which becomes
/// one or two intervals ([open,break_start] + [break_end,close]). Validated, sorted, and
/// checked for overlaps (through midnight too).
fn intervals_from_payload(payload: &Value) -> Result<Vec<Interval>, DomainError> {
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
                    vec![
                        Interval {
                            open,
                            close: bs.clone(),
                        },
                        Interval { open: be, close },
                    ]
                }
                _ => {
                    return Err(domain(
                        "invalid_break",
                        "A break needs both break_start and break_end (or neither)",
                    ))
                }
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
fn exception_intervals_from_payload(payload: &Value) -> Result<Vec<Interval>, DomainError> {
    match payload.get("intervals").and_then(|v| v.as_array()) {
        Some(arr) => normalize_intervals(intervals_of_array(arr)),
        None => match (
            opt_str(payload, "open_time"),
            opt_str(payload, "close_time"),
        ) {
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
pub fn set_business_hours_pure(input: Value) -> Result<Output, String> {
    let payload = input.get("payload").cloned().unwrap_or(Value::Null);
    let new_ids = new_ids_of(&input);

    let dow = as_i64(payload.get("day_of_week").unwrap_or(&Value::Null), -1);
    if !(0..=6).contains(&dow) {
        return Ok(refused(domain(
            "invalid_day",
            format!("day_of_week must be between 0 (Monday) and 6 (Sunday), got {dow}"),
        )));
    }
    let is_closed = bool_or(&payload, "is_closed", false);
    let intervals = if is_closed {
        Vec::new()
    } else {
        match intervals_from_payload(&payload) {
            Ok(v) => v,
            Err(e) => return Ok(refused(e)),
        }
    };
    if !is_closed && intervals.is_empty() {
        return Ok(refused(domain(
            "missing_hours",
            "An open day needs at least one opening interval (open_time/close_time)",
        )));
    }

    let mut clear = Map::new();
    clear.insert("day_of_week".into(), json!(dow));
    let mut out =
        Output::new().with_operation(Operation::sql("schedules._clear_business_hours_day", clear));

    let row =
        |id: Value, position: usize, open: &str, close: &str, closed: bool| -> Map<String, Value> {
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
        let id = new_ids
            .first()
            .cloned()
            .ok_or_else(|| "missing_id: no id available".to_string())?;
        out = out.with_operation(Operation::sql(
            "schedules._insert_business_hours",
            row(id, 0, "00:00", "00:00", true),
        ));
    } else {
        for (i, it) in intervals.iter().enumerate() {
            let id = new_ids
                .get(i)
                .cloned()
                .ok_or_else(|| "missing_id: too many intervals for one day".to_string())?;
            out = out.with_operation(Operation::sql(
                "schedules._insert_business_hours",
                row(id, i, &it.open, &it.close, false),
            ));
        }
    }

    let event_intervals: Vec<Value> = intervals
        .iter()
        .map(|i| json!({ "open_time": i.open, "close_time": i.close }))
        .collect();
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
    Ok(out)
}

/// schedules#43 — the business SIGNS the week it is already looking at, in one gesture.
///
/// `queries/setup_status.sql` ticks the onboarding step «Confirm your opening hours» by counting
/// the live rows whose `created_by` is NOT the installer's `system`. A salon whose real week IS the
/// one schedules#36 seeded therefore had nothing to press: the only way to sign the week was to
/// open some day and save it back UNCHANGED, which is exactly the gesture nobody understands.
///
/// So this command does what saving the seven days one by one does — `_clear_business_hours_day`
/// + one `_insert_business_hours` per interval, stamped by the host with the real
/// `:current_user_id` — for the WHOLE week and in ONE transaction. Seven chained dispatches from
/// the browser would leave a half-signed week behind the first failure.
///
/// **It changes nothing but the signature.** Every value of every row travels over verbatim
/// (hours, `is_closed`, and the legacy break of a pre-schedules#8 row); only `position` is
/// renumbered from 0 so the editor paints the day in order. The rows come from
/// `context.reads` (ADR-0069), never from the payload: the browser cannot dictate the week it is
/// about to sign.
pub fn confirm_business_hours_pure(input: Value) -> Result<Output, String> {
    let new_ids = new_ids_of(&input);
    let empty: Vec<Value> = Vec::new();
    let rows = read_rows(&input, BUSINESS_HOURS_READ).unwrap_or(&empty);

    // Nothing to sign. Answering «done» over an empty table would tick the checklist step on a hub
    // with NO hours — the very state the seed of schedules#36 exists to make unreachable.
    if rows.is_empty() {
        return Ok(refused(domain(
            "missing_hours",
            "There are no weekly opening hours to confirm",
        )));
    }

    // `business_hours_list.sql` carries no ORDER BY and the list engine only sorts by
    // `day_of_week`, so the intervals of one day arrive in whatever order the planner chose.
    let mut live: Vec<&Value> = rows.iter().collect();
    live.sort_by_key(|r| {
        (
            as_i64(r.get("day_of_week").unwrap_or(&Value::Null), -1),
            as_i64(r.get("position").unwrap_or(&Value::Null), 0),
        )
    });
    if let Some(bad) = live
        .iter()
        .map(|r| as_i64(r.get("day_of_week").unwrap_or(&Value::Null), -1))
        .find(|d| !(0..=6).contains(d))
    {
        return Ok(refused(domain(
            "invalid_day",
            format!("the week holds a row whose day_of_week is {bad}, outside 0 (Monday)–6 (Sunday)"),
        )));
    }

    let mut out = Output::new();
    let mut taken = 0usize;
    let mut confirmed_days = 0i64;
    let mut start = 0usize;
    while start < live.len() {
        let day = as_i64(live[start].get("day_of_week").unwrap_or(&Value::Null), -1);
        let mut end = start;
        while end < live.len()
            && as_i64(live[end].get("day_of_week").unwrap_or(&Value::Null), -1) == day
        {
            end += 1;
        }

        let mut clear = Map::new();
        clear.insert("day_of_week".into(), json!(day));
        out = out.with_operation(Operation::sql("schedules._clear_business_hours_day", clear));

        let mut intervals: Vec<Value> = Vec::new();
        let mut day_is_closed = false;
        for (position, row) in live[start..end].iter().enumerate() {
            // The guest is not an authority of ids (§5.3): inventing one would collide on the
            // primary key and roll the whole confirmation back with a plumbing error.
            let id = new_ids.get(taken).cloned().ok_or_else(|| {
                "missing_id: the host's batch is shorter than the week to confirm".to_string()
            })?;
            taken += 1;
            let closed = as_bool(row.get("is_closed").unwrap_or(&Value::Null));
            let open = str_or(row, "open_time", "00:00");
            let close = str_or(row, "close_time", "00:00");
            let mut p = Map::new();
            p.insert("id".into(), id);
            p.insert("day_of_week".into(), json!(day));
            p.insert("position".into(), json!(position as i64));
            p.insert("open_time".into(), json!(open));
            p.insert("close_time".into(), json!(close));
            p.insert("is_closed".into(), json!(closed as i64));
            // The legacy pair still holds the break of a row written before schedules#8. Writing
            // NULL here would take a lunch break away from a business that only said «yes».
            p.insert(
                "break_start".into(),
                opt_str(row, "break_start").map_or(Value::Null, Value::String),
            );
            p.insert(
                "break_end".into(),
                opt_str(row, "break_end").map_or(Value::Null, Value::String),
            );
            out = out.with_operation(Operation::sql("schedules._insert_business_hours", p));
            if closed {
                day_is_closed = true;
            } else {
                intervals.push(json!({ "open_time": open, "close_time": close }));
            }
        }

        // One `updated` event per day: a listener must not be able to tell confirming the week
        // from saving its seven days by hand, which is what this command is.
        out = out.with_event(Event::new(
            "schedules.business_hours.updated",
            json!({
                "sender": "schedules",
                "day_of_week": day,
                "is_closed": day_is_closed as i64,
                "intervals": intervals,
                // Legacy fields (first/last bound) for listeners that still read them.
                "open_time": intervals.first().map(|i| as_str(&i["open_time"])).unwrap_or_default(),
                "close_time": intervals.last().map(|i| as_str(&i["close_time"])).unwrap_or_default(),
            }),
        ));
        confirmed_days += 1;
        start = end;
    }

    Ok(output_with_result(
        out,
        json!({ "confirmed_days": confirmed_days }),
    ))
}

// ── schedules.special_days.create (fn create_special_day) ─────────────────

/// Alta validada de un día especial (WASM-TODO §3). `already_exists` se comprueba
/// contra `existing_dates` (si el caller las pasa); el índice único es el backstop.
///
/// schedules#23: an open special day now writes 0..N `schedules_exception_interval` rows — a
/// holiday with a split shift (10–13 and 17–19) is one day and two intervals, not two days.
pub fn create_special_day_pure(input: Value) -> Result<Output, String> {
    let payload = input.get("payload").cloned().unwrap_or(Value::Null);
    let item = match validate_special_day(&payload) {
        Ok(i) => i,
        Err(e) => return Ok(refused(e)),
    };
    if taken_special_day_dates(&input, &payload).contains(&item.date) {
        return Ok(refused(domain(
            "already_exists",
            format!("A special day already exists on {}", item.date),
        )));
    }
    let new_ids = new_ids_of(&input);
    let day_id = new_ids
        .first()
        .cloned()
        .ok_or_else(|| "missing_id: no id available".to_string())?;
    let mut params = special_day_params(&item);
    params.insert("id".into(), day_id.clone());
    let out = Output::new().with_operation(Operation::sql("schedules._insert_special_day", params));
    let out = exception_interval_ops(out, "special_day", &day_id, &item.intervals, &new_ids)?;
    let out = out.with_event(special_day_event(&item));
    Ok(out)
}

// ── schedules.overrides.create (fn create_override) ───────────────────────

/// Validated schedule override (WASM-TODO §3): `end_date >= start_date` and, when the
/// override is open (`is_closed=0`), BOTH hours are required with `close > open`
/// (schedules#7: an open override without hours used to be read as "open 24h").
pub fn create_override_pure(input: Value) -> Result<Output, String> {
    let payload = input.get("payload").cloned().unwrap_or(Value::Null);

    let start_date = str_or(&payload, "start_date", "");
    let end_date = str_or(&payload, "end_date", "");
    if !valid_date(&start_date) || !valid_date(&end_date) {
        return Ok(refused(domain(
            "invalid_date",
            format!("Invalid dates (start='{start_date}', end='{end_date}', expected YYYY-MM-DD)"),
        )));
    }
    if end_date < start_date {
        return Ok(refused(domain(
            "invalid_range",
            format!("end_date ({end_date}) must not be before start_date ({start_date})"),
        )));
    }
    let reason = str_or(&payload, "reason", "");
    if reason.trim().is_empty() {
        return Ok(refused(domain(
            "missing_name",
            "An override needs a reason",
        )));
    }
    let is_closed = bool_or(&payload, "is_closed", false);
    // schedules#23: an open override carries 0..N intervals (a summer split shift is one override
    // with two intervals). The legacy single pair still arrives as the one interval 0.
    let intervals = if is_closed {
        Vec::new()
    } else {
        match exception_intervals_from_payload(&payload) {
            Ok(v) => v,
            Err(e) => return Ok(refused(e)),
        }
    };
    if !is_closed && intervals.is_empty() {
        return Ok(refused(domain(
            "missing_hours",
            "An open override needs at least one opening interval",
        )));
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
            return Ok(refused(domain(
                "overlapping",
                format!(
                    "the range {start_date}..{end_date} overlaps the override '{}' ({}..{})",
                    str_or(ov, "reason", ""),
                    str_or(ov, "start_date", ""),
                    str_or(ov, "end_date", "")
                ),
            )));
        }
    }

    let new_ids = new_ids_of(&input);
    let override_id = new_ids
        .first()
        .cloned()
        .ok_or_else(|| "missing_id: no id available".to_string())?;

    let mut p = Map::new();
    p.insert("id".into(), override_id.clone());
    p.insert("start_date".into(), json!(start_date));
    p.insert("end_date".into(), json!(end_date));
    p.insert("reason".into(), json!(reason.trim()));
    p.insert(
        "open_time".into(),
        open_time.clone().map(Value::String).unwrap_or(Value::Null),
    );
    p.insert(
        "close_time".into(),
        close_time.clone().map(Value::String).unwrap_or(Value::Null),
    );
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
    Ok(out)
}

// ── schedules.bulk_create_special_days (fn bulk_create_special_days) ──────

/// Alta en lote tolerante a fallos (WASM-TODO §4): valida cada item, dedupe por
/// fecha (dentro del lote y contra `existing_dates`), acumula `errors[]` sin
/// abortar el resto y emite un `_insert` (ON CONFLICT DO NOTHING) por item válido.
pub fn bulk_create_special_days_pure(input: Value) -> Result<Output, String> {
    let payload = input.get("payload").cloned().unwrap_or(Value::Null);
    let empty: Vec<Value> = Vec::new();
    let items = payload
        .get("special_days")
        .and_then(|v| v.as_array())
        .unwrap_or(&empty);
    if items.is_empty() {
        return Ok(refused(domain(
            "missing_items",
            "special_days must be a non-empty list",
        )));
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
            // The per-item error is the CODE (namespaced, translatable by the caller against
            // the same `errors` catalog); the offending date/name travel in the item itself.
            Err(e) => errors.push(json!({ "date": date, "name": name, "error": e.code })),
            Ok(it) => {
                if existing.contains(&it.date) {
                    errors.push(json!({
                        "date": it.date, "name": it.name,
                        "error": domain("already_exists", format!("A special day already exists on {}", it.date)).code,
                    }));
                } else if seen.contains(&it.date) {
                    errors.push(json!({
                        "date": it.date, "name": it.name,
                        "error": domain("already_exists", format!("Date {} is duplicated inside the batch", it.date)).code,
                    }));
                } else {
                    seen.push(it.date.clone());
                    out = out
                        .with_operation(Operation::sql(
                            "schedules._insert_special_day_skip",
                            special_day_params(&it),
                        ))
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

/// Rows the engine evaluates: the runtime's pre-loaded read when it is there — authoritative,
/// the hub's own rows — and the payload only while a hub still runs a manifest without `reads`.
/// The moment the read arrives (even empty) the payload copy is ignored: a caller says WHEN, not
/// what the schedule is.
fn engine_rows<'a>(input: &'a Value, payload: &'a Value, read: &str, key: &str) -> &'a [Value] {
    if let Some(rows) = read_rows(input, read) {
        return rows.as_slice();
    }
    payload
        .get(key)
        .and_then(|v| v.as_array())
        .map(|rows| rows.as_slice())
        .unwrap_or(&[])
}

/// THE BUSINESS CLOCK (schedules#1, hub#731, hub#1022). The core owns the hub's zone — declared
/// in its settings or deduced from country/region — and hands it to the handler already resolved
/// as an IANA name in `context.timezone`.
///
/// Anything the calendar does not know (an old runtime that sends nothing, a forged context)
/// degrades to UTC, the same fallback the core itself makes. The degradation is never silent:
/// the verdict carries the zone it was computed with.
fn business_timezone(context: &Value) -> chrono_tz::Tz {
    context
        .get("timezone")
        .map(as_str)
        .unwrap_or_default()
        .parse()
        .unwrap_or(chrono_tz::UTC)
}

/// The wall clock the rules are read with, as `(YYYY-MM-DD, HH:MM)` of the business.
///
/// Two shapes, one rule each — this is the module's public contract:
/// * with an offset (`…Z`, `…+02:00`) `when` is an **instant** and gets converted to `tz`;
/// * without one it already IS the shop's wall clock («next Thursday at 18:30») and is read as
///   written, so a caller can ask about a moment without doing timezone arithmetic itself.
///
/// `None` for anything else: the caller gets `invalid_date` instead of a verdict computed on a
/// date nobody meant.
fn wall_clock(when: &str, tz: chrono_tz::Tz) -> Option<(String, String)> {
    if let Ok(instant) = chrono::DateTime::parse_from_rfc3339(when) {
        let local = instant.with_timezone(&tz);
        return Some((
            local.format("%Y-%m-%d").to_string(),
            local.format("%H:%M").to_string(),
        ));
    }
    // `get` and not `[..]`: a slice through the middle of a multi-byte character panics, and this
    // string comes from outside.
    let date = when.get(..10)?.to_string();
    let time = when.get(11..16)?.to_string();
    (valid_date(&date) && valid_time(&time)).then_some((date, time))
}

/// Motor "¿está abierto ahora?" (WASM-TODO §1). Precedencia estricta:
/// SpecialDay (fecha exacta o `recurring_yearly` por MM-DD) → ScheduleOverride
/// (rango que cubre hoy) → BusinessHours (día de la semana, con descanso) →
/// sin configuración (`fail_open` decide). Solo-lectura: no emite intenciones;
/// el veredicto va por el canal `result` del Output (hub#70).
///
/// schedules#28: el veredicto es DATOS, no prosa. Lleva un `code` ESTABLE que el
/// llamador redacta en su idioma (`exception_closed` / `exception_hours` /
/// `open_interval` / `on_break` / `closed_today` / `overnight_open` /
/// `outside_hours` / `no_hours` / `no_hours_fail_open`), con `intervals`
/// («HH:MM–HH:MM») cuando los tramos explican el veredicto. `reason` SOLO existe
/// cuando es dato del usuario: el nombre del día especial o el motivo del
/// override que ganaron — nunca una frase horneada dentro del WASM.
pub fn is_open_pure(input: Value) -> Result<Output, String> {
    let payload = input.get("payload").cloned().unwrap_or(Value::Null);
    let context = input.get("context").cloned().unwrap_or(Value::Null);

    // THE BUSINESS CLOCK (schedules#1). The zone belongs to the core (hub#731) and reaches the
    // handler already resolved in `context.timezone` (hub#1022); the caller only says WHEN.
    let tz = business_timezone(&context);
    // `when` optional — an RFC3339 instant or a bare `YYYY-MM-DDTHH:MM` of the shop's own clock;
    // by default `context.now`, which is UTC and therefore always gets converted.
    let when = opt_str(&payload, "when")
        .unwrap_or_else(|| context.get("now").map(as_str).unwrap_or_default());
    let Some((today, current_time)) = wall_clock(&when, tz) else {
        let detail =
            format!("Invalid 'when' ('{when}', expected an RFC3339 instant or YYYY-MM-DDTHH:MM)");
        return Ok(refused(domain("invalid_date", detail)));
    };

    // THE RULES ARE THE HUB'S, NOT THE CALLER'S (schedules#1). They arrive pre-loaded by the
    // runtime (`reads`, ADR-0069); the payload rows are only read while a hub still runs a
    // manifest without them, and a caller can no longer forge a schedule it does not have.
    let special_days = engine_rows(&input, &payload, SPECIAL_DAYS_READ, "special_days");
    let overrides = engine_rows(&input, &payload, OVERRIDES_READ, "overrides");
    let business_hours = engine_rows(&input, &payload, BUSINESS_HOURS_READ, "business_hours");
    // schedules#23: rows of `schedules.exception_intervals.list` — the 0..N intervals of the
    // special days and overrides above. Absent (exception written before migration 003, day
    // created by the bulk) → the pair on the exception row still decides.
    let exception_intervals = engine_rows(
        &input,
        &payload,
        EXCEPTION_INTERVALS_READ,
        "exception_intervals",
    );

    let t = current_time.as_str();
    let now_min = minutes(t);
    // The verdict says WHICH rule won (schedules#8): `source` ∈ special_day | override |
    // business_hours | none, `rule_id` = the row that decided (when there is one), `code` = the
    // stable machine reason, `intervals` = the spans that explain it, and `reason` = user data
    // (the winning exception's own name/reason) — only when there is any.
    let done = |is_open: bool,
                code: &str,
                reason: &str,
                source: &str,
                rule_id: Value,
                intervals: &[String]|
     -> Result<Output, String> {
        let mut verdict = json!({ "is_open": is_open, "code": code, "intervals": intervals,
                "today": today, "current_time": current_time, "source": source, "rule_id": rule_id,
                // The clock the verdict was computed with, so a caller (and a support ticket)
                // never has to guess which zone answered.
                "timezone": tz.name() });
        if !reason.is_empty() {
            verdict["reason"] = json!(reason);
        }
        Ok(output_with_result(Output::new(), verdict))
    };
    let id_of = |r: &Value| -> Value { r.get("id").cloned().unwrap_or(Value::Null) };
    // Intervals belonging to one exception, in `position` order (schedules#23).
    let intervals_of = |kind: &str, id: &Value| -> Vec<Interval> {
        let owner = as_str(id);
        let mut rows: Vec<&Value> = exception_intervals
            .iter()
            .filter(|r| {
                str_or(r, "exception_kind", "") == kind && str_or(r, "exception_id", "") == owner
            })
            .collect();
        rows.sort_by_key(|r| as_i64(r.get("position").unwrap_or(&Value::Null), 0));
        rows.iter()
            .map(|r| Interval {
                open: str_or(r, "open_time", "00:00"),
                close: str_or(r, "close_time", "00:00"),
            })
            .collect()
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
    let spans = |its: &[Interval]| -> Vec<String> {
        its.iter()
            .map(|i| format!("{}–{}", i.open, i.close))
            .collect()
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
            return done(false, "exception_closed", &name, "special_day", id, &[]);
        }
        let intervals = intervals_of("special_day", &id);
        if !intervals.is_empty() {
            let its = spans(&intervals);
            return done(
                intervals.iter().any(covers),
                "exception_hours",
                &name,
                "special_day",
                id,
                &its,
            );
        }
        return match (opt_str(sd, "open_time"), opt_str(sd, "close_time")) {
            (Some(o), Some(c)) => done(
                t >= o.as_str() && t < c.as_str(),
                "exception_hours",
                &name,
                "special_day",
                id,
                &[format!("{o}–{c}")],
            ),
            // SpecialDay abierto sin horas = abierto todo el día (tramos vacíos).
            _ => done(true, "exception_hours", &name, "special_day", id, &[]),
        };
    }

    // 2) ScheduleOverride que cubre hoy (start_date <= hoy <= end_date).
    if let Some(ov) = overrides.iter().find(|r| {
        let s = str_or(r, "start_date", "");
        let e = str_or(r, "end_date", "");
        !s.is_empty()
            && !e.is_empty()
            && s.as_str() <= today.as_str()
            && today.as_str() <= e.as_str()
    }) {
        let reason = str_or(ov, "reason", "Schedule override");
        let id = id_of(ov);
        if bool_or(ov, "is_closed", false) {
            return done(false, "exception_closed", &reason, "override", id, &[]);
        }
        let intervals = intervals_of("override", &id);
        if !intervals.is_empty() {
            let its = spans(&intervals);
            return done(
                intervals.iter().any(covers),
                "exception_hours",
                &reason,
                "override",
                id,
                &its,
            );
        }
        return match (opt_str(ov, "open_time"), opt_str(ov, "close_time")) {
            (Some(o), Some(c)) => done(
                t >= o.as_str() && t < c.as_str(),
                "exception_hours",
                &reason,
                "override",
                id,
                &[format!("{o}–{c}")],
            ),
            _ => done(true, "exception_hours", &reason, "override", id, &[]),
        };
    }

    // 3) Weekly hours: EVERY row of the weekday is an interval (schedules#8) — split shifts are
    //    several rows; a row with `is_closed` closes the day; legacy rows may still carry a break.
    //    An overnight interval of YESTERDAY (22:00–02:00) reaches into this morning.
    let dow = match weekday_iso0(&today) {
        Some(d) => d,
        None => {
            return Ok(refused(domain(
                "invalid_date",
                format!("Invalid date '{today}'"),
            )))
        }
    };
    let rows_for = |d: i64| -> Vec<&Value> {
        business_hours
            .iter()
            .filter(|r| as_i64(r.get("day_of_week").unwrap_or(&Value::Null), -1) == d)
            .collect()
    };
    let todays = rows_for(dow);
    let now_min = minutes(t);
    let interval_of = |r: &Value| Interval {
        open: str_or(r, "open_time", "00:00"),
        close: str_or(r, "close_time", "00:00"),
    };
    // Yesterday's overnight interval (22:00–02:00) that still covers this moment, if any.
    let overnight_from_yesterday = || -> Option<&Value> {
        rows_for((dow + 6) % 7).into_iter().find(|r| {
            let it = interval_of(r);
            !bool_or(r, "is_closed", false) && it.is_overnight() && now_min < it.span().1 - 1440
        })
    };
    let overnight_span = |y: &Value| -> Vec<String> {
        let it = interval_of(y);
        vec![format!("{}–{}", it.open, it.close)]
    };
    if !todays.is_empty() {
        if let Some(closed) = todays.iter().find(|r| bool_or(r, "is_closed", false)) {
            // Even on a closed day, yesterday's overnight tail may still be open.
            if let Some(y) = overnight_from_yesterday() {
                return done(
                    true,
                    "overnight_open",
                    "",
                    "business_hours",
                    id_of(y),
                    &overnight_span(y),
                );
            }
            return done(
                false,
                "closed_today",
                "",
                "business_hours",
                id_of(closed),
                &[],
            );
        }
        let mut described: Vec<String> = Vec::new();
        for r in &todays {
            let it = interval_of(r);
            let (start, end) = it.span();
            let bs = opt_str(r, "break_start");
            let be = opt_str(r, "break_end");
            let in_span = it.is_all_day() || (now_min >= start && now_min < end);
            let on_break =
                matches!((&bs, &be), (Some(bs), Some(be)) if t >= bs.as_str() && t < be.as_str());
            if in_span && !on_break {
                return done(
                    true,
                    "open_interval",
                    "",
                    "business_hours",
                    id_of(r),
                    &[format!("{}–{}", it.open, it.close)],
                );
            }
            if in_span && on_break {
                return done(false, "on_break", "", "business_hours", id_of(r), &[]);
            }
            described.push(format!("{}–{}", it.open, it.close));
        }
        if let Some(y) = overnight_from_yesterday() {
            return done(
                true,
                "overnight_open",
                "",
                "business_hours",
                id_of(y),
                &overnight_span(y),
            );
        }
        let first = todays[0];
        return done(
            false,
            "outside_hours",
            "",
            "business_hours",
            id_of(first),
            &described,
        );
    }
    // No rows today: yesterday's overnight interval may still cover this moment.
    if let Some(y) = overnight_from_yesterday() {
        return done(
            true,
            "overnight_open",
            "",
            "business_hours",
            id_of(y),
            &overnight_span(y),
        );
    }

    // 4) Nothing configured for today. The answer is the DOMAIN's, not the caller's (schedules#1):
    //    with no rule for that day the business is not declared open, and the stable code
    //    `no_hours` tells a consumer that this is «nothing configured», not «closed today» — so
    //    an appointments screen can offer to set the hours instead of showing a shut door.
    done(false, "no_hours", "", "none", Value::Null, &[])
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

    /// schedules#28: a business refusal is an Ok Output carrying `error` (hub#139) — never an
    /// `Err`, whose runtime wrapping is exactly the plumbing schedules#28 removed. The bare code
    /// (without the `schedules.` namespace) keeps the older assertions readable; the FULL
    /// namespaced codes are pinned by the schedules#28 tests above.
    fn err_code(r: Result<Output, String>) -> String {
        let out = r.expect("a refusal is an Ok output, not an Err");
        out.error
            .as_ref()
            .expect("the output refuses")
            .code
            .strip_prefix("schedules.")
            .unwrap_or("")
            .to_string()
    }

    // ── schedules#28: every business refusal is a DomainError, not an Err(String) ──────────
    //
    // The eight rejections of the issue arrived on screen wrapped in the runtime's plumbing
    // ("error de handler WASM: wasm call to `set_business_hours` failed: …") and in a mix of
    // English and Spanish, because the handler FAILED with `"code: detail"` instead of answering
    // with the structured error channel (hub#139). These tests pin the contract the UI depends
    // on: a refusal is an Ok Output whose `error.code` is stable and namespaced (`schedules.*`),
    // with NO operations or events, and whose message keeps the offending values for logs.

    fn refusal_code(out: &Output) -> String {
        out.error
            .as_ref()
            .expect("a refusal carries error.code")
            .code
            .clone()
    }

    fn refusal_message(out: &Output) -> String {
        out.error
            .as_ref()
            .expect("a refusal carries error.message")
            .message
            .clone()
    }

    fn assert_clean_refusal(out: &Output, code: &str) {
        assert_eq!(refusal_code(out), code);
        assert!(
            out.operations.is_empty(),
            "a refusal must not carry operations"
        );
        assert!(
            out.events.is_empty(),
            "a refusal must not announce effects that did not happen"
        );
        // The sentence the user reads is the TRANSLATION of the code; the fallback must not
        // leak column names (`is_closed=`) that only make sense to whoever wrote the handler.
        assert!(
            !refusal_message(out).contains("is_closed="),
            "message leaks a column name: {}",
            refusal_message(out)
        );
    }

    #[test]
    fn the_issue_table_rejections_are_namespaced_domain_codes() {
        // Every row of the inventory table of schedules#28, same payloads, one stable code each.
        // WEEKLY HOURS
        let overlap = json!({ "day_of_week": 0, "intervals": [
            { "open_time": "09:00", "close_time": "14:00" },
            { "open_time": "13:00", "close_time": "18:00" } ] });
        assert_clean_refusal(
            &set_business_hours_pure(input(overlap)).unwrap(),
            "schedules.overlapping",
        );
        let no_hours = json!({ "day_of_week": 0, "is_closed": false, "intervals": [] });
        assert_clean_refusal(
            &set_business_hours_pure(input(no_hours)).unwrap(),
            "schedules.missing_hours",
        );
        let bad_hours = json!({ "day_of_week": 0, "intervals": [ { "open_time": "10:00", "close_time": "10:00" } ] });
        assert_clean_refusal(
            &set_business_hours_pure(input(bad_hours)).unwrap(),
            "schedules.invalid_hours",
        );
        let bad_break = json!({ "day_of_week": 0, "open_time": "09:00", "close_time": "18:00", "break_start": "13:00" });
        assert_clean_refusal(
            &set_business_hours_pure(input(bad_break)).unwrap(),
            "schedules.invalid_break",
        );
        let bad_day = json!({ "day_of_week": 9, "is_closed": true });
        assert_clean_refusal(
            &set_business_hours_pure(input(bad_day)).unwrap(),
            "schedules.invalid_day",
        );
        // SPECIAL DAYS
        let dup = json!({ "date": "2026-08-25", "name": "Local holiday", "is_closed": true });
        let reads =
            json!({ "schedules.special_days.by_date": [ { "id": "s1", "date": "2026-08-25" } ] });
        assert_clean_refusal(
            &create_special_day_pure(input_with_reads(dup, reads)).unwrap(),
            "schedules.already_exists",
        );
        let impossible = json!({ "date": "2026-02-31", "name": "Nope", "is_closed": true });
        assert_clean_refusal(
            &create_special_day_pure(input(impossible)).unwrap(),
            "schedules.invalid_date",
        );
        let open_no_hours = json!({ "date": "2026-08-25", "name": "x", "is_closed": false });
        assert_clean_refusal(
            &create_special_day_pure(input(open_no_hours)).unwrap(),
            "schedules.missing_hours",
        );
        // OVERRIDES
        let inverted = json!({ "start_date": "2026-09-01", "end_date": "2026-08-30", "reason": "x", "is_closed": true });
        assert_clean_refusal(
            &create_override_pure(input(inverted)).unwrap(),
            "schedules.invalid_range",
        );
        let no_reason =
            json!({ "start_date": "2026-08-01", "end_date": "2026-08-15", "is_closed": true });
        assert_clean_refusal(
            &create_override_pure(input(no_reason)).unwrap(),
            "schedules.missing_name",
        );
        let ov_open_no_hours = json!({ "start_date": "2026-08-01", "end_date": "2026-08-15", "reason": "x", "is_closed": false });
        assert_clean_refusal(
            &create_override_pure(input(ov_open_no_hours)).unwrap(),
            "schedules.missing_hours",
        );
        let overlapping_live = json!({ "start_date": "2026-08-28", "end_date": "2026-08-30", "reason": "More holidays", "is_closed": true });
        let live = json!({ "schedules.overrides.overlapping": [
            { "id": "o1", "start_date": "2026-08-01", "end_date": "2026-08-31", "reason": "Vacaciones" } ] });
        let out = create_override_pure(input_with_reads(overlapping_live, live)).unwrap();
        assert_clean_refusal(&out, "schedules.overlapping");
        assert!(
            refusal_message(&out).contains("Vacaciones"),
            "names the live override it clashes with"
        );
        // BULK
        let empty_bulk = json!({ "special_days": [] });
        assert_clean_refusal(
            &bulk_create_special_days_pure(input(empty_bulk)).unwrap(),
            "schedules.missing_items",
        );
    }

    #[test]
    fn the_same_code_means_the_same_rejection_whichever_function_emits_it() {
        // schedules#28: `missing_hours` used to arrive in Spanish from create_special_day and in
        // English from create_override — the CODE is the contract, so one code, one meaning.
        let day = json!({ "date": "2026-08-25", "name": "x", "is_closed": false, "intervals": [] });
        let ov = json!({ "start_date": "2026-08-01", "end_date": "2026-08-15", "reason": "x", "is_closed": false, "intervals": [] });
        let week = json!({ "day_of_week": 0, "is_closed": false, "intervals": [] });
        for out in [
            create_special_day_pure(input(day)).unwrap(),
            create_override_pure(input(ov)).unwrap(),
            set_business_hours_pure(input(week)).unwrap(),
        ] {
            assert_eq!(refusal_code(&out), "schedules.missing_hours");
        }
    }

    #[test]
    fn is_open_answers_with_a_stable_code_and_no_baked_english() {
        // The `reason` of the verdict used to be an English sentence baked inside the WASM
        // ("Outside business hours (…)", "Closed today", …). Now the verdict carries a stable
        // `code` plus the data to phrase it (`intervals`); `reason` only survives when it is
        // USER data — the winning special day's name or the override's own reason.
        let bh = json!([
            { "id": "a", "day_of_week": 0, "open_time": "09:00", "close_time": "14:00", "is_closed": 0 },
            { "id": "b", "day_of_week": 0, "open_time": "16:00", "close_time": "20:00", "is_closed": 0 },
            { "id": "c", "day_of_week": 1, "open_time": "09:00", "close_time": "18:00", "is_closed": 1 } ]);
        let cases: [(&str, &str, bool); 5] = [
            ("2026-08-17T10:00", "open_interval", true), // inside a span
            ("2026-08-17T15:00", "outside_hours", false), // in the gap between spans
            ("2026-08-18T10:00", "closed_today", false), // the weekday is closed
            ("2026-08-16T10:00", "no_hours", false),     // nothing configured for a Sunday
            ("2026-08-17T05:00", "outside_hours", false),
        ];
        for (when, code, open) in cases {
            let r = is_open_pure(input(json!({ "when": when, "business_hours": bh })))
                .unwrap()
                .result
                .expect("verdict");
            assert_eq!(r["code"], code, "{when}");
            assert_eq!(r["is_open"], open, "{when}");
            assert!(
                r.get("reason").is_none() || r["reason"].as_str().unwrap_or("").is_empty(),
                "no baked sentence: {}",
                r["reason"]
            );
        }
        // The spans travel with the verdict, so the caller phrases it in the user's language.
        let r = is_open_pure(input(
            json!({ "when": "2026-08-17T15:00", "business_hours": bh }),
        ))
        .unwrap()
        .result
        .expect("verdict");
        assert_eq!(r["intervals"], json!(["09:00–14:00", "16:00–20:00"]));
        // An overnight tail from yesterday is its own code.
        let night = json!([ { "id": "n", "day_of_week": 3, "open_time": "22:00", "close_time": "02:00", "is_closed": 0 } ]);
        let r = is_open_pure(input(
            json!({ "when": "2026-08-21T01:00", "business_hours": night }),
        ))
        .unwrap()
        .result
        .expect("verdict");
        assert_eq!(r["code"], "overnight_open");
        // A winning special day keeps its NAME (user data) as reason, plus its own codes.
        let sd = json!({ "when": "2026-12-25T11:00",
            "special_days": [ { "id": "sd", "date": "2026-12-25", "name": "Navidad", "is_closed": 1 } ] });
        let r = is_open_pure(input(sd)).unwrap().result.expect("verdict");
        assert_eq!(r["code"], "exception_closed");
        assert_eq!(r["reason"], "Navidad");
        // «Nothing configured» has its own code, and only one (schedules#1): `fail_open` used to
        // give the caller a second one (`no_hours_fail_open`) and with it the power to choose the
        // answer for someone else's hub. Pinned by
        // `nothing_configured_is_the_modules_own_answer_and_the_caller_cannot_flip_it`.
        let r = is_open_pure(input(json!({ "when": "2026-08-17T10:00" })))
            .unwrap()
            .result
            .expect("verdict");
        assert_eq!(r["code"], "no_hours");
    }

    // ── schedules#7: special day duplicate check is server-authoritative (reads) ──

    #[test]
    fn special_day_create_rejects_duplicate_from_authoritative_read() {
        let payload = json!({ "date": "2026-12-25", "name": "Christmas", "is_closed": true });
        let reads =
            json!({ "schedules.special_days.by_date": [ { "id": "s1", "date": "2026-12-25" } ] });
        assert_eq!(
            err_code(create_special_day_pure(input_with_reads(payload, reads))),
            "already_exists"
        );
    }

    #[test]
    fn special_day_create_accepts_when_read_is_empty_even_if_client_hints_otherwise() {
        // The client hint (`existing_dates`) is ignored once the authoritative read is present.
        let payload = json!({ "date": "2026-12-25", "name": "Christmas", "is_closed": true, "existing_dates": ["2026-12-25"] });
        let reads = json!({ "schedules.special_days.by_date": [] });
        let out = create_special_day_pure(input_with_reads(payload, reads)).expect("ok");
        assert_eq!(out.operations[0].command, "schedules._insert_special_day");
    }

    #[test]
    fn special_day_create_exact_ui_payload_is_accepted() {
        // Payload the UI sends after schedules#7: no `existing_dates`, hours when open.
        let payload = json!({
            "date": "2026-12-24", "name": "Christmas Eve", "is_closed": false,
            "open_time": "09:00", "close_time": "14:00", "recurring_yearly": true, "notes": "half day"
        });
        let out = create_special_day_pure(input_with_reads(
            payload,
            json!({ "schedules.special_days.by_date": [] }),
        ))
        .expect("ok");
        let params = &out.operations[0].params;
        assert_eq!(params["open_time"], "09:00");
        assert_eq!(params["recurring_yearly"], 1);
        assert_eq!(params["notes"], "half day");
    }

    // ── schedules#7: an open override needs hours (no silent "open 24h") ──

    #[test]
    fn override_create_open_without_hours_is_missing_hours() {
        let payload = json!({ "start_date": "2026-08-01", "end_date": "2026-08-15", "reason": "Summer", "is_closed": false });
        assert_eq!(
            err_code(create_override_pure(input(payload))),
            "missing_hours"
        );
    }

    #[test]
    fn override_create_closed_without_hours_is_ok() {
        let payload = json!({ "start_date": "2026-08-01", "end_date": "2026-08-15", "reason": "Holidays", "is_closed": true });
        let out = create_override_pure(input(payload)).expect("ok");
        assert_eq!(out.operations[0].params["is_closed"], 1);
        assert!(out.operations[0].params["open_time"].is_null());
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
        assert_eq!(
            err_code(create_special_day_pure(input(payload))),
            "invalid_date"
        );
    }

    #[test]
    fn bulk_rejects_impossible_dates_per_item_and_keeps_the_valid_ones() {
        let payload = json!({ "special_days": [
            { "date": "2026-02-31", "name": "Nope", "is_closed": true },
            { "date": "2024-02-29", "name": "Leap", "is_closed": true },
            { "date": "2026-02-29", "name": "Not leap", "is_closed": true },
        ]});
        let out = bulk_create_special_days_pure(input(payload)).expect("bulk is fault-tolerant");
        let result = out
            .result
            .expect("the partial summary is the point of the bulk");
        assert_eq!(result["created"], 1);
        assert_eq!(result["errors"].as_array().unwrap().len(), 2);
        // The per-item error is the namespaced CODE — the caller translates it against the
        // module's `errors` catalog, the offending date travels in the item itself (schedules#28).
        assert_eq!(result["errors"][0]["error"], "schedules.invalid_date");
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
        let result = out.result.expect("bulk summary");
        assert_eq!(result["created"], 1);
        assert_eq!(out.operations.len(), 1);
        assert_eq!(result["errors"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn override_create_rejects_inverted_range_and_inverted_hours() {
        let inverted_range = json!({ "start_date": "2026-08-15", "end_date": "2026-08-01", "reason": "x", "is_closed": true });
        assert_eq!(
            err_code(create_override_pure(input(inverted_range))),
            "invalid_range"
        );
        let inverted_hours = json!({ "start_date": "2026-08-01", "end_date": "2026-08-15", "reason": "x", "is_closed": false, "open_time": "14:00", "close_time": "10:00" });
        assert_eq!(
            err_code(create_override_pure(input(inverted_hours))),
            "invalid_hours"
        );
        let same_hours = json!({ "start_date": "2026-08-01", "end_date": "2026-08-15", "reason": "x", "is_closed": false, "open_time": "10:00", "close_time": "10:00" });
        assert_eq!(
            err_code(create_override_pure(input(same_hours))),
            "invalid_hours"
        );
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
        assert_eq!(out.operations[0].params["open_time"], "10:00");
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
        let ops = &out.operations;
        assert_eq!(ops[0].command, "schedules._clear_business_hours_day");
        assert_eq!(ops[0].params["day_of_week"], 0);
        assert_eq!(ops.len(), 3);
        assert_eq!(ops[1].command, "schedules._insert_business_hours");
        assert_eq!(ops[1].params["id"], "n1");
        assert_eq!(ops[1].params["position"], 0);
        assert_eq!(ops[1].params["open_time"], "10:00");
        assert_eq!(ops[1].params["close_time"], "14:00");
        assert_eq!(ops[1].params["is_closed"], 0);
        assert_eq!(ops[2].params["id"], "n2");
        assert_eq!(ops[2].params["position"], 1);
        assert_eq!(ops[2].params["open_time"], "17:00");
        assert_eq!(out.events[0].name, "schedules.business_hours.updated");
        assert_eq!(
            out.events[0].payload["intervals"].as_array().unwrap().len(),
            2
        );
    }

    #[test]
    fn set_hours_intervals_are_sorted_and_overlaps_are_rejected() {
        let unsorted = json!({ "day_of_week": 1, "intervals": [
            { "open_time": "17:00", "close_time": "20:00" },
            { "open_time": "10:00", "close_time": "14:00" } ] });
        let out = set_business_hours_pure(ctx_with_ids(unsorted)).expect("ok");
        assert_eq!(out.operations[1].params["open_time"], "10:00");
        assert_eq!(out.operations[2].params["open_time"], "17:00");

        let overlap = json!({ "day_of_week": 1, "intervals": [
            { "open_time": "10:00", "close_time": "14:00" },
            { "open_time": "13:00", "close_time": "20:00" } ] });
        assert_eq!(
            err_code(set_business_hours_pure(ctx_with_ids(overlap))),
            "overlapping"
        );
    }

    #[test]
    fn set_hours_overnight_and_24h_intervals_are_representable() {
        // 22:00–02:00 crosses midnight: close < open is the overnight representation.
        let night = json!({ "day_of_week": 4, "intervals": [ { "open_time": "22:00", "close_time": "02:00" } ] });
        let out = set_business_hours_pure(ctx_with_ids(night)).expect("overnight must be accepted");
        assert_eq!(out.operations[1].params["close_time"], "02:00");
        // 00:00–00:00 is «open 24 hours».
        let all_day = json!({ "day_of_week": 5, "intervals": [ { "open_time": "00:00", "close_time": "00:00" } ] });
        set_business_hours_pure(ctx_with_ids(all_day)).expect("24h must be accepted");
        // Any other zero-length interval is still an error.
        let zero = json!({ "day_of_week": 5, "intervals": [ { "open_time": "10:00", "close_time": "10:00" } ] });
        assert_eq!(
            err_code(set_business_hours_pure(ctx_with_ids(zero))),
            "invalid_hours"
        );
        // An overnight interval followed by a morning one overlaps through midnight → still overlapping.
        let wrap = json!({ "day_of_week": 4, "intervals": [
            { "open_time": "22:00", "close_time": "02:00" }, { "open_time": "23:00", "close_time": "23:30" } ] });
        assert_eq!(
            err_code(set_business_hours_pure(ctx_with_ids(wrap))),
            "overlapping"
        );
    }

    #[test]
    fn set_hours_legacy_open_close_break_payload_becomes_intervals() {
        let legacy = json!({ "day_of_week": 2, "open_time": "09:00", "close_time": "18:00",
            "break_start": "13:00", "break_end": "15:00" });
        let out = set_business_hours_pure(ctx_with_ids(legacy)).expect("ok");
        let ops = &out.operations;
        assert_eq!(ops.len(), 3);
        assert_eq!(
            (
                ops[1].params["open_time"].as_str().unwrap(),
                ops[1].params["close_time"].as_str().unwrap()
            ),
            ("09:00", "13:00")
        );
        assert_eq!(
            (
                ops[2].params["open_time"].as_str().unwrap(),
                ops[2].params["close_time"].as_str().unwrap()
            ),
            ("15:00", "18:00")
        );
    }

    #[test]
    fn set_hours_closed_day_writes_a_single_closed_row_and_no_intervals() {
        let payload = json!({ "day_of_week": 6, "is_closed": true, "intervals": [ { "open_time": "10:00", "close_time": "14:00" } ] });
        let out = set_business_hours_pure(ctx_with_ids(payload)).expect("ok");
        let ops = &out.operations;
        assert_eq!(ops.len(), 2);
        assert_eq!(ops[1].params["is_closed"], 1);
        // An open day with no interval is a mistake, not «open all day».
        let empty = json!({ "day_of_week": 6, "is_closed": false, "intervals": [] });
        assert_eq!(
            err_code(set_business_hours_pure(ctx_with_ids(empty))),
            "missing_hours"
        );
    }

    fn open_at(when: &str, business_hours: Value) -> Value {
        let payload = json!({ "when": when, "business_hours": business_hours });
        is_open_pure(input(payload))
            .expect("ok")
            .result
            .expect("verdict")
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
        assert_eq!(
            open_at("2026-08-20T00:00", all_day.clone())["is_open"],
            true
        );
        assert_eq!(open_at("2026-08-20T23:59", all_day)["is_open"], true);
    }

    #[test]
    fn is_open_reports_which_rule_won_special_day_over_override_over_weekly() {
        let payload = json!({ "when": "2026-12-25T11:00",
            "special_days": [ { "id": "sd", "date": "2026-12-25", "name": "Christmas", "is_closed": 1 } ],
            "overrides": [ { "id": "ov", "start_date": "2026-12-20", "end_date": "2026-12-31", "reason": "Winter", "is_closed": 0, "open_time": "10:00", "close_time": "14:00" } ],
            "business_hours": [ { "id": "bh", "day_of_week": 4, "open_time": "09:00", "close_time": "18:00", "is_closed": 0 } ] });
        let r = is_open_pure(input(payload))
            .expect("ok")
            .result
            .expect("verdict");
        assert_eq!(r["is_open"], false);
        assert_eq!(r["source"], "special_day");
        assert_eq!(r["rule_id"], "sd");

        let payload = json!({ "when": "2026-12-26T11:00",
            "overrides": [ { "id": "ov", "start_date": "2026-12-20", "end_date": "2026-12-31", "reason": "Winter", "is_closed": 0, "open_time": "10:00", "close_time": "14:00" } ],
            "business_hours": [ { "id": "bh", "day_of_week": 5, "open_time": "09:00", "close_time": "18:00", "is_closed": 0 } ] });
        let r = is_open_pure(input(payload))
            .expect("ok")
            .result
            .expect("verdict");
        assert_eq!(r["source"], "override");
        assert_eq!(r["rule_id"], "ov");

        let r = is_open_pure(input(json!({ "when": "2026-12-26T11:00" })))
            .expect("ok")
            .result
            .expect("verdict");
        assert_eq!(r["source"], "none");
    }

    // ── schedules#23: an exception (special day / override) also carries 0..N intervals ──

    /// The ops a create emitted, as `(command, params)`, so a test reads them by name instead of
    /// by index (the parent is always the first one).
    fn ops_of(out: &Output) -> Vec<(String, Value)> {
        out.operations
            .iter()
            .map(|o| (o.command.clone(), Value::from(o.params.clone())))
            .collect()
    }

    fn empty_by_date() -> Value {
        json!({ "schedules.special_days.by_date": [] })
    }

    fn create_special_day_with(payload: Value) -> Result<Output, String> {
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
        assert_eq!(
            out.events[0].payload["intervals"].as_array().unwrap().len(),
            2
        );
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
        create_special_day_with(
            json!({ "date": "2026-12-24", "name": "Eve", "is_closed": false,
            "intervals": [ { "open_time": "00:00", "close_time": "00:00" } ] }),
        )
        .expect("24 h must be accepted");
        let zero = json!({ "date": "2026-12-24", "name": "Eve", "is_closed": false,
            "intervals": [ { "open_time": "10:00", "close_time": "10:00" } ] });
        assert_eq!(err_code(create_special_day_with(zero)), "invalid_hours");

        // An open exception with an empty interval list is a mistake, not «open all day».
        let none =
            json!({ "date": "2026-12-24", "name": "Eve", "is_closed": false, "intervals": [] });
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
        let out = create_special_day_with(
            json!({ "date": "2026-12-25", "name": "Christmas", "is_closed": true }),
        )
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
        let out =
            create_override_pure(ctx_with_ids(payload)).expect("a split-shift override is legal");
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
        assert_eq!(
            out.events[0].payload["intervals"].as_array().unwrap().len(),
            2
        );
    }

    #[test]
    fn override_intervals_reject_overlaps_and_a_closed_override_writes_none() {
        let overlap = json!({ "start_date": "2026-08-01", "end_date": "2026-08-31", "reason": "Summer",
            "is_closed": false,
            "intervals": [ { "open_time": "10:00", "close_time": "14:00" },
                           { "open_time": "12:00", "close_time": "20:00" } ] });
        assert_eq!(
            err_code(create_override_pure(ctx_with_ids(overlap))),
            "overlapping"
        );

        let closed = json!({ "start_date": "2026-08-01", "end_date": "2026-08-31", "reason": "Holidays", "is_closed": true });
        let out = create_override_pure(ctx_with_ids(closed)).expect("ok");
        assert_eq!(ops_of(&out).len(), 1);
    }

    fn open_with_exceptions(when: &str, extra: Value) -> Value {
        let mut payload = json!({ "when": when });
        for (k, v) in extra.as_object().expect("object") {
            payload[k] = v.clone();
        }
        is_open_pure(input(payload))
            .expect("ok")
            .result
            .expect("verdict")
    }

    #[test]
    fn is_open_walks_every_interval_of_the_winning_special_day() {
        let extra = json!({
            "special_days": [ { "id": "sd", "date": "2026-12-24", "name": "Eve", "is_closed": 0,
                                "open_time": "10:00", "close_time": "13:00" } ],
            "exception_intervals": [
                { "id": "i1", "exception_kind": "special_day", "exception_id": "sd", "position": 0, "open_time": "10:00", "close_time": "13:00" },
                { "id": "i2", "exception_kind": "special_day", "exception_id": "sd", "position": 1, "open_time": "17:00", "close_time": "19:00" } ] });
        assert_eq!(
            open_with_exceptions("2026-12-24T11:00", extra.clone())["is_open"],
            true
        );
        // The gap between the two intervals is CLOSED — before schedules#23 it read as open.
        let midday = open_with_exceptions("2026-12-24T15:00", extra.clone());
        assert_eq!(midday["is_open"], false);
        assert_eq!(midday["source"], "special_day");
        assert_eq!(midday["rule_id"], "sd");
        // …and the second interval is open again.
        assert_eq!(
            open_with_exceptions("2026-12-24T18:00", extra.clone())["is_open"],
            true
        );
        assert_eq!(
            open_with_exceptions("2026-12-24T20:00", extra)["is_open"],
            false
        );
    }

    #[test]
    fn is_open_walks_every_interval_of_the_winning_override() {
        let extra = json!({
            "overrides": [ { "id": "ov", "start_date": "2026-08-01", "end_date": "2026-08-31",
                             "reason": "Summer", "is_closed": 0, "open_time": "10:00", "close_time": "13:30" } ],
            "exception_intervals": [
                { "id": "i1", "exception_kind": "override", "exception_id": "ov", "position": 0, "open_time": "10:00", "close_time": "13:30" },
                { "id": "i2", "exception_kind": "override", "exception_id": "ov", "position": 1, "open_time": "18:00", "close_time": "21:00" } ] });
        assert_eq!(
            open_with_exceptions("2026-08-05T12:00", extra.clone())["is_open"],
            true
        );
        assert_eq!(
            open_with_exceptions("2026-08-05T16:00", extra.clone())["is_open"],
            false
        );
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
        assert_eq!(
            open_with_exceptions("2026-12-24T11:00", extra.clone())["is_open"],
            true
        );
        assert_eq!(
            open_with_exceptions("2026-12-24T18:00", extra)["is_open"],
            false
        );
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
        let wire =
            serde_json::to_value(is_open_pure(input(payload)).expect("ok")).expect("serialises");
        let out: Output = serde_json::from_value(wire).expect("the host deserialises the Output");
        let result = out
            .result
            .expect("the verdict is a result, not an operation");
        assert_eq!(result["is_open"], true);
        assert_eq!(result["source"], "business_hours");
        assert_eq!(result["rule_id"], "a");
        assert!(
            out.operations.is_empty(),
            "a read-only handler writes nothing"
        );
        assert!(out.events.is_empty(), "and emits nothing");
    }

    #[test]
    fn the_bulk_summary_travels_in_the_result_channel_too() {
        let payload = json!({ "special_days": [
            { "date": "2026-02-31", "name": "Impossible", "is_closed": true },
            { "date": "2026-03-01", "name": "Fine", "is_closed": true } ]});
        let wire = serde_json::to_value(
            bulk_create_special_days_pure(input(payload)).expect("the bulk is fault-tolerant"),
        )
        .expect("serialises");
        let out: Output = serde_json::from_value(wire).expect("the host deserialises the Output");
        let result = out
            .result
            .expect("the partial summary is the point of the bulk");
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
            assert_eq!(
                open_at(&format!("{day}T09:59"), bh.clone())["is_open"],
                false,
                "{day}"
            );
            assert_eq!(
                open_at(&format!("{day}T10:00"), bh.clone())["is_open"],
                true,
                "{day}"
            );
            assert_eq!(
                open_at(&format!("{day}T19:59"), bh.clone())["is_open"],
                true,
                "{day}"
            );
            assert_eq!(
                open_at(&format!("{day}T20:00"), bh.clone())["is_open"],
                false,
                "{day}"
            );
        }
        // And the hour that is skipped (02:00–03:00 in March) is simply outside the schedule.
        let night = json!([ { "id": "n", "day_of_week": 6, "open_time": "01:00", "close_time": "04:00", "is_closed": 0 } ]);
        assert_eq!(
            open_at("2026-03-29T02:30", night.clone())["is_open"],
            true,
            "a skipped wall-clock hour still reads as open"
        );
        assert_eq!(
            open_at("2026-10-25T02:30", night)["is_open"],
            true,
            "a repeated one too"
        );
    }

    #[test]
    fn a_24h_interval_on_an_exception_is_open_all_day_and_an_overnight_one_runs_to_midnight() {
        let all_day = json!({
            "special_days": [ { "id": "sd", "date": "2026-12-24", "name": "Eve", "is_closed": 0 } ],
            "exception_intervals": [ { "id": "i1", "exception_kind": "special_day", "exception_id": "sd", "position": 0, "open_time": "00:00", "close_time": "00:00" } ] });
        assert_eq!(
            open_with_exceptions("2026-12-24T03:00", all_day.clone())["is_open"],
            true
        );
        assert_eq!(
            open_with_exceptions("2026-12-24T23:59", all_day)["is_open"],
            true
        );

        // Overnight (22:00–02:00) is honoured on the exception's OWN date, up to midnight; the
        // small hours of the next day are governed by the next day's rules (documented boundary).
        let night = json!({
            "special_days": [ { "id": "sd", "date": "2026-12-31", "name": "New Year's Eve", "is_closed": 0 } ],
            "exception_intervals": [ { "id": "i1", "exception_kind": "special_day", "exception_id": "sd", "position": 0, "open_time": "22:00", "close_time": "02:00" } ] });
        assert_eq!(
            open_with_exceptions("2026-12-31T23:30", night.clone())["is_open"],
            true
        );
        assert_eq!(
            open_with_exceptions("2026-12-31T21:00", night)["is_open"],
            false
        );
    }

    // ── schedules#1: the verdict is computed on the BUSINESS clock ────────────────────────
    //
    // The engine used to slice the date and the time out of `context.now`, which is UTC, so a
    // business in Madrid was answered with the clock of the server: at 23:30 UTC it was still
    // asked about YESTERDAY, and at 03:30 local (CEST) it was asked about 01:30. The zone of the
    // business is the core's (hub#731) and reaches the handler in `context.timezone` since
    // hub#1022 — a resolved IANA name. These tests pin that the wall clock the rules are read
    // with is the SHOP's, DST included.

    /// Input as the runtime builds it for a hub whose business clock is `tz`.
    fn input_in(tz: &str, now: &str, payload: Value) -> Value {
        json!({ "payload": payload, "context": { "hub_id": "h1", "now": now,
            "timezone": tz, "new_ids": ids(4) } })
    }

    fn verdict(r: Result<Output, String>) -> Value {
        r.unwrap().result.expect("verdict")
    }

    /// Mon–Fri 09:00–14:00 and 16:00–20:00; Tuesday also opens 09:00–18:00 in one go.
    fn weekly_hours() -> Value {
        json!([
            { "id": "mon", "day_of_week": 0, "open_time": "09:00", "close_time": "14:00", "is_closed": 0 },
            { "id": "tue", "day_of_week": 1, "open_time": "09:00", "close_time": "18:00", "is_closed": 0 } ])
    }

    #[test]
    fn the_same_instant_answers_differently_in_each_business_zone() {
        // 20:00 UTC is 22:00 of Monday in Madrid (closed: Monday ends at 14:00) and 10:00 of
        // TUESDAY in Kiritimati (+14, open). Same instant, same rules, two businesses.
        let payload = json!({ "business_hours": weekly_hours() });
        let madrid = verdict(is_open_pure(input_in(
            "Europe/Madrid",
            "2026-08-17T20:00:00Z",
            payload.clone(),
        )));
        assert_eq!(madrid["today"], "2026-08-17");
        assert_eq!(madrid["current_time"], "22:00");
        assert_eq!(madrid["is_open"], false);

        let kiritimati = verdict(is_open_pure(input_in(
            "Pacific/Kiritimati",
            "2026-08-17T20:00:00Z",
            payload,
        )));
        assert_eq!(kiritimati["today"], "2026-08-18");
        assert_eq!(kiritimati["current_time"], "10:00");
        assert_eq!(kiritimati["is_open"], true);
    }

    #[test]
    fn the_business_day_rolls_over_on_the_business_clock() {
        // 23:30 UTC of Monday is already 01:30 of TUESDAY in Madrid: the rules that answer are
        // Tuesday's, and the weekday is recomputed from the local date, not from the UTC one.
        let v = verdict(is_open_pure(input_in(
            "Europe/Madrid",
            "2026-08-17T23:30:00Z",
            json!({ "business_hours": weekly_hours() }),
        )));
        assert_eq!(v["today"], "2026-08-18");
        assert_eq!(v["current_time"], "01:30");
        assert_eq!(v["code"], "outside_hours");
        assert_eq!(v["rule_id"], "tue");
    }

    #[test]
    fn the_spring_forward_moves_the_wall_clock_inside_the_same_day() {
        // 2026-03-29, Madrid: at 01:00 UTC the clocks jump from 02:00 CET to 03:00 CEST. Half an
        // hour before the change it is 01:30 local; half an hour after, 03:30 — a business open
        // 03:00–05:00 that Sunday is CLOSED in the first case and OPEN in the second. Evaluated
        // in UTC both are closed, which is the bug.
        let sunday = json!({ "business_hours": [
            { "id": "sun", "day_of_week": 6, "open_time": "03:00", "close_time": "05:00", "is_closed": 0 } ] });
        let before = verdict(is_open_pure(input_in(
            "Europe/Madrid",
            "2026-03-29T00:30:00Z",
            sunday.clone(),
        )));
        assert_eq!(before["current_time"], "01:30");
        assert_eq!(before["is_open"], false);

        let after = verdict(is_open_pure(input_in(
            "Europe/Madrid",
            "2026-03-29T01:30:00Z",
            sunday,
        )));
        assert_eq!(after["current_time"], "03:30");
        assert_eq!(after["is_open"], true);
    }

    #[test]
    fn the_repeated_hour_of_the_autumn_change_is_resolved_by_the_zone_not_by_a_fixed_offset() {
        // 2026-10-25, Madrid: 02:00–03:00 local happens TWICE (03:00 CEST falls back to 02:00
        // CET). Both 00:30 UTC and 01:30 UTC are 02:30 local, so a business open 02:00–03:00 is
        // open at both instants. A hardcoded +02:00 would answer 02:30 and 03:30 (open, closed).
        let sunday = json!({ "business_hours": [
            { "id": "sun", "day_of_week": 6, "open_time": "02:00", "close_time": "03:00", "is_closed": 0 } ] });
        for now in ["2026-10-25T00:30:00Z", "2026-10-25T01:30:00Z"] {
            let v = verdict(is_open_pure(input_in("Europe/Madrid", now, sunday.clone())));
            assert_eq!(v["current_time"], "02:30", "{now}");
            assert_eq!(v["is_open"], true, "{now}");
        }
    }

    #[test]
    fn an_instant_is_converted_and_a_bare_wall_clock_is_taken_as_the_shops_own() {
        // `when` with an offset (or `Z`) is an INSTANT and gets converted to the business zone;
        // `when` without one already IS the shop's wall clock ("next Thursday at 18:30") and is
        // read as written. Both rules are the module's public contract.
        let payload = |when: &str| json!({ "when": when, "business_hours": weekly_hours() });
        let instant = verdict(is_open_pure(input_in(
            "Europe/Madrid",
            "2026-08-17T20:00:00Z",
            payload("2026-08-18T08:00:00Z"),
        )));
        assert_eq!(instant["today"], "2026-08-18");
        assert_eq!(instant["current_time"], "10:00");
        assert_eq!(instant["is_open"], true);

        let bare = verdict(is_open_pure(input_in(
            "Europe/Madrid",
            "2026-08-17T20:00:00Z",
            payload("2026-08-18T10:00"),
        )));
        assert_eq!(bare["today"], "2026-08-18");
        assert_eq!(bare["current_time"], "10:00");
        assert_eq!(bare["is_open"], true);
    }

    #[test]
    fn the_verdict_names_the_zone_it_was_computed_in() {
        // The applied zone travels with the answer: a caller (and a support ticket) can tell
        // WHICH clock produced the verdict instead of guessing.
        let v = verdict(is_open_pure(input_in(
            "Atlantic/Canary",
            "2026-08-17T20:00:00Z",
            json!({ "business_hours": weekly_hours() }),
        )));
        assert_eq!(v["timezone"], "Atlantic/Canary");
        assert_eq!(v["current_time"], "21:00");

        // No zone in the context (an old runtime) is UTC — the same fallback the core makes when
        // it cannot resolve the hub's zone. Never a silent lie: the verdict says UTC.
        let utc = verdict(is_open_pure(input(
            json!({ "business_hours": weekly_hours() }),
        )));
        assert_eq!(utc["timezone"], "UTC");
    }

    #[test]
    fn a_zone_the_calendar_does_not_know_degrades_to_utc_and_says_so() {
        // The core validates the name before storing it, so this can only reach the handler from
        // a forged context. It must not take the shop's schedule down: answer in UTC and name it.
        let v = verdict(is_open_pure(input_in(
            "Mars/Olympus_Mons",
            "2026-08-17T20:00:00Z",
            json!({ "business_hours": weekly_hours() }),
        )));
        assert_eq!(v["timezone"], "UTC");
        assert_eq!(v["current_time"], "20:00");
    }

    // ── schedules#1: the rules come from the RUNTIME, not from the caller ─────────────────

    #[test]
    fn is_open_reads_the_stored_rules_from_the_preloaded_reads() {
        // `reads` (ADR-0069) hands the handler the hub's own rows. The caller only says WHEN.
        let reads = json!({
            "schedules.business_hours.list": weekly_hours(),
            "schedules.special_days.list": [],
            "schedules.overrides.list": [],
            "schedules.exception_intervals.list": [] });
        let mut input = input_in("Europe/Madrid", "2026-08-18T08:00:00Z", json!({}));
        input["context"]["reads"] = reads;
        let v = verdict(is_open_pure(input));
        assert_eq!(v["code"], "open_interval");
        assert_eq!(v["rule_id"], "tue");
    }

    #[test]
    fn a_forged_payload_cannot_flip_the_verdict_the_stored_rules_decided() {
        // The rows in the payload are ignored the moment the runtime delivered the reads: a
        // caller cannot invent opening hours, nor a special day, nor claim there is nothing
        // configured. Without this, `is_open` answered whatever it was told.
        let reads = json!({
            "schedules.business_hours.list": [
                { "id": "mon", "day_of_week": 0, "open_time": "09:00", "close_time": "14:00", "is_closed": 1 } ],
            "schedules.special_days.list": [],
            "schedules.overrides.list": [],
            "schedules.exception_intervals.list": [] });
        let forged = json!({
            "business_hours": [ { "id": "fake", "day_of_week": 0, "open_time": "00:00", "close_time": "00:00", "is_closed": 0 } ],
            "special_days": [ { "id": "fake", "date": "2026-08-17", "name": "Forged", "is_closed": 0 } ],
            "overrides": [ { "id": "fake", "start_date": "2026-08-01", "end_date": "2026-12-31", "reason": "Forged", "is_closed": 0 } ] });
        let mut input = input_in("Europe/Madrid", "2026-08-17T08:00:00Z", forged);
        input["context"]["reads"] = reads;
        let v = verdict(is_open_pure(input));
        assert_eq!(v["source"], "business_hours");
        assert_eq!(v["code"], "closed_today");
        assert_eq!(v["is_open"], false);
    }

    #[test]
    fn nothing_configured_is_the_modules_own_answer_and_the_caller_cannot_flip_it() {
        // `fail_open` let each caller choose the answer for the same hub, so two consumers
        // disagreed about the same instant. The policy is the domain's: with no rule for that
        // day the business is NOT declared open, and the stable code `no_hours` tells a consumer
        // that this is «nothing configured», not «closed today».
        for payload in [json!({}), json!({ "fail_open": true })] {
            let v = verdict(is_open_pure(input_in(
                "Europe/Madrid",
                "2026-08-16T08:00:00Z",
                payload,
            )));
            assert_eq!(v["code"], "no_hours");
            assert_eq!(v["is_open"], false);
        }
    }

    // ── schedules#43: confirming the week the installer guessed, in ONE gesture ────────────
    //
    // The onboarding step «Confirm your opening hours» is ticked by `queries/setup_status.sql`,
    // which counts the live rows a PERSON signed (`created_by IS DISTINCT FROM 'system'`). For a
    // business whose real week IS the one schedules#36 seeded there was nothing to press: the only
    // way to sign it was to open some day and save it back UNCHANGED. `confirm_business_hours` is
    // that gesture — it replaces every live row with an identical one signed by the caller.
    //
    // THE INVARIANT: a consumer must not be able to tell confirming from saving the seven days one
    // by one. Same operations, same event per day, and not one opening hour different. The rows
    // come from `context.reads` (server-authoritative, ADR-0069): the browser cannot dictate the
    // week it is about to sign.

    fn week_reads(rows: Value) -> Value {
        json!({ "schedules.business_hours.list": rows })
    }

    /// One live row of the weekly table, as `queries/business_hours_list.sql` returns it.
    fn live_row(day: i64, position: i64, open: &str, close: &str, closed: i64) -> Value {
        json!({ "id": format!("seed-{day}-{position}"), "day_of_week": day, "position": position,
            "open_time": open, "close_time": close, "is_closed": closed,
            "break_start": Value::Null, "break_end": Value::Null, "created_by": "system" })
    }

    /// The week `seed/install.postgres.sql` plants, with a split shift on Wednesday so the test
    /// cannot pass by assuming one row per day.
    fn seeded_week() -> Value {
        json!([
            live_row(0, 0, "09:00", "18:00", 0),
            live_row(1, 0, "09:00", "18:00", 0),
            live_row(2, 0, "10:00", "14:00", 0),
            live_row(2, 1, "17:00", "20:00", 0),
            live_row(3, 0, "09:00", "18:00", 0),
            live_row(4, 0, "09:00", "18:00", 0),
            live_row(5, 0, "00:00", "00:00", 1),
            live_row(6, 0, "00:00", "00:00", 1),
        ])
    }

    fn ops_named<'a>(out: &'a Output, command: &str) -> Vec<&'a Operation> {
        out.operations
            .iter()
            .filter(|o| o.command == command)
            .collect()
    }

    #[test]
    fn confirming_rewrites_every_live_row_identical_and_signed_by_the_caller() {
        let out = confirm_business_hours_pure(input_with_reads(
            json!({}),
            week_reads(seeded_week()),
        ))
        .expect("ok");

        // One clear per DAY, one insert per ROW: a day is REPLACED, never accumulated — the same
        // shape `set_business_hours` returns for a single day.
        let clears = ops_named(&out, "schedules._clear_business_hours_day");
        let inserts = ops_named(&out, "schedules._insert_business_hours");
        assert_eq!(clears.len(), 7, "one clear per weekday with live rows");
        assert_eq!(inserts.len(), 8, "one insert per live row (Wednesday has two)");
        assert_eq!(
            out.operations.len(),
            15,
            "nothing else is written: no extra table, no settings row"
        );
        let cleared: Vec<i64> = clears
            .iter()
            .map(|o| o.params["day_of_week"].as_i64().unwrap())
            .collect();
        assert_eq!(cleared, vec![0, 1, 2, 3, 4, 5, 6]);

        // NOT ONE HOUR MOVES. This is the whole promise of the button: the person is saying «yes,
        // this is my week», not editing it.
        let seen: Vec<(i64, i64, String, String, i64)> = inserts
            .iter()
            .map(|o| {
                (
                    o.params["day_of_week"].as_i64().unwrap(),
                    o.params["position"].as_i64().unwrap(),
                    as_str(&o.params["open_time"]),
                    as_str(&o.params["close_time"]),
                    o.params["is_closed"].as_i64().unwrap(),
                )
            })
            .collect();
        assert_eq!(
            seen,
            vec![
                (0, 0, "09:00".into(), "18:00".into(), 0),
                (1, 0, "09:00".into(), "18:00".into(), 0),
                (2, 0, "10:00".into(), "14:00".into(), 0),
                (2, 1, "17:00".into(), "20:00".into(), 0),
                (3, 0, "09:00".into(), "18:00".into(), 0),
                (4, 0, "09:00".into(), "18:00".into(), 0),
                (5, 0, "00:00".into(), "00:00".into(), 1),
                (6, 0, "00:00".into(), "00:00".into(), 1),
            ]
        );

        // Ids come from the host's batch, in order and never reused: the guest is not an authority
        // of ids, and two rows sharing one would collide on the primary key.
        let ids: Vec<String> = inserts.iter().map(|o| as_str(&o.params["id"])).collect();
        assert_eq!(
            ids,
            vec!["id-0", "id-1", "id-2", "id-3", "id-4", "id-5", "id-6", "id-7"]
        );

        // The clear of a day is emitted BEFORE its inserts, or the day would be wiped after being
        // rewritten and the week would come back empty.
        for day in 0..=6 {
            let clear_at = out
                .operations
                .iter()
                .position(|o| {
                    o.command == "schedules._clear_business_hours_day"
                        && o.params["day_of_week"] == json!(day)
                })
                .unwrap();
            let first_insert = out
                .operations
                .iter()
                .position(|o| {
                    o.command == "schedules._insert_business_hours"
                        && o.params["day_of_week"] == json!(day)
                })
                .unwrap();
            assert!(clear_at < first_insert, "day {day}: clear must come first");
        }

        // One `updated` event per day — indistinguishable from saving the seven days by hand.
        assert_eq!(out.events.len(), 7);
        assert!(out
            .events
            .iter()
            .all(|e| e.name == "schedules.business_hours.updated"));
        let days: Vec<i64> = out
            .events
            .iter()
            .map(|e| e.payload["day_of_week"].as_i64().unwrap())
            .collect();
        assert_eq!(days, vec![0, 1, 2, 3, 4, 5, 6]);
        let wednesday = &out.events[2];
        assert_eq!(
            wednesday.payload["intervals"].as_array().unwrap().len(),
            2,
            "the split shift travels whole"
        );
        assert_eq!(wednesday.payload["open_time"], "10:00");
        assert_eq!(wednesday.payload["close_time"], "20:00");
        assert_eq!(out.events[5].payload["is_closed"], 1);
        assert_eq!(
            out.events[5].payload["intervals"].as_array().unwrap().len(),
            0,
            "a closed day announces no interval"
        );

        assert_eq!(out.result.as_ref().unwrap()["confirmed_days"], 7);
        assert!(out.error.is_none());
    }

    #[test]
    fn confirming_sorts_the_week_the_read_may_hand_over_unordered() {
        // `business_hours_list.sql` carries no ORDER BY: the list engine sorts by `day_of_week`
        // only (`default_sort`), so two intervals of the same day arrive in whatever order the
        // planner chose. Writing them back in that order would renumber `position` at random and
        // the day editor would show the afternoon shift first.
        let jumbled = json!([
            live_row(2, 1, "17:00", "20:00", 0),
            live_row(0, 0, "09:00", "18:00", 0),
            live_row(2, 0, "10:00", "14:00", 0),
        ]);
        let out =
            confirm_business_hours_pure(input_with_reads(json!({}), week_reads(jumbled))).expect("ok");

        let inserts = ops_named(&out, "schedules._insert_business_hours");
        let seen: Vec<(i64, i64, String)> = inserts
            .iter()
            .map(|o| {
                (
                    o.params["day_of_week"].as_i64().unwrap(),
                    o.params["position"].as_i64().unwrap(),
                    as_str(&o.params["open_time"]),
                )
            })
            .collect();
        assert_eq!(
            seen,
            vec![
                (0, 0, "09:00".into()),
                (2, 0, "10:00".into()),
                (2, 1, "17:00".into()),
            ]
        );
    }

    #[test]
    fn confirming_renumbers_position_from_zero_without_gaps() {
        // A week whose intervals were left with holes (a middle shift deleted long ago) must come
        // back contiguous: `position` is the order the editor paints, not an id.
        let gapped = json!([
            live_row(3, 7, "10:00", "14:00", 0),
            live_row(3, 9, "17:00", "20:00", 0),
        ]);
        let out =
            confirm_business_hours_pure(input_with_reads(json!({}), week_reads(gapped))).expect("ok");

        let inserts = ops_named(&out, "schedules._insert_business_hours");
        let positions: Vec<i64> = inserts
            .iter()
            .map(|o| o.params["position"].as_i64().unwrap())
            .collect();
        assert_eq!(positions, vec![0, 1]);
    }

    #[test]
    fn confirming_carries_the_legacy_break_of_an_old_row_over() {
        // Rows written before schedules#8 still hold the break in its own pair of columns. Writing
        // NULL there would take a lunch break away from a business that only said «yes, this is my
        // week» — the one thing this command promises never to do.
        let old = json!([{ "id": "old-1", "day_of_week": 1, "position": 0, "open_time": "09:00",
            "close_time": "18:00", "is_closed": 0, "break_start": "13:00", "break_end": "14:00",
            "created_by": "system" }]);
        let out =
            confirm_business_hours_pure(input_with_reads(json!({}), week_reads(old))).expect("ok");

        let insert = ops_named(&out, "schedules._insert_business_hours")[0];
        assert_eq!(insert.params["break_start"], "13:00");
        assert_eq!(insert.params["break_end"], "14:00");
    }

    #[test]
    fn confirming_a_week_that_is_not_there_is_refused() {
        // Nothing to sign. Writing nothing and answering «done» would tick the checklist step on a
        // hub with NO hours — exactly the state schedules#36 seeded the week to make unreachable.
        let empty =
            confirm_business_hours_pure(input_with_reads(json!({}), week_reads(json!([])))).unwrap();
        assert_clean_refusal(&empty, "schedules.missing_hours");

        // The read is declared `required`, so the runtime aborts before us if it fails; if it ever
        // arrives missing, the answer is still a refusal and never a silent success.
        let no_read = confirm_business_hours_pure(input(json!({}))).unwrap();
        assert_clean_refusal(&no_read, "schedules.missing_hours");
    }

    #[test]
    fn confirming_re_signs_a_week_a_person_already_saved() {
        // The button only shows while the week is still ours, but the command is a public door
        // (the assistant, a flow). Re-signing an already-signed week is a no-op on the hours and
        // must not be refused: the answer to «is this my week?» is yes either way.
        let mine = json!([{ "id": "u-1", "day_of_week": 0, "position": 0, "open_time": "10:00",
            "close_time": "14:00", "is_closed": 0, "break_start": Value::Null,
            "break_end": Value::Null, "created_by": "u-owner" }]);
        let out =
            confirm_business_hours_pure(input_with_reads(json!({}), week_reads(mine))).expect("ok");

        assert!(out.error.is_none());
        assert_eq!(ops_named(&out, "schedules._insert_business_hours").len(), 1);
        assert_eq!(out.result.as_ref().unwrap()["confirmed_days"], 1);
    }

    #[test]
    fn confirming_never_invents_an_id_when_the_batch_runs_short() {
        // Same contract as `set_business_hours`: ids come from `context.new_ids` and the guest
        // stops rather than making one up. A duplicated id would collide on the primary key and
        // roll the whole confirmation back with a plumbing error.
        let many: Vec<Value> = (0..3)
            .flat_map(|day| (0..12).map(move |i| live_row(day, i, "09:00", "10:00", 0)))
            .collect();
        let mut input = input_with_reads(json!({}), week_reads(json!(many)));
        input["context"]["new_ids"] = json!(ids(8));
        let err = confirm_business_hours_pure(input).expect_err("the host owes us more ids");
        assert!(err.contains("missing_id"), "unexpected error: {err}");
    }
}
