-- 007_deduction_lines.sql

CREATE TABLE IF NOT EXISTS deduction_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenancy_id UUID NOT NULL REFERENCES tenancies(id),
  item_id UUID NULL REFERENCES inspection_items(id),
  description VARCHAR(300) NOT NULL CONSTRAINT deduction_lines_description_check CHECK (char_length(btrim(description)) BETWEEN 1 AND 300),
  amount_paise BIGINT NOT NULL CONSTRAINT deduction_lines_amount_paise_check CHECK (amount_paise > 0 AND amount_paise <= 1000000000),
  status VARCHAR(20) NOT NULL DEFAULT 'proposed' CONSTRAINT deduction_lines_status_check CHECK (status IN ('proposed', 'accepted', 'disputed', 'withdrawn')),
  tenant_note VARCHAR(500) NULL,
  created_by_name VARCHAR(80) NOT NULL CONSTRAINT deduction_lines_created_by_name_check CHECK (char_length(btrim(created_by_name)) BETWEEN 1 AND 80),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  responded_at TIMESTAMPTZ NULL
);

CREATE INDEX IF NOT EXISTS deduction_lines_tenancy_id_idx ON deduction_lines (tenancy_id);
CREATE INDEX IF NOT EXISTS deduction_lines_item_id_idx ON deduction_lines (item_id);

-- Trigger deduction_lines_guard (BEFORE UPDATE)
CREATE OR REPLACE FUNCTION deduction_lines_guard_fn()
RETURNS TRIGGER AS $$
BEGIN
  -- Immutable columns
  IF OLD.tenancy_id <> NEW.tenancy_id THEN
    RAISE EXCEPTION 'ILLEGAL: tenancy_id is immutable';
  END IF;

  IF OLD.item_id IS DISTINCT FROM NEW.item_id THEN
    RAISE EXCEPTION 'ILLEGAL: item_id is immutable';
  END IF;

  IF OLD.amount_paise <> NEW.amount_paise THEN
    RAISE EXCEPTION 'ILLEGAL: amount_paise is immutable';
  END IF;

  IF OLD.description <> NEW.description THEN
    RAISE EXCEPTION 'ILLEGAL: description is immutable';
  END IF;

  IF OLD.created_by_name <> NEW.created_by_name THEN
    RAISE EXCEPTION 'ILLEGAL: created_by_name is immutable';
  END IF;

  IF OLD.created_at <> NEW.created_at THEN
    RAISE EXCEPTION 'ILLEGAL: created_at is immutable';
  END IF;

  -- Same status update check:
  IF OLD.status = NEW.status THEN
    IF OLD.tenant_note IS DISTINCT FROM NEW.tenant_note OR
       OLD.responded_at IS DISTINCT FROM NEW.responded_at THEN
      RAISE EXCEPTION 'ILLEGAL: fields cannot change without a legal status transition';
    END IF;
    NEW.updated_at = now();
    RETURN NEW;
  END IF;

  -- Terminal states cannot transition to anything
  IF OLD.status IN ('accepted', 'withdrawn') THEN
    RAISE EXCEPTION 'ILLEGAL: deduction line is % and cannot be modified', OLD.status;
  END IF;

  -- Legal status changes:
  -- proposed -> accepted, proposed -> disputed, proposed -> withdrawn
  -- disputed -> accepted, disputed -> withdrawn
  IF OLD.status = 'proposed' AND NEW.status IN ('accepted', 'disputed', 'withdrawn') THEN
    NEW.updated_at = now();
    RETURN NEW;
  ELSIF OLD.status = 'disputed' AND NEW.status IN ('accepted', 'withdrawn') THEN
    NEW.updated_at = now();
    RETURN NEW;
  ELSE
    RAISE EXCEPTION 'ILLEGAL: illegal status transition from % to %', OLD.status, NEW.status;
  END IF;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS deduction_lines_guard ON deduction_lines;
CREATE TRIGGER deduction_lines_guard
  BEFORE UPDATE ON deduction_lines
  FOR EACH ROW
  EXECUTE FUNCTION deduction_lines_guard_fn();

-- Trigger deduction_cap_guard (BEFORE INSERT OR UPDATE)
CREATE OR REPLACE FUNCTION deduction_cap_guard_fn()
RETURNS TRIGGER AS $$
DECLARE
  v_deposit_paise BIGINT;
  v_claimed_paise BIGINT;
BEGIN
  -- If this line is withdrawn, it does not count against cap
  IF NEW.status = 'withdrawn' THEN
    RETURN NEW;
  END IF;

  -- Lock the tenancy row to serialize cap checks
  SELECT deposit_paise INTO v_deposit_paise
  FROM tenancies
  WHERE id = NEW.tenancy_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ILLEGAL: tenancy not found';
  END IF;

  -- Calculate sum of other non-withdrawn lines
  IF TG_OP = 'INSERT' THEN
    SELECT COALESCE(SUM(amount_paise), 0) INTO v_claimed_paise
    FROM deduction_lines
    WHERE tenancy_id = NEW.tenancy_id AND status <> 'withdrawn';
  ELSE -- UPDATE
    SELECT COALESCE(SUM(amount_paise), 0) INTO v_claimed_paise
    FROM deduction_lines
    WHERE tenancy_id = NEW.tenancy_id AND status <> 'withdrawn' AND id <> NEW.id;
  END IF;

  IF (v_claimed_paise + NEW.amount_paise) > v_deposit_paise THEN
    RAISE EXCEPTION 'CAP: total deductions (%) exceed deposit amount (%)', (v_claimed_paise + NEW.amount_paise), v_deposit_paise;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS deduction_cap_guard ON deduction_lines;
CREATE TRIGGER deduction_cap_guard
  BEFORE INSERT OR UPDATE ON deduction_lines
  FOR EACH ROW
  EXECUTE FUNCTION deduction_cap_guard_fn();
