-- Borrado lógico (soft-delete) de un día especial. Runtime inyecta :current_user_id, :now.
-- Portado de ScheduleService.delete_special_day / special_day_delete.
UPDATE schedules_special_day
SET is_deleted = 1,
    deleted_at = :now,
    updated_by = :current_user_id,
    updated_at = :now
WHERE id = :special_day_id AND hub_id = :hub_id AND is_deleted = 0;
