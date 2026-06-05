-- Horario semanal regular del hub, ordenado por día (0=Monday .. 6=Sunday).
-- Runtime inyecta :hub_id. Portado de ScheduleService.get_business_hours / dashboard.
SELECT id, day_of_week, open_time, close_time, is_closed, break_start, break_end
FROM schedules_business_hours
WHERE hub_id = :hub_id AND is_deleted = 0
ORDER BY day_of_week ASC;
