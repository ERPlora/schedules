-- Días especiales del hub (festivos, cierres, horas especiales) ordenados por fecha.
-- Runtime inyecta :hub_id. Portado de ScheduleService.list_special_days / special_days_list.
-- El filtro include_past (date >= hoy) se aplica en el SDK/UI; aquí devolvemos todos.
SELECT id, date, name, is_closed, open_time, close_time, recurring_yearly, notes
FROM schedules_special_day
WHERE hub_id = :hub_id AND is_deleted = 0
