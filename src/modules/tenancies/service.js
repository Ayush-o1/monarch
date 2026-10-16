import { pool as defaultPool } from '../../db/pool.js';
import { recordEvent as defaultRecordEvent } from '../../lib/events.js';
import { AppError } from '../../lib/errors.js';

export async function createTenancy(
  data,
  { pool = defaultPool, recordEventFn = defaultRecordEvent } = {}
) {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const propertyLabel = (
      data.property_label ??
      data.propertyLabel ??
      ''
    ).trim();
    const address = data.address ? data.address.trim() : null;
    const landlordName =
      (data.landlord_name ?? data.landlordName ?? '').trim() || null;
    const depositPaise = data.deposit_paise ?? data.depositPaise;
    const refundWindowDays =
      data.refund_window_days !== undefined
        ? data.refund_window_days
        : data.refundWindowDays !== undefined
          ? data.refundWindowDays
          : null;
    const leaseStartDate = data.lease_start_date ?? data.leaseStartDate ?? null;
    const tenantId = data.tenant_id ?? data.tenantId;
    const actorName = data.actor_label ?? data.actorName ?? 'Tenant';

    // 1. Create tenancy
    const tenancyRes = await client.query(
      `INSERT INTO tenancies (
        tenant_id, property_label, address, landlord_name,
        deposit_paise, refund_window_days, lease_start_date, status
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'active')
      RETURNING *`,
      [
        tenantId,
        propertyLabel,
        address,
        landlordName,
        depositPaise,
        refundWindowDays,
        leaseStartDate,
      ]
    );
    const tenancy = tenancyRes.rows[0];

    // 2. Create move_in draft inspection
    const inspectionRes = await client.query(
      `INSERT INTO inspections (tenancy_id, type, status)
       VALUES ($1, 'move_in', 'draft')
       RETURNING *`,
      [tenancy.id]
    );
    const moveInInspection = inspectionRes.rows[0];

    // 3. Record tenancy_created event
    await recordEventFn(client, {
      tenancyId: tenancy.id,
      actorType: 'tenant',
      actorLabel: actorName,
      type: 'tenancy_created',
      payload: {
        propertyLabel: tenancy.property_label,
        depositPaise: Number(tenancy.deposit_paise),
        refundWindowDays: tenancy.refund_window_days,
        leaseStartDate: tenancy.lease_start_date,
      },
    });

    await client.query('COMMIT');

    return {
      ...tenancy,
      deposit_paise: Number(tenancy.deposit_paise),
      inspections: {
        moveIn: moveInInspection,
        moveOut: null,
      },
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function listTenancies(tenantId, pool = defaultPool) {
  const res = await pool.query(
    `SELECT t.*,
            m_in.status AS move_in_status,
            m_out.status AS move_out_status
     FROM tenancies t
     LEFT JOIN inspections m_in ON m_in.tenancy_id = t.id AND m_in.type = 'move_in'
     LEFT JOIN inspections m_out ON m_out.tenancy_id = t.id AND m_out.type = 'move_out'
     WHERE t.tenant_id = $1
     ORDER BY t.created_at DESC`,
    [tenantId]
  );

  return res.rows.map((row) => ({
    ...row,
    deposit_paise: Number(row.deposit_paise),
  }));
}

export async function getTenancyById(id, tenantId, pool = defaultPool) {
  const tenancyRes = await pool.query(
    `SELECT * FROM tenancies WHERE id = $1 AND tenant_id = $2`,
    [id, tenantId]
  );

  if (tenancyRes.rowCount === 0) {
    throw new AppError(404, 'NOT_FOUND', 'Tenancy not found');
  }

  const tenancy = tenancyRes.rows[0];

  const inspectionsRes = await pool.query(
    `SELECT id, type, status, submitted_at, acknowledged_at, acknowledged_by_name, created_at
     FROM inspections
     WHERE tenancy_id = $1`,
    [id]
  );

  const inspections = {
    moveIn: inspectionsRes.rows.find((i) => i.type === 'move_in') || null,
    moveOut: inspectionsRes.rows.find((i) => i.type === 'move_out') || null,
  };

  return {
    ...tenancy,
    deposit_paise: Number(tenancy.deposit_paise),
    inspections,
    invite: null,
  };
}

export async function getTenancyEvents(id, tenantId, pool = defaultPool) {
  const check = await pool.query(
    `SELECT id FROM tenancies WHERE id = $1 AND tenant_id = $2`,
    [id, tenantId]
  );

  if (check.rowCount === 0) {
    throw new AppError(404, 'NOT_FOUND', 'Tenancy not found');
  }

  const res = await pool.query(
    `SELECT id, tenancy_id, actor_type, actor_label, type, payload, created_at
     FROM events
     WHERE tenancy_id = $1
     ORDER BY id ASC`,
    [id]
  );

  return res.rows.map((row) => ({
    ...row,
    id: String(row.id),
  }));
}
