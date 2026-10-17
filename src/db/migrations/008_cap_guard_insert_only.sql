-- 008_cap_guard_insert_only.sql
-- Recreate deduction_cap_guard trigger as BEFORE INSERT only.
-- Deduction line amounts, tenancy_id, and item_id are immutable once created,
-- and withdrawn/accepted are terminal states. Restricting the cap check to INSERT
-- ensures UPDATE operations are governed solely by deduction_lines_guard,
-- preventing false CAP triggers when updating withdrawn or terminal lines.

DROP TRIGGER IF EXISTS deduction_cap_guard ON deduction_lines;

CREATE TRIGGER deduction_cap_guard
  BEFORE INSERT ON deduction_lines
  FOR EACH ROW
  EXECUTE FUNCTION deduction_cap_guard_fn();
