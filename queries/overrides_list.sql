-- Overrides de horario del hub (cambios temporales por rango de fechas), más recientes primero.
-- Runtime inyecta :hub_id. Portado de special_days_list (ScheduleOverride.order_by start_date desc).
SELECT id, start_date, end_date, reason, open_time, close_time, is_closed
FROM schedules_override
WHERE hub_id = :hub_id AND is_deleted = 0
