-- Borrado lógico (soft-delete) de un override de horario. Runtime inyecta :current_user_id, :now.
-- No existe en el legacy (las vistas HTMX no exponían borrado de overrides) pero es el
-- complemento CRUD natural de override_create y mantiene la simetría con special_day_delete.
UPDATE schedules_override
SET is_deleted = 1,
    deleted_at = :now,
    updated_by = :current_user_id,
    updated_at = :now
WHERE id = :override_id AND hub_id = :hub_id AND is_deleted = 0;
