-- PG-compat (auditoría pm#16, 07-17): los binds BOOLEANOS del schema van envueltos en
-- CASE WHEN :x THEN 1 WHEN NOT :x THEN 0 END — las columnas son INTEGER 0/1 por contrato
-- (§2.5) y Postgres NO castea boolean→bigint (SQLite sí lo toleraba). El tri-estado
-- preserva NULL para los COALESCE de opcionales.
-- Crear o actualizar la configuración de horario del hub (upsert por hub_id, singleton).
-- Runtime inyecta :new_id, :hub_id, :current_user_id, :now.
-- Portado de _get_settings + settings_save. El índice único uq_schedules_settings_hub
-- garantiza un único registro por hub.
INSERT INTO schedules_settings
  (id, hub_id, timezone, week_starts_on, slot_duration, auto_close_enabled,
   is_deleted, created_by, created_at, updated_by, updated_at)
VALUES
  (:new_id, :hub_id, :timezone, :week_starts_on, :slot_duration, CASE WHEN :auto_close_enabled THEN 1 WHEN NOT :auto_close_enabled THEN 0 END,
   0, :current_user_id, :now, :current_user_id, :now)
ON CONFLICT (hub_id) DO UPDATE SET
  timezone           = excluded.timezone,
  week_starts_on     = excluded.week_starts_on,
  slot_duration      = excluded.slot_duration,
  auto_close_enabled = excluded.auto_close_enabled,
  is_deleted         = 0,
  deleted_at         = NULL,
  updated_by         = :current_user_id,
  updated_at         = :now;
