-- 004_inspection_items.sql

-- 1. Tighten inspections_guard_fn
CREATE OR REPLACE FUNCTION inspections_guard_fn()
RETURNS TRIGGER AS $$
BEGIN
  -- If already acknowledged, ANY update is strictly forbidden (terminal state)
  IF OLD.status = 'acknowledged' THEN
    RAISE EXCEPTION 'inspection is acknowledged and cannot be modified';
  END IF;

  -- Immutable type and tenancy_id
  IF OLD.type <> NEW.type OR OLD.tenancy_id <> NEW.tenancy_id THEN
    RAISE EXCEPTION 'inspections type and tenancy_id are immutable';
  END IF;

  -- Allowing same status (no-op update) while not acknowledged
  IF OLD.status = NEW.status THEN
    RETURN NEW;
  END IF;

  -- Legal transitions: draft -> submitted, submitted -> acknowledged, submitted -> draft
  IF OLD.status = 'draft' AND NEW.status = 'submitted' THEN
    RETURN NEW;
  ELSIF OLD.status = 'submitted' AND NEW.status = 'acknowledged' THEN
    RETURN NEW;
  ELSIF OLD.status = 'submitted' AND NEW.status = 'draft' THEN
    RETURN NEW;
  ELSE
    RAISE EXCEPTION 'illegal inspection status transition from % to %', OLD.status, NEW.status;
  END IF;
END;
$$ LANGUAGE plpgsql;

-- 2. inspection_items table
CREATE TABLE IF NOT EXISTS inspection_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  inspection_id UUID NOT NULL REFERENCES inspections(id),
  room VARCHAR(80) NOT NULL CONSTRAINT inspection_items_room_check CHECK (char_length(btrim(room)) BETWEEN 1 AND 80),
  name VARCHAR(80) NOT NULL CONSTRAINT inspection_items_name_check CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
  condition VARCHAR(20) CONSTRAINT inspection_items_condition_check CHECK (condition IS NULL OR condition IN ('good', 'minor_wear', 'damaged', 'missing')),
  note VARCHAR(1000),
  position INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS inspection_items_inspection_id_lower_room_lower_name_idx
  ON inspection_items (inspection_id, lower(room), lower(name));

CREATE INDEX IF NOT EXISTS inspection_items_inspection_id_idx
  ON inspection_items (inspection_id);

-- 3. Trigger require_draft_inspection
CREATE OR REPLACE FUNCTION require_draft_inspection_fn()
RETURNS TRIGGER AS $$
DECLARE
  target_inspection_id UUID;
  inspection_status VARCHAR(20);
BEGIN
  IF TG_OP = 'DELETE' THEN
    target_inspection_id := OLD.inspection_id;
  ELSE
    target_inspection_id := NEW.inspection_id;
  END IF;

  -- On UPDATE, items cannot move to another inspection
  IF TG_OP = 'UPDATE' AND OLD.inspection_id <> NEW.inspection_id THEN
    RAISE EXCEPTION 'LOCKED: inspection items cannot be moved between inspections';
  END IF;

  -- Read parent inspection with FOR SHARE to lock against concurrent status changes
  SELECT status INTO inspection_status
  FROM inspections
  WHERE id = target_inspection_id
  FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Parent inspection not found';
  END IF;

  IF inspection_status <> 'draft' THEN
    RAISE EXCEPTION 'LOCKED: parent inspection is not in draft status (current: %)', inspection_status;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  ELSE
    RETURN NEW;
  END IF;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS require_draft_inspection ON inspection_items;
CREATE TRIGGER require_draft_inspection
  BEFORE INSERT OR UPDATE OR DELETE ON inspection_items
  FOR EACH ROW
  EXECUTE FUNCTION require_draft_inspection_fn();
