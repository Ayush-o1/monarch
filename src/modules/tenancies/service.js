import config from '../../config.js';
import { pool as defaultPool } from '../../db/pool.js';
import { recordEvent as defaultRecordEvent } from '../../lib/events.js';
import { AppError } from '../../lib/errors.js';
import { generateToken, hashToken } from '../../lib/tokens.js';
import { compareInspections } from '../../lib/comparison.js';

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

  function formatInspectionSummary(row) {
    if (!row) return null;
    return {
      id: row.id,
      type: row.type,
      status: row.status,
      submittedAt: row.submitted_at,
      acknowledgedAt: row.acknowledged_at,
      acknowledgedByName: row.acknowledged_by_name,
      createdAt: row.created_at,
      // Retain snake_case for backward compatibility
      submitted_at: row.submitted_at,
      acknowledged_at: row.acknowledged_at,
      acknowledged_by_name: row.acknowledged_by_name,
      created_at: row.created_at,
    };
  }

  const inspections = {
    moveIn: formatInspectionSummary(
      inspectionsRes.rows.find((i) => i.type === 'move_in')
    ),
    moveOut: formatInspectionSummary(
      inspectionsRes.rows.find((i) => i.type === 'move_out')
    ),
  };

  const inviteRes = await pool.query(
    `SELECT expires_at, last_used_at, revoked_at
     FROM invites
     WHERE tenancy_id = $1 AND revoked_at IS NULL
     ORDER BY created_at DESC
     LIMIT 1`,
    [id]
  );

  let invite = { active: false, expiresAt: null, lastUsedAt: null };
  if (inviteRes.rowCount > 0) {
    const row = inviteRes.rows[0];
    const isExpired = new Date(row.expires_at) <= new Date();
    invite = {
      active: !isExpired,
      expiresAt: row.expires_at,
      lastUsedAt: row.last_used_at,
    };
  }

  return {
    ...tenancy,
    deposit_paise: Number(tenancy.deposit_paise),
    inspections,
    invite,
  };
}

