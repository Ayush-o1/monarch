import { pool as defaultPool } from '../../db/pool.js';
import defaultStorage from '../../lib/storage/local.js';
import { recordEvent as defaultRecordEvent } from '../../lib/events.js';
import { AppError } from '../../lib/errors.js';
import { hashToken } from '../../lib/tokens.js';
import { compareInspections } from '../../lib/comparison.js';
import { fetchInspectionItemsWithMedia } from '../tenancies/service.js';
import { getSettlementData } from '../deductions/service.js';

export async function validateAndGetInvite(token, pool = defaultPool) {
  const tokenHash = hashToken(token);

  const res = await pool.query(
    `SELECT inv.id, inv.tenancy_id, inv.expires_at, inv.revoked_at, inv.last_used_at
     FROM invites inv
     WHERE inv.token_hash = $1`,
    [tokenHash]
  );

  if (res.rowCount === 0) {
    throw new AppError(404, 'INVALID_LINK', 'This link is not valid');
  }

  const invite = res.rows[0];

  if (invite.revoked_at !== null) {
    throw new AppError(
      410,
      'LINK_REVOKED',
      'This link has expired or was replaced. Ask the tenant for a new link'
    );
  }

  if (new Date(invite.expires_at) <= new Date()) {
    throw new AppError(
      410,
      'LINK_EXPIRED',
      'This link has expired or was replaced. Ask the tenant for a new link'
    );
  }

  // Update last_used_at at most once per minute
  await pool
    .query(
      `UPDATE invites
       SET last_used_at = now()
       WHERE id = $1
         AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute')`,
      [invite.id]
    )
    .catch((err) => {
      console.warn('Failed to update last_used_at on invite:', err.message);
    });

  return {
    inviteId: invite.id,
    tenancyId: invite.tenancy_id,
  };
}

export async function getLandlordTenancy(tenancyId, pool = defaultPool) {
  const tRes = await pool.query(
    `SELECT t.property_label, t.address, t.landlord_name, t.deposit_paise,
            t.refund_window_days, t.lease_start_date, t.status,
            u.name AS tenant_name
     FROM tenancies t
     JOIN users u ON u.id = t.tenant_id
     WHERE t.id = $1`,
    [tenancyId]
  );

  if (tRes.rowCount === 0) {
    throw new AppError(404, 'NOT_FOUND', 'Tenancy not found');
  }

  const t = tRes.rows[0];

  // Include only inspections whose status is submitted or acknowledged (drafts are invisible)
  const inspRes = await pool.query(
    `SELECT id, type, status, submitted_at, acknowledged_at, acknowledged_by_name
     FROM inspections
     WHERE tenancy_id = $1 AND status IN ('submitted', 'acknowledged')
     ORDER BY created_at ASC`,
    [tenancyId]
  );

  const inspectionsList = inspRes.rows;
  const itemsByInspection = new Map();
  const mediaByItem = new Map();

  if (inspectionsList.length > 0) {
    const inspIds = inspectionsList.map((i) => i.id);

    const itemsRes = await pool.query(
      `SELECT id, inspection_id, room, name, condition, note, position
       FROM inspection_items
       WHERE inspection_id = ANY($1::uuid[])
       ORDER BY position ASC, created_at ASC`,
      [inspIds]
    );

    const itemIds = itemsRes.rows.map((it) => it.id);

    if (itemIds.length > 0) {
      const mediaRes = await pool.query(
        `SELECT id, item_id
         FROM media
         WHERE item_id = ANY($1::uuid[])
         ORDER BY uploaded_at ASC`,
        [itemIds]
      );

      for (const m of mediaRes.rows) {
        if (!mediaByItem.has(m.item_id)) {
          mediaByItem.set(m.item_id, []);
        }
        mediaByItem.get(m.item_id).push({ id: m.id });
      }
    }

    for (const item of itemsRes.rows) {
      if (!itemsByInspection.has(item.inspection_id)) {
        itemsByInspection.set(item.inspection_id, []);
      }
      itemsByInspection.get(item.inspection_id).push({
        id: item.id,
        room: item.room,
        name: item.name,
        condition: item.condition,
        note: item.note,
        media: mediaByItem.get(item.id) || [],
      });
    }
  }

  const settlementData = await getSettlementData(tenancyId, pool);

  return {
    tenancy: {
      propertyLabel: t.property_label,
      address: t.address,
      landlordName: t.landlord_name,
      depositPaise: Number(t.deposit_paise),
      refundWindowDays: t.refund_window_days,
      leaseStartDate: t.lease_start_date,
      status: t.status,
      tenantName: t.tenant_name,
    },
    inspections: inspectionsList.map((i) => ({
      id: i.id,
      type: i.type,
      status: i.status,
      submittedAt: i.submitted_at,
      acknowledgedAt: i.acknowledged_at,
      acknowledgedByName: i.acknowledged_by_name,
      items: itemsByInspection.get(i.id) || [],
    })),
    settlement: settlementData.settlement,
    deductionLines: settlementData.lines,
    moveOutItems: settlementData.moveOutItems,
  };
}

