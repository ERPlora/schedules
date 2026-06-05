-- Alta de día especial (festivo, cierre o día con horas especiales).
-- Runtime inyecta :new_id, :hub_id, :current_user_id, :now.
-- Portado de ScheduleService.create_special_day. (hub_id, date) único lo garantiza el índice
-- uq_schedules_special_day_hub_date. La validación de horas cuando is_closed=0 (open/close
-- requeridos y close > open) va a runtime — ver WASM-TODO.
-- date es TEXT 'YYYY-MM-DD'; open_time/close_time TEXT 'HH:MM' o NULL.
INSERT INTO schedules_special_day
  (id, hub_id, date, name, is_closed, open_time, close_time, recurring_yearly, notes,
   is_deleted, created_by, created_at, updated_by, updated_at)
VALUES
  (:new_id, :hub_id, :date, :name, :is_closed, :open_time, :close_time, :recurring_yearly, :notes,
   0, :current_user_id, :now, :current_user_id, :now);
