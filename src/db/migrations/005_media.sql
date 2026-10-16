-- Migration 005: media table and draft-only lock trigger
CREATE TABLE media (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id UUID NOT NULL REFERENCES inspection_items(id) ON DELETE CASCADE,
  storage_key TEXT NOT NULL UNIQUE,
  sha256 CHAR(64) NOT NULL,
  mime TEXT NOT NULL CHECK (mime = 'image/jpeg'),
  size_bytes INTEGER NOT NULL CHECK (size_bytes > 0),
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (item_id, sha256)
);

CREATE INDEX media_item_id_idx ON media(item_id);

CREATE OR REPLACE FUNCTION require_draft_media_fn()
RETURNS TRIGGER AS $$
DECLARE
  target_item_id UUID;
  inspection_status VARCHAR(20);
BEGIN
  IF TG_OP = 'DELETE' THEN
    target_item_id := OLD.item_id;
  ELSE
    target_item_id := NEW.item_id;
  END IF;

  -- On UPDATE, media item_id is immutable
  IF TG_OP = 'UPDATE' AND OLD.item_id <> NEW.item_id THEN
    RAISE EXCEPTION 'LOCKED: media item_id is immutable';
  END IF;

  -- Resolve parent inspection with FOR SHARE to lock against concurrent status changes
  SELECT i.status INTO inspection_status
  FROM inspection_items item
  JOIN inspections i ON i.id = item.inspection_id
  WHERE item.id = target_item_id
  FOR SHARE OF i;

  IF TG_OP = 'DELETE' THEN
    -- If parent item exists, verify parent inspection is in draft status
    IF FOUND AND inspection_status <> 'draft' THEN
      RAISE EXCEPTION 'LOCKED: parent inspection is not in draft status (current: %)', inspection_status;
    END IF;
    -- If parent item is not found, it is cascading from item delete (which verified draft)
    RETURN OLD;
  ELSE
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Parent inspection item not found';
    END IF;

    IF inspection_status <> 'draft' THEN
      RAISE EXCEPTION 'LOCKED: parent inspection is not in draft status (current: %)', inspection_status;
    END IF;

    RETURN NEW;
  END IF;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER require_draft_media
BEFORE INSERT OR UPDATE OR DELETE ON media
FOR EACH ROW EXECUTE FUNCTION require_draft_media_fn();
