-- 003_tenancies_inspections_events.sql

CREATE TABLE IF NOT EXISTS tenancies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES users(id),
  property_label VARCHAR(80) NOT NULL CONSTRAINT tenancies_property_label_check CHECK (char_length(btrim(property_label)) BETWEEN 1 AND 80),
  address VARCHAR(300),
  landlord_name VARCHAR(80),
  deposit_paise BIGINT NOT NULL CONSTRAINT tenancies_deposit_paise_check CHECK (deposit_paise BETWEEN 1 AND 1000000000),
  refund_window_days INT CONSTRAINT tenancies_refund_window_days_check CHECK (refund_window_days BETWEEN 1 AND 365),
  lease_start_date DATE,
  status VARCHAR(20) NOT NULL DEFAULT 'active' CONSTRAINT tenancies_status_check CHECK (status IN ('active', 'move_out', 'settling', 'closed')),
  closed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS tenancies_tenant_id_created_at_idx ON tenancies (tenant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS inspections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenancy_id UUID NOT NULL REFERENCES tenancies(id),
  type VARCHAR(20) NOT NULL CONSTRAINT inspections_type_check CHECK (type IN ('move_in', 'move_out')),
  status VARCHAR(20) NOT NULL DEFAULT 'draft' CONSTRAINT inspections_status_check CHECK (status IN ('draft', 'submitted', 'acknowledged')),
  submitted_at TIMESTAMPTZ,
  acknowledged_at TIMESTAMPTZ,
  acknowledged_by_name VARCHAR(80),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT inspections_tenancy_type_unique UNIQUE (tenancy_id, type)
);

CREATE OR REPLACE FUNCTION inspections_guard_fn()
RETURNS TRIGGER AS $$
BEGIN
  -- Immutable type and tenancy_id
  IF OLD.type <> NEW.type OR OLD.tenancy_id <> NEW.tenancy_id THEN
    RAISE EXCEPTION 'inspections type and tenancy_id are immutable';
  END IF;

  -- Allowing same status (no-op update)
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

DROP TRIGGER IF EXISTS inspections_guard ON inspections;
CREATE TRIGGER inspections_guard
  BEFORE UPDATE ON inspections
  FOR EACH ROW
  EXECUTE FUNCTION inspections_guard_fn();

CREATE TABLE IF NOT EXISTS events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenancy_id UUID NOT NULL REFERENCES tenancies(id),
  actor_type VARCHAR(20) NOT NULL CONSTRAINT events_actor_type_check CHECK (actor_type IN ('tenant', 'landlord', 'system')),
  actor_label VARCHAR(80) NOT NULL,
  type VARCHAR(50) NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS events_tenancy_id_id_idx ON events (tenancy_id, id);

CREATE OR REPLACE FUNCTION events_append_only_row_fn()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'events are append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS events_append_only_row ON events;
CREATE TRIGGER events_append_only_row
  BEFORE UPDATE OR DELETE ON events
  FOR EACH ROW
  EXECUTE FUNCTION events_append_only_row_fn();

CREATE OR REPLACE FUNCTION events_append_only_stmt_fn()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'events are append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS events_append_only_stmt ON events;
CREATE TRIGGER events_append_only_stmt
  BEFORE TRUNCATE ON events
  EXECUTE FUNCTION events_append_only_stmt_fn();