export async function getLandlordMediaStream(
  tenancyId,
  mediaId,
  { pool = defaultPool, storage = defaultStorage } = {}
) {
  const res = await pool.query(
    `SELECT m.id, m.storage_key, m.mime
     FROM media m
     JOIN inspection_items item ON item.id = m.item_id
     JOIN inspections i ON i.id = item.inspection_id
     WHERE m.id = $1
       AND i.tenancy_id = $2
       AND i.status IN ('submitted', 'acknowledged')`,
    [mediaId, tenancyId]
  );

  if (res.rowCount === 0) {
    throw new AppError(404, 'NOT_FOUND', 'Media not found');
  }

  const media = res.rows[0];

  try {
    const stream = storage.createReadStream(media.storage_key);
    return { stream, mime: media.mime };
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new AppError(404, 'NOT_FOUND', 'Media file not found');
    }
    throw err;
  }
}

export async function acknowledgeInspection(
  tenancyId,
  inspectionId,
  name,
  { pool = defaultPool, recordEventFn = defaultRecordEvent } = {}
) {
  // Use ONE conditional update
  const res = await pool.query(
    `UPDATE inspections
     SET status = 'acknowledged', acknowledged_at = now(), acknowledged_by_name = $1
     WHERE id = $2 AND tenancy_id = $3 AND status = 'submitted'
     RETURNING *`,
    [name, inspectionId, tenancyId]
  );

  if (res.rowCount === 0) {
    const check = await pool.query(
      `SELECT id, status FROM inspections WHERE id = $1 AND tenancy_id = $2`,
      [inspectionId, tenancyId]
    );

    if (check.rowCount === 0) {
      throw new AppError(404, 'NOT_FOUND', 'Inspection not found');
    }

    throw new AppError(
      409,
      'INVALID_STATE',
      'Inspection is not in submitted status'
    );
  }

  await recordEventFn(pool, {
    tenancyId,
    actorType: 'landlord',
    actorLabel: name,
    type: 'inspection_acknowledged',
    payload: {
      inspectionId,
    },
  });

  return res.rows[0];
}

export async function requestChangesInspection(
  tenancyId,
  inspectionId,
  { name, note },
  { pool = defaultPool, recordEventFn = defaultRecordEvent } = {}
) {
  // Check inspection type and tenancy status
  const check = await pool.query(
    `SELECT i.type, i.status AS inspection_status, t.status AS tenancy_status
     FROM inspections i
     JOIN tenancies t ON t.id = i.tenancy_id
     WHERE i.id = $1 AND i.tenancy_id = $2`,
    [inspectionId, tenancyId]
  );

  if (check.rowCount === 0) {
    throw new AppError(404, 'NOT_FOUND', 'Inspection not found');
  }

  const {
    type,
    inspection_status: inspectionStatus,
    tenancy_status: tenancyStatus,
  } = check.rows[0];

  if (type !== 'move_in') {
    throw new AppError(
      409,
      'INVALID_STATE',
      'Changes can only be requested for move-in inspections'
    );
  }

  if (tenancyStatus !== 'active') {
    throw new AppError(
      409,
      'INVALID_STATE',
      'Tenancy must be active to request changes'
    );
  }

  if (inspectionStatus !== 'submitted') {
    throw new AppError(
      409,
      'INVALID_STATE',
      'Inspection must be in submitted status to request changes'
    );
  }

  // One conditional update: status='draft', submitted_at=NULL
  const updateRes = await pool.query(
    `UPDATE inspections
     SET status = 'draft', submitted_at = NULL
     WHERE id = $1 AND tenancy_id = $2 AND status = 'submitted'
     RETURNING *`,
    [inspectionId, tenancyId]
  );

  if (updateRes.rowCount === 0) {
    throw new AppError(
      409,
      'INVALID_STATE',
      'Inspection status change could not be applied'
    );
  }

  await recordEventFn(pool, {
    tenancyId,
    actorType: 'landlord',
    actorLabel: name,
    type: 'changes_requested',
    payload: {
      inspectionId,
      note,
    },
  });

  return updateRes.rows[0];
}

export async function getLandlordComparison(tenancyId, pool = defaultPool) {
  const tRes = await pool.query(
    `SELECT t.property_label, t.address, t.landlord_name, t.deposit_paise,
            t.refund_window_days, t.lease_start_date, t.status,
            u.name AS tenant_name
     FROM tenancies t
     JOIN users u ON u.id = t.tenant_id
     WHERE t.id = $1`,
    [tenancyId]
  );

  if (tRes.rowCount === 0) {
    throw new AppError(404, 'NOT_FOUND', 'Tenancy not found');
  }

  const t = tRes.rows[0];

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
      propertyLabel: t.property_label,
      address: t.address,
      landlordName: t.landlord_name,
      depositPaise: Number(t.deposit_paise),
      refundWindowDays: t.refund_window_days,
      leaseStartDate: t.lease_start_date,
      status: t.status,
      tenantName: t.tenant_name,
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
