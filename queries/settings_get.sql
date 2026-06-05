-- Configuración de horario del hub (singleton). Runtime inyecta :hub_id.
-- Portado de _get_settings / settings_page. Si no existe fila, el SDK/UI usa defaults
-- (timezone=Europe/Madrid, week_starts_on=1, slot_duration=30, auto_close_enabled=0).
SELECT id, timezone, week_starts_on, slot_duration, auto_close_enabled
FROM schedules_settings
WHERE hub_id = :hub_id AND is_deleted = 0
LIMIT 1;
