-- Alta tolerante de día especial — intención emitida por el handler WASM
-- `bulk_create_special_days` (un INSERT por item válido del lote). Si la fecha ya
-- existe para el hub (índice único uq_schedules_special_day_hub_date), se SALTA en
-- silencio (semántica "skip existing" del bulk legacy) en vez de abortar la
-- transacción del lote completo. Runtime inyecta :new_id, :hub_id, :current_user_id, :now.
INSERT INTO schedules_special_day
  (id, hub_id, date, name, is_closed, open_time, close_time, recurring_yearly, notes,
   is_deleted, created_by, created_at, updated_by, updated_at)
VALUES
  (:new_id, :hub_id, :date, :name, :is_closed, :open_time, :close_time, :recurring_yearly, :notes,
   0, :current_user_id, :now, :current_user_id, :now)
ON CONFLICT (hub_id, date) DO NOTHING;
