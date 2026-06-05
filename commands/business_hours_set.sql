-- Crear o actualizar el horario de un día de la semana (upsert por (hub_id, day_of_week)).
-- Runtime inyecta :new_id, :hub_id, :current_user_id, :now.
-- Portado de ScheduleService.update_business_hours / hours_edit (rama existing→update, else→insert).
-- La validación de horas (close > open, break dentro del horario) va a runtime — ver WASM-TODO.
-- open_time/close_time son TEXT 'HH:MM'; break_start/break_end pueden ser NULL.
INSERT INTO schedules_business_hours
  (id, hub_id, day_of_week, open_time, close_time, is_closed, break_start, break_end,
   is_deleted, created_by, created_at, updated_by, updated_at)
VALUES
  (:new_id, :hub_id, :day_of_week, :open_time, :close_time, :is_closed, :break_start, :break_end,
   0, :current_user_id, :now, :current_user_id, :now)
ON CONFLICT (hub_id, day_of_week) DO UPDATE SET
  open_time   = excluded.open_time,
  close_time  = excluded.close_time,
  is_closed   = excluded.is_closed,
  break_start = excluded.break_start,
  break_end   = excluded.break_end,
  is_deleted  = 0,
  deleted_at  = NULL,
  updated_by  = :current_user_id,
  updated_at  = :now;