export async function createInvite(
  tenancyId,
  tenantId,
  {
    pool = defaultPool,
    recordEventFn = defaultRecordEvent,
    actorName = 'Tenant',
    publicBaseUrl = config.publicBaseUrl,
    inviteTtlDays = config.inviteTtlDays,
  } = {}
) {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // 1. Lock tenancy row FOR UPDATE, verifying ownership
    const tenancyRes = await client.query(
      `SELECT id FROM tenancies WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
      [tenancyId, tenantId]
    );

    if (tenancyRes.rowCount === 0) {
      throw new AppError(404, 'NOT_FOUND', 'Tenancy not found');
    }

    // 2. Revoke any active invite; record invite_revoked only if one was revoked
    const revokeRes = await client.query(
      `UPDATE invites
       SET revoked_at = now()
       WHERE tenancy_id = $1 AND revoked_at IS NULL
       RETURNING id`,
      [tenancyId]
    );

    if (revokeRes.rowCount > 0) {
      await recordEventFn(client, {
        tenancyId,
        actorType: 'tenant',
        actorLabel: actorName,
        type: 'invite_revoked',
        payload: {},
      });
    }

    // 3. Generate raw token and hash. Raw token exists only in the response.
    const token = generateToken();
    const tokenHash = hashToken(token);
    const ttlDays = inviteTtlDays || 30;

    const insertRes = await client.query(
      `INSERT INTO invites (tenancy_id, token_hash, expires_at)
       VALUES ($1, $2, now() + ($3 * interval '1 day'))
       RETURNING expires_at`,
      [tenancyId, tokenHash, ttlDays]
    );

    const expiresAt = insertRes.rows[0].expires_at;

    // 4. Record invite_created event
    await recordEventFn(client, {
      tenancyId,
      actorType: 'tenant',
      actorLabel: actorName,
      type: 'invite_created',
      payload: { expiresAt },
    });

    await client.query('COMMIT');

    const baseUrl = (publicBaseUrl || 'http://localhost:3000').replace(
      /\/+$/,
      ''
    );

    return {
      url: `${baseUrl}/l/${token}`,
      expiresAt,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function revokeInvite(
  tenancyId,
  tenantId,
  {
    pool = defaultPool,
    recordEventFn = defaultRecordEvent,
    actorName = 'Tenant',
  } = {}
) {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const tenancyRes = await client.query(
      `SELECT id FROM tenancies WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
      [tenancyId, tenantId]
    );

    if (tenancyRes.rowCount === 0) {
      throw new AppError(404, 'NOT_FOUND', 'Tenancy not found');
    }

    const revokeRes = await client.query(
      `UPDATE invites
       SET revoked_at = now()
       WHERE tenancy_id = $1 AND revoked_at IS NULL
       RETURNING id`,
      [tenancyId]
    );

    if (revokeRes.rowCount > 0) {
      await recordEventFn(client, {
        tenancyId,
        actorType: 'tenant',
        actorLabel: actorName,
        type: 'invite_revoked',
        payload: {},
      });
    }

    await client.query('COMMIT');
    return { success: true };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
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

export async function startMoveOut(
  tenancyId,
  tenantId,
  {
    pool = defaultPool,
    recordEventFn = defaultRecordEvent,
    actorName = 'Tenant',
  } = {}
) {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // 1. Lock tenancy row FOR UPDATE, verifying ownership
    const tenancyRes = await client.query(
      `SELECT * FROM tenancies WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
      [tenancyId, tenantId]
    );

    if (tenancyRes.rowCount === 0) {
      throw new AppError(404, 'NOT_FOUND', 'Tenancy not found');
    }

    const tenancy = tenancyRes.rows[0];

    // 2. Require tenancy status 'active'
    if (tenancy.status !== 'active') {
      throw new AppError(
        409,
        'INVALID_STATE',
        'Tenancy must be active to start move-out'
      );
    }

    // 3. Query move-in and any existing move-out inspections
    const inspectionsRes = await client.query(
      `SELECT id, type, status FROM inspections WHERE tenancy_id = $1`,
      [tenancyId]
    );

    const moveIn = inspectionsRes.rows.find((i) => i.type === 'move_in');
    const existingMoveOut = inspectionsRes.rows.find(
      (i) => i.type === 'move_out'
    );

    if (
      !moveIn ||
      (moveIn.status !== 'submitted' && moveIn.status !== 'acknowledged')
    ) {
      throw new AppError(
        409,
        'INVALID_STATE',
        'Move-in inspection must be submitted or acknowledged before starting move-out'
      );
    }

    if (existingMoveOut) {
      throw new AppError(
        409,
        'INVALID_STATE',
        'Move-out inspection already exists'
      );
    }

    // 4. Create move_out draft inspection
    const newInspRes = await client.query(
      `INSERT INTO inspections (tenancy_id, type, status)
       VALUES ($1, 'move_out', 'draft')
       RETURNING *`,
      [tenancyId]
    );
    const moveOutInspection = newInspRes.rows[0];

    // 5. Clone move-in items with blank condition and note (0 photos cloned)
    const moveInItemsRes = await client.query(
      `SELECT room, name, position
       FROM inspection_items
       WHERE inspection_id = $1
       ORDER BY position ASC, created_at ASC`,
      [moveIn.id]
    );

    let clonedCount = 0;
    for (const item of moveInItemsRes.rows) {
      await client.query(
        `INSERT INTO inspection_items (inspection_id, room, name, condition, note, position)
         VALUES ($1, $2, $3, NULL, NULL, $4)`,
        [moveOutInspection.id, item.room, item.name, item.position]
      );
      clonedCount++;
    }

    // 6. Update tenancy status to 'move_out'
    const updatedTenancyRes = await client.query(
      `UPDATE tenancies
       SET status = 'move_out', updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [tenancyId]
    );
    const updatedTenancy = updatedTenancyRes.rows[0];

    // 7. Record event move_out_started
    await recordEventFn(client, {
      tenancyId,
      actorType: 'tenant',
      actorLabel: actorName,
      type: 'move_out_started',
      payload: {
        inspectionId: moveOutInspection.id,
        itemCount: clonedCount,
      },
    });

    await client.query('COMMIT');

    return {
      tenancy: {
        ...updatedTenancy,
        deposit_paise: Number(updatedTenancy.deposit_paise),
      },
      inspection: {
        id: moveOutInspection.id,
        type: moveOutInspection.type,
        status: moveOutInspection.status,
        submittedAt: moveOutInspection.submitted_at,
        acknowledgedAt: moveOutInspection.acknowledged_at,
        acknowledgedByName: moveOutInspection.acknowledged_by_name,
        createdAt: moveOutInspection.created_at,
        submitted_at: moveOutInspection.submitted_at,
        acknowledged_at: moveOutInspection.acknowledged_at,
        acknowledged_by_name: moveOutInspection.acknowledged_by_name,
        created_at: moveOutInspection.created_at,
      },
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function fetchInspectionItemsWithMedia(pool, inspectionId) {
  const itemsRes = await pool.query(
    `SELECT id, room, name, condition, note, position
     FROM inspection_items
     WHERE inspection_id = $1
     ORDER BY position ASC, created_at ASC`,
    [inspectionId]
  );

  const items = itemsRes.rows;
  if (items.length === 0) return [];

  const itemIds = items.map((it) => it.id);
  const mediaRes = await pool.query(
    `SELECT id, item_id
     FROM media
     WHERE item_id = ANY($1::uuid[])
     ORDER BY uploaded_at ASC`,
    [itemIds]
  );

  const mediaMap = new Map();
  for (const m of mediaRes.rows) {
    if (!mediaMap.has(m.item_id)) mediaMap.set(m.item_id, []);
    mediaMap.get(m.item_id).push({ id: m.id });
  }

  return items.map((it) => ({
    id: it.id,
    room: it.room,
    name: it.name,
    condition: it.condition,
    note: it.note,
    position: it.position,
    media: mediaMap.get(it.id) || [],
  }));
}

export async function getTenancyComparison(
  tenancyId,
  tenantId,
  pool = defaultPool
) {
  const tenancyRes = await pool.query(
    `SELECT * FROM tenancies WHERE id = $1 AND tenant_id = $2`,
    [tenancyId, tenantId]
  );

  if (tenancyRes.rowCount === 0) {
    throw new AppError(404, 'NOT_FOUND', 'Tenancy not found');
  }

  const tenancy = tenancyRes.rows[0];

  const inspRes = await pool.query(
    `SELECT id, type, status, submitted_at, acknowledged_at, acknowledged_by_name
     FROM inspections
     WHERE tenancy_id = $1`,
    [tenancyId]
  );

  const moveIn = inspRes.rows.find((i) => i.type === 'move_in');
  const moveOut = inspRes.rows.find((i) => i.type === 'move_out');

  if (
    !moveOut ||
    (moveOut.status !== 'submitted' && moveOut.status !== 'acknowledged')
  ) {
    throw new AppError(
      409,
      'INVALID_STATE',
      'Move-out comparison is only available after move-out inspection is submitted'
    );
  }

  const moveInItems = moveIn
    ? await fetchInspectionItemsWithMedia(pool, moveIn.id)
    : [];
  const moveOutItems = await fetchInspectionItemsWithMedia(pool, moveOut.id);

  const comparison = compareInspections(moveInItems, moveOutItems);

  return {
    tenancy: {
      id: tenancy.id,
      propertyLabel: tenancy.property_label,
      address: tenancy.address,
      landlordName: tenancy.landlord_name,
      depositPaise: Number(tenancy.deposit_paise),
      refundWindowDays: tenancy.refund_window_days,
      leaseStartDate: tenancy.lease_start_date,
      status: tenancy.status,
    },
    moveInInspection: moveIn
      ? {
          id: moveIn.id,
          status: moveIn.status,
          submittedAt: moveIn.submitted_at,
          acknowledgedAt: moveIn.acknowledged_at,
          acknowledgedByName: moveIn.acknowledged_by_name,
        }
      : null,
    moveOutInspection: {
      id: moveOut.id,
      status: moveOut.status,
      submittedAt: moveOut.submitted_at,
      acknowledgedAt: moveOut.acknowledged_at,
      acknowledgedByName: moveOut.acknowledged_by_name,
    },
    comparison,
  };
}
