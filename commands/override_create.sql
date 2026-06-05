-- Alta de override de horario (cambio temporal por rango de fechas).
-- Runtime inyecta :new_id, :hub_id, :current_user_id, :now.
-- Portado de special_day_add (rama type='override'). La validación de rango
-- (end_date >= start_date) y de horas cuando is_closed=0 va a runtime — ver WASM-TODO.
-- start_date/end_date TEXT 'YYYY-MM-DD'; open_time/close_time TEXT 'HH:MM' o NULL.
INSERT INTO schedules_override
  (id, hub_id, start_date, end_date, reason, open_time, close_time, is_closed,
   is_deleted, created_by, created_at, updated_by, updated_at)
VALUES
  (:new_id, :hub_id, :start_date, :end_date, :reason, :open_time, :close_time, :is_closed,
   0, :current_user_id, :now, :current_user_id, :now);
