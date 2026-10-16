-- Migration 006: invites table with token hash and active link constraint
CREATE TABLE invites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenancy_id UUID NOT NULL REFERENCES tenancies(id),
  token_hash CHAR(64) NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ NULL,
  last_used_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX invites_tenancy_active_unique_idx ON invites (tenancy_id) WHERE revoked_at IS NULL;
CREATE INDEX invites_tenancy_id_idx ON invites (tenancy_id);
