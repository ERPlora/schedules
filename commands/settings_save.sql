-- Crear o actualizar la configuración de horario del hub (upsert por hub_id, singleton).
-- Runtime inyecta :new_id, :hub_id, :current_user_id, :now.
-- El índice único uq_schedules_settings_hub garantiza un único registro por hub.
--
-- schedules#9: este command escribe UNA sola cosa, `week_starts_on`, porque es el único ajuste que
-- este módulo posee y que algo obedece (el orden de la tabla semanal).
--   * `timezone` es del CORE (hub#731/hub#1022): el runtime la resuelve y la entrega como
--     `context.timezone` / `:timezone`. Guardar aquí otra era una SEGUNDA autoridad que el motor
--     no leía nunca. La columna se queda (borrarla es destructivo y no la lee nadie) con su
--     valor: al insertar, el DEFAULT; al actualizar, lo que ya hubiera.
--   * `slot_duration` y `auto_close_enabled` no los consume nadie — la duración es del servicio
--     (schedules#8) y nada ejecuta el auto-cierre.
INSERT INTO schedules_settings
  (id, hub_id, week_starts_on,
   is_deleted, created_by, created_at, updated_by, updated_at)
VALUES
  (:new_id, :hub_id, :week_starts_on,
   0, :current_user_id, :now, :current_user_id, :now)
ON CONFLICT (hub_id) DO UPDATE SET
  week_starts_on     = excluded.week_starts_on,
  is_deleted         = 0,
  deleted_at         = NULL,
  updated_by         = :current_user_id,
  updated_at         = :now;
