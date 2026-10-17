import { AppError } from '../../lib/errors.js';
import { recordEvent as defaultRecordEvent } from '../../lib/events.js';
import { computeSettlement } from '../../lib/settlement.js';
import { compareInspections } from '../../lib/comparison.js';

export function formatDeductionLine(row) {
  if (!row) return null;
  return {
    id: row.id,
    tenancyId: row.tenancy_id,
    itemId: row.item_id || null,
    itemRoom: row.item_room || null,
    itemName: row.item_name || null,
    description: row.description,
    amountPaise: Number(row.amount_paise),
    status: row.status,
    tenantNote: row.tenant_note || null,
    createdByName: row.created_by_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    respondedAt: row.responded_at || null,
  };
}

export async function proposeDeduction(
  tenancyId,
  { name, description, amountPaise, itemId = null },
  pool,
  recordEventFn = defaultRecordEvent
) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Lock tenancy row
    const tenancyRes = await client.query(
      `SELECT id, status, deposit_paise FROM tenancies WHERE id = $1 FOR UPDATE`,
      [tenancyId]
    );

    if (tenancyRes.rowCount === 0) {
      throw new AppError(404, 'NOT_FOUND', 'Tenancy not found');
    }

    const tenancy = tenancyRes.rows[0];

    if (tenancy.status === 'closed') {
      throw new AppError(
        409,
        'TENANCY_CLOSED',
        'Tenancy is closed and deductions cannot be proposed'
      );
    }

    if (tenancy.status !== 'settling') {
      throw new AppError(
        409,
        'INVALID_STATE',
        'Tenancy must be in settling status to propose deductions'
      );
    }

    // If itemId is provided, verify it belongs to this tenancy's move_out inspection
    if (itemId) {
      const itemCheck = await client.query(
        `SELECT ii.id
         FROM inspection_items ii
         JOIN inspections i ON i.id = ii.inspection_id
         WHERE ii.id = $1 AND i.tenancy_id = $2 AND i.type = 'move_out'`,
        [itemId, tenancyId]
      );

      if (itemCheck.rowCount === 0) {
        throw new AppError(
          422,
          'INVALID_ITEM',
          'Item does not belong to the move-out inspection of this tenancy'
        );
      }
    }

    // Check cap in service
    const sumRes = await client.query(
      `SELECT COALESCE(SUM(amount_paise), 0)::bigint AS claimed
       FROM deduction_lines
       WHERE tenancy_id = $1 AND status <> 'withdrawn'`,
      [tenancyId]
    );

    const depositPaise = Number(tenancy.deposit_paise);
    const claimedPaise = Number(sumRes.rows[0].claimed);

    if (claimedPaise + amountPaise > depositPaise) {
      throw new AppError(
        422,
        'DEDUCTIONS_EXCEED_DEPOSIT',
        'Total proposed deductions exceed deposit amount',
        {
          depositPaise,
          claimedPaise,
          remainingPaise: Math.max(0, depositPaise - claimedPaise),
        }
      );
    }

    // Insert line
    const insertRes = await client.query(
      `INSERT INTO deduction_lines (tenancy_id, item_id, description, amount_paise, created_by_name)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [tenancyId, itemId || null, description, amountPaise, name]
    );

    const line = insertRes.rows[0];

    // Record event deduction_proposed
    await recordEventFn(client, {
      tenancyId,
      actorType: 'landlord',
      actorLabel: name,
      type: 'deduction_proposed',
      payload: {
        lineId: line.id,
        itemId: line.item_id,
        amountPaise: Number(line.amount_paise),
      },
    });

    await client.query('COMMIT');
    return formatDeductionLine(line);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function respondDeduction(
  lineId,
  userId,
  { action, note = null },
  pool,
  recordEventFn = defaultRecordEvent
) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Lock tenancy and line
    const lineRes = await client.query(
      `SELECT dl.id, dl.tenancy_id, dl.status, dl.amount_paise, t.tenant_id, t.status AS tenancy_status, u.name AS user_name
       FROM deduction_lines dl
       JOIN tenancies t ON t.id = dl.tenancy_id
       LEFT JOIN users u ON u.id = t.tenant_id
       WHERE dl.id = $1
       FOR UPDATE OF t, dl`,
      [lineId]
    );

    if (lineRes.rowCount === 0 || lineRes.rows[0].tenant_id !== userId) {
      throw new AppError(404, 'NOT_FOUND', 'Deduction line not found');
    }

    const row = lineRes.rows[0];

    if (row.tenancy_status === 'closed') {
      throw new AppError(
        409,
        'TENANCY_CLOSED',
        'Tenancy is closed and deductions cannot be modified'
      );
    }

    if (row.tenancy_status !== 'settling') {
      throw new AppError(
        409,
        'INVALID_STATE',
        'Tenancy must be in settling status to respond to deductions'
      );
    }

    let updateRes;
    if (action === 'accept') {
      updateRes = await client.query(
        `UPDATE deduction_lines
         SET status = 'accepted', tenant_note = $2, responded_at = now(), updated_at = now()
         WHERE id = $1 AND status IN ('proposed', 'disputed')
         RETURNING *`,
        [lineId, note || null]
      );
    } else if (action === 'dispute') {
      updateRes = await client.query(
        `UPDATE deduction_lines
         SET status = 'disputed', tenant_note = $2, responded_at = now(), updated_at = now()
         WHERE id = $1 AND status = 'proposed'
         RETURNING *`,
        [lineId, note]
      );
    }

    if (!updateRes || updateRes.rowCount === 0) {
      throw new AppError(
        409,
        'INVALID_STATE',
        'Deduction line cannot transition from its current status'
      );
    }

    const updatedLine = updateRes.rows[0];

    // Record event
    await recordEventFn(client, {
      tenancyId: row.tenancy_id,
      actorType: 'tenant',
      actorLabel: row.user_name || 'Tenant',
      type: action === 'accept' ? 'deduction_accepted' : 'deduction_disputed',
      payload: {
        lineId: updatedLine.id,
        note: updatedLine.tenant_note || null,
      },
    });

    await client.query('COMMIT');
    return formatDeductionLine(updatedLine);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function withdrawDeduction(
  lineId,
  tenancyId,
  { name = null } = {},
  pool,
  recordEventFn = defaultRecordEvent
) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const lineRes = await client.query(
      `SELECT dl.id, dl.tenancy_id, dl.status, t.status AS tenancy_status
       FROM deduction_lines dl
       JOIN tenancies t ON t.id = dl.tenancy_id
       WHERE dl.id = $1 AND dl.tenancy_id = $2
       FOR UPDATE OF t, dl`,
      [lineId, tenancyId]
    );

    if (lineRes.rowCount === 0) {
      throw new AppError(404, 'NOT_FOUND', 'Deduction line not found');
    }

    const row = lineRes.rows[0];

    if (row.tenancy_status === 'closed') {
      throw new AppError(
        409,
        'TENANCY_CLOSED',
        'Tenancy is closed and deductions cannot be withdrawn'
      );
    }

    if (row.tenancy_status !== 'settling') {
      throw new AppError(
        409,
        'INVALID_STATE',
        'Tenancy must be in settling status to withdraw deductions'
      );
    }

    const updateRes = await client.query(
      `UPDATE deduction_lines
       SET status = 'withdrawn', updated_at = now()
       WHERE id = $1 AND status IN ('proposed', 'disputed')
       RETURNING *`,
      [lineId]
    );

    if (updateRes.rowCount === 0) {
      throw new AppError(
        409,
        'INVALID_STATE',
        'Deduction line cannot be withdrawn from its current status'
      );
    }

    const updatedLine = updateRes.rows[0];

    // Record event
    await recordEventFn(client, {
      tenancyId,
      actorType: 'landlord',
      actorLabel: name || 'Landlord',
      type: 'deduction_withdrawn',
      payload: {
        lineId: updatedLine.id,
      },
    });

    await client.query('COMMIT');
    return formatDeductionLine(updatedLine);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function getSettlementData(tenancyId, pool) {
  // Tenancy
  const tenancyRes = await pool.query(
    `SELECT id, property_label, address, landlord_name, deposit_paise, refund_window_days, status, created_at, updated_at
     FROM tenancies
     WHERE id = $1`,
    [tenancyId]
  );

  if (tenancyRes.rowCount === 0) {
    throw new AppError(404, 'NOT_FOUND', 'Tenancy not found');
  }

  const tenancy = tenancyRes.rows[0];

  // Fetch move_in and move_out inspections
  const inspRes = await pool.query(
    `SELECT id, type, status, submitted_at, acknowledged_at, created_at
     FROM inspections
     WHERE tenancy_id = $1`,
    [tenancyId]
  );

  const moveInInsp = inspRes.rows.find((i) => i.type === 'move_in');
  const moveOutInsp = inspRes.rows.find((i) => i.type === 'move_out');

  // Items and photos
  let moveInItems = [];
  let moveOutItems = [];

  if (moveInInsp) {
    const inItemsRes = await pool.query(
      `SELECT ii.id, ii.room, ii.name, ii.condition, ii.note,
              COALESCE(json_agg(json_build_object('id', m.id)) FILTER (WHERE m.id IS NOT NULL), '[]') as media
       FROM inspection_items ii
       LEFT JOIN media m ON m.item_id = ii.id
       WHERE ii.inspection_id = $1
       GROUP BY ii.id`,
      [moveInInsp.id]
    );
    moveInItems = inItemsRes.rows;
  }

  if (moveOutInsp) {
    const outItemsRes = await pool.query(
      `SELECT ii.id, ii.room, ii.name, ii.condition, ii.note,
              COALESCE(json_agg(json_build_object('id', m.id)) FILTER (WHERE m.id IS NOT NULL), '[]') as media
       FROM inspection_items ii
       LEFT JOIN media m ON m.item_id = ii.id
       WHERE ii.inspection_id = $1
       GROUP BY ii.id`,
      [moveOutInsp.id]
    );
    moveOutItems = outItemsRes.rows;
  }

  // Pure comparison for linked changes
  const compResult = compareInspections(moveInItems, moveOutItems);

  // Map comparison items by item_id (moveOut.id)
  const compByMoveOutId = new Map();
  for (const item of compResult.items) {
    if (item.moveOut?.id) {
      compByMoveOutId.set(item.moveOut.id, item);
    }
  }

  // Deduction lines
  const linesRes = await pool.query(
    `SELECT dl.*, ii.room AS item_room, ii.name AS item_name
     FROM deduction_lines dl
     LEFT JOIN inspection_items ii ON ii.id = dl.item_id
     WHERE dl.tenancy_id = $1
     ORDER BY dl.created_at ASC`,
    [tenancyId]
  );

  const lines = linesRes.rows.map((row) => {
    let linkedChange = 'not_linked';
    let photos = { moveIn: [], moveOut: [] };

    if (row.item_id) {
      const compItem = compByMoveOutId.get(row.item_id);
      if (compItem) {
        linkedChange = compItem.outcome;
        photos = {
          moveIn: (compItem.moveIn?.media || []).map((m) => m.id),
          moveOut: (compItem.moveOut?.media || []).map((m) => m.id),
        };
      }
    }

    return {
      ...formatDeductionLine(row),
      linkedChange,
      photos,
    };
  });

  const settlement = computeSettlement({
    depositPaise: tenancy.deposit_paise,
    lines,
    moveOutSubmittedAt: moveOutInsp?.submitted_at,
    refundWindowDays: tenancy.refund_window_days,
    now: new Date(),
  });

  // Prepare available move-out items for landlord selection
  const selectableMoveOutItems = moveOutItems.map((it) => {
    const compItem = compByMoveOutId.get(it.id);
    return {
      id: it.id,
      room: it.room,
      name: it.name,
      condition: it.condition,
      linkedChange: compItem ? compItem.outcome : 'not_linked',
    };
  });

  return {
    tenancy: {
      id: tenancy.id,
      propertyLabel: tenancy.property_label,
      address: tenancy.address,
      landlordName: tenancy.landlord_name,
      depositPaise: Number(tenancy.deposit_paise),
      refundWindowDays: tenancy.refund_window_days,
      status: tenancy.status,
      createdAt: tenancy.created_at,
      updatedAt: tenancy.updated_at,
    },
    settlement,
    lines,
    moveOutItems: selectableMoveOutItems,
  };
}

export async function closeTenancy(
  tenancyId,
  userId,
  { acknowledgeUnresolved = false } = {},
  pool,
  recordEventFn = defaultRecordEvent
) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const tenancyRes = await client.query(
      `SELECT t.id, t.status, t.deposit_paise, u.name AS user_name
       FROM tenancies t
       LEFT JOIN users u ON u.id = t.tenant_id
       WHERE t.id = $1 AND t.tenant_id = $2
       FOR UPDATE OF t`,
      [tenancyId, userId]
    );

    if (tenancyRes.rowCount === 0) {
      throw new AppError(404, 'NOT_FOUND', 'Tenancy not found');
    }

    const tenancy = tenancyRes.rows[0];

    if (tenancy.status === 'closed') {
      throw new AppError(409, 'INVALID_STATE', 'Tenancy is already closed');
    }

    if (tenancy.status !== 'settling') {
      throw new AppError(
        409,
        'INVALID_STATE',
        'Tenancy must be in settling status to close'
      );
    }

    // Query deduction lines
    const linesRes = await client.query(
      `SELECT status, amount_paise FROM deduction_lines WHERE tenancy_id = $1`,
      [tenancyId]
    );

    const lines = linesRes.rows;
    const proposed = lines.filter((l) => l.status === 'proposed').length;
    const disputed = lines.filter((l) => l.status === 'disputed').length;
    const unresolved = proposed + disputed;

    if (unresolved > 0 && !acknowledgeUnresolved) {
      throw new AppError(
        422,
        'UNRESOLVED_DEDUCTIONS',
        'Tenancy has unresolved deductions',
        {
          unresolved,
          proposed,
          disputed,
        }
      );
    }

    const settlement = computeSettlement({
      depositPaise: tenancy.deposit_paise,
      lines,
    });

    // Update status to closed
    await client.query(
      `UPDATE tenancies
       SET status = 'closed', updated_at = now()
       WHERE id = $1`,
      [tenancyId]
    );

    // Record event tenancy_closed
    await recordEventFn(client, {
      tenancyId,
      actorType: 'tenant',
      actorLabel: tenancy.user_name || 'Tenant',
      type: 'tenancy_closed',
      payload: {
        acceptedPaise: settlement.acceptedPaise,
        proposedPaise: settlement.proposedPaise,
        disputedPaise: settlement.disputedPaise,
        unclaimedPaise: settlement.unclaimedPaise,
        unresolvedAcknowledged: Boolean(acknowledgeUnresolved),
      },
    });

    await client.query('COMMIT');
    return {
      status: 'closed',
      settlement,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
