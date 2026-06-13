-- Schedules · esquema inicial (Postgres / Aurora cloud). Equivalente a
-- migrations/sqlite/001_init.sql — mismas tablas, índices, FK y contrato de fila del
-- hub (§2.5): hub_id + soft-delete + auditoría. Generado por paridad mecánica.
--
-- Tipos: subconjunto portable "ERPlora SQL" (ADR-0007):
--   * ids/refs → TEXT (UUIDs del runtime como texto);
--   * flags 0/1 → INTEGER (los commands bindean 0/1; Postgres no castea entero→bool);
--   * importes → NUMERIC;
--   * FECHAS → TEXT ISO-8601 (NO TIMESTAMPTZ): el motor de sync (ADR-0031) compara
--     updated_at como string lexicográfico; timestamptz rompería el LWW entre dialectos.

CREATE TABLE IF NOT EXISTS schedules_settings (
    id                 TEXT PRIMARY KEY,
    hub_id             TEXT NOT NULL,
    timezone           TEXT NOT NULL DEFAULT 'Europe/Madrid',
    week_starts_on     INTEGER NOT NULL DEFAULT 1,   -- 1=Monday .. 7=Sunday
    slot_duration      INTEGER NOT NULL DEFAULT 30,  -- minutos por slot
    auto_close_enabled INTEGER NOT NULL DEFAULT 0,
    is_deleted         INTEGER NOT NULL DEFAULT 0,
    deleted_at         TEXT,
    created_by         TEXT,
    created_at         TEXT NOT NULL,
    updated_by         TEXT,
    updated_at         TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_schedules_settings_hub ON schedules_settings (hub_id);
CREATE INDEX        IF NOT EXISTS idx_schedules_settings_hub ON schedules_settings (hub_id, is_deleted);

-- Horario semanal regular: una fila por día de la semana (ISO: 0=Monday .. 6=Sunday).
-- (hub_id, day_of_week) único por hub. break_start/break_end opcionales (descanso intradía).
CREATE TABLE IF NOT EXISTS schedules_business_hours (
    id          TEXT PRIMARY KEY,
    hub_id      TEXT NOT NULL,
    day_of_week INTEGER NOT NULL,             -- 0=Monday .. 6=Sunday
    open_time   TEXT NOT NULL,                -- 'HH:MM'
    close_time  TEXT NOT NULL,                -- 'HH:MM'
    is_closed   INTEGER NOT NULL DEFAULT 0,
    break_start TEXT,                          -- 'HH:MM' o NULL
    break_end   TEXT,                          -- 'HH:MM' o NULL
    is_deleted  INTEGER NOT NULL DEFAULT 0,
    deleted_at  TEXT,
    created_by  TEXT,
    created_at  TEXT NOT NULL,
    updated_by  TEXT,
    updated_at  TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_schedules_business_hours_hub_day ON schedules_business_hours (hub_id, day_of_week);
CREATE INDEX        IF NOT EXISTS idx_schedules_business_hours_hub     ON schedules_business_hours (hub_id, is_deleted);

-- Día especial: festivo, cierre o día con horas distintas. (hub_id, date) único por hub.
-- recurring_yearly = se repite cada año en la misma fecha (lo evalúa el motor — ver WASM-TODO).
CREATE TABLE IF NOT EXISTS schedules_special_day (
    id               TEXT PRIMARY KEY,
    hub_id           TEXT NOT NULL,
    date             TEXT NOT NULL,            -- ISO 'YYYY-MM-DD'
    name             TEXT NOT NULL,
    is_closed        INTEGER NOT NULL DEFAULT 1,
    open_time        TEXT,                     -- 'HH:MM' o NULL
    close_time       TEXT,                     -- 'HH:MM' o NULL
    recurring_yearly INTEGER NOT NULL DEFAULT 0,
    notes            TEXT NOT NULL DEFAULT '',
    is_deleted       INTEGER NOT NULL DEFAULT 0,
    deleted_at       TEXT,
    created_by       TEXT,
    created_at       TEXT NOT NULL,
    updated_by       TEXT,
    updated_at       TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_schedules_special_day_hub_date ON schedules_special_day (hub_id, date);
CREATE INDEX        IF NOT EXISTS idx_schedules_special_day_hub      ON schedules_special_day (hub_id, is_deleted);

-- Override de horario: cambio temporal sobre un rango de fechas (p.ej. horario de verano).
CREATE TABLE IF NOT EXISTS schedules_override (
    id          TEXT PRIMARY KEY,
    hub_id      TEXT NOT NULL,
    start_date  TEXT NOT NULL,                 -- ISO 'YYYY-MM-DD'
    end_date    TEXT NOT NULL,                 -- ISO 'YYYY-MM-DD'
    reason      TEXT NOT NULL,
    open_time   TEXT,                          -- 'HH:MM' o NULL
    close_time  TEXT,                          -- 'HH:MM' o NULL
    is_closed   INTEGER NOT NULL DEFAULT 0,
    is_deleted  INTEGER NOT NULL DEFAULT 0,
    deleted_at  TEXT,
    created_by  TEXT,
    created_at  TEXT NOT NULL,
    updated_by  TEXT,
    updated_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_schedules_override_hub   ON schedules_override (hub_id, is_deleted);
CREATE INDEX IF NOT EXISTS idx_schedules_override_dates ON schedules_override (hub_id, start_date, end_date);